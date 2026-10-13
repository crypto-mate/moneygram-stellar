import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Keypair, Networks, WebAuth } from "@stellar/stellar-sdk";

/**
 * A stand-in for MoneyGram's anchor, good enough to run a real SEP-10 handshake against.
 *
 * The challenge it issues is a genuine signed Stellar transaction, because the package verifies
 * it with the same function the official SDK uses — a stubbed challenge would prove nothing. What
 * is fake is everything after that: the token is signed with a throwaway secret and the SEP-24
 * transactions are whatever a test puts in.
 *
 * It can also be told to answer a web page instead of data, which is the behaviour this whole
 * package exists to survive.
 */

export interface AnchorRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

export interface FakeAnchor {
  /** What to hand to `MONEYGRAM_SANDBOX`-shaped config: `localhost:<port>`. */
  homeDomain: string;
  /** The `SIGNING_KEY` it publishes and signs challenges with. */
  signingKey: string;
  /** Every request it has served, in order. */
  requests: AnchorRequest[];
  /** SEP-24 transactions it knows, keyed by id. Tests put fixtures here. */
  transactions: Map<string, Record<string, unknown>>;
  /** What the next interactive call hands back. */
  nextFlow: { type: string; id?: string; url?: string; error?: string };
  /** Answer the next N SEP-24 calls with a web page, the way a spent token is reported. */
  serveHtml(times: number): void;
  stop(): Promise<void>;
}

const NETWORK = Networks.TESTNET;
const TOKEN_SECRET = "a-fake-anchor-signs-with-this";

/** Stands in for the asset issuer an anchor publishes in its toml. */
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export async function startFakeAnchor(): Promise<FakeAnchor> {
  const serverKeypair = Keypair.random();
  const requests: AnchorRequest[] = [];
  const transactions = new Map<string, Record<string, unknown>>();

  let htmlResponsesLeft = 0;
  let homeDomain = "";

  // One object, handed back by reference: a test that sets `nextFlow` has to be setting the
  // same field the handler reads.
  const anchor: FakeAnchor = {
    homeDomain: "",
    stop: () => closeServer(server),
    requests,
    transactions,
    nextFlow: { type: "interactive_customer_info_needed", id: "tx-1", url: "https://example/ui" },
    signingKey: serverKeypair.publicKey(),
    serveHtml(times: number) {
      htmlResponsesLeft = times;
    },
  };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      send(response, 500, "application/json", JSON.stringify({ error: String(error) }));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${homeDomain}`);
    const body = request.method === "POST" ? await readJson(request) : undefined;

    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    });

    if (url.pathname === "/.well-known/stellar.toml") {
      return send(response, 200, "text/plain", toml(homeDomain, serverKeypair.publicKey()));
    }

    // The web page only ever stands in for a SEP-24 answer: authenticating again is the cure
    // the package reaches for, so serving it there too would make the cure impossible.
    if (url.pathname.startsWith("/sep24/") && htmlResponsesLeft > 0) {
      htmlResponsesLeft -= 1;
      return send(response, 200, "text/html", "<!DOCTYPE html><html><body>Sign in</body></html>");
    }

    if (url.pathname === "/auth" && request.method === "GET") {
      return send(response, 200, "application/json", JSON.stringify(challengeFor(url)));
    }

    if (url.pathname === "/auth" && request.method === "POST") {
      return send(response, 200, "application/json", JSON.stringify(tokenFor(body)));
    }

    if (url.pathname === "/sep24/info") {
      return send(response, 200, "application/json", JSON.stringify(info()));
    }

    if (url.pathname.endsWith("/interactive") && request.method === "POST") {
      return send(response, 200, "application/json", JSON.stringify(anchor.nextFlow));
    }

    if (url.pathname === "/sep24/transaction") {
      const transaction = transactions.get(url.searchParams.get("id") ?? "");
      return transaction
        ? send(response, 200, "application/json", JSON.stringify({ transaction }))
        : send(response, 404, "application/json", JSON.stringify({ error: "not found" }));
    }

    send(response, 404, "application/json", JSON.stringify({ error: "no such endpoint" }));
  }

  function challengeFor(url: URL) {
    const account = url.searchParams.get("account") ?? "";
    const memo = url.searchParams.get("memo");
    const clientDomain = url.searchParams.get("client_domain");

    return {
      transaction: WebAuth.buildChallengeTx(
        serverKeypair,
        account,
        homeDomain,
        300,
        NETWORK,
        "localhost",
        memo,
        clientDomain,
        clientDomain ? Keypair.random().publicKey() : null,
      ),
      network_passphrase: NETWORK,
    };
  }

  function tokenFor(body: unknown) {
    const xdr = (body as { transaction?: string })?.transaction ?? "";
    const read = WebAuth.readChallengeTx(xdr, serverKeypair.publicKey(), NETWORK, homeDomain, "localhost");

    const subject = read.memo ? `${read.clientAccountID}:${read.memo}` : read.clientAccountID;
    const now = Math.floor(Date.now() / 1000);

    return { token: jwt({ iss: homeDomain, sub: subject, iat: now, exp: now + 900 }) };
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  homeDomain = `localhost:${(server.address() as AddressInfo).port}`;
  anchor.homeDomain = homeDomain;

  return anchor;
}

/**
 * [DOCUMENTATION] is here because the toml parser in the dependency chain expects the section,
 * even though SEP-1 only recommends it.
 *
 * [[CURRENCIES]] is how an anchor says who issues the asset it deals in, which is the only
 * authority on that question worth trusting.
 */
function toml(homeDomain: string, signingKey: string): string {
  return [
    'VERSION="2.0.0"',
    `NETWORK_PASSPHRASE="${NETWORK}"`,
    `WEB_AUTH_ENDPOINT="http://${homeDomain}/auth"`,
    `TRANSFER_SERVER_SEP0024="http://${homeDomain}/sep24"`,
    `SIGNING_KEY="${signingKey}"`,
    "",
    "[DOCUMENTATION]",
    'ORG_NAME="Fake Anchor"',
    "",
    "[[CURRENCIES]]",
    'code="USDC"',
    `issuer="${USDC_ISSUER}"`,
  ].join("\n");
}

function info() {
  const asset = { USDC: { enabled: true, min_amount: 1, max_amount: 2500 } };
  return { deposit: asset, withdraw: asset, fee: { enabled: false }, features: {} };
}

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  const signingInput = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  const signature = createHmac("sha256", TOKEN_SECRET).update(signingInput).digest("base64url");

  return `${signingInput}.${signature}`;
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { "content-type": type });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    // Axios keeps its sockets alive, and close() waits for every one of them.
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
