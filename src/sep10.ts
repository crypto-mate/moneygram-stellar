import type { AxiosInstance } from "axios";
import { TransactionBuilder, WebAuth, type Transaction } from "@stellar/stellar-sdk";
import type { AccountKeypair, WalletSigner } from "@stellar/typescript-wallet-sdk";

import { MoneyGramError } from "./errors.js";

/**
 * SEP-10, with a memo and a client domain in the same challenge.
 *
 * Both are needed at once, and that is the reason this module exists. MoneyGram's non-custodial
 * model allowlists a domain rather than an account, so every challenge carries `client_domain`
 * and is co-signed by the key that domain publishes. Holding funds for more than one customer on
 * a single account means every challenge also carries a `memo`, which is what gives each customer
 * their own KYC record at the anchor: SEP-10 puts it in the token's subject as `G...:memo`.
 *
 * The two answer different questions — which wallet software is asking, and which of its
 * customers — and SEP-10 does not tie them together. MoneyGram accepts both, and has done in
 * production since September 2026.
 *
 * The one security-sensitive step, checking that the anchor really signed the challenge it sent,
 * is delegated to {@link WebAuth.readChallengeTx} rather than written here.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
 */

export interface Sep10Params {
  /** `WEB_AUTH_ENDPOINT` from the anchor's stellar.toml. */
  webAuthEndpoint: string;
  /** `SIGNING_KEY` from the anchor's stellar.toml. The challenge is verified against it. */
  serverSigningKey: string;
  /** The anchor's domain, which the challenge must be scoped to. */
  homeDomain: string;
  networkPassphrase: string;
  /** The account being authenticated. */
  accountKp: AccountKeypair;
  /** Which customer, when the account holds funds for several. */
  memoId?: string;
  /** The domain publishing the `SIGNING_KEY` that co-signs the challenge. */
  clientDomain?: string;
  walletSigner: WalletSigner;
  httpClient: AxiosInstance;
}

export interface AuthenticationResult {
  /** The JWT to send as `Authorization: Bearer`. */
  token: string;
  /** The `exp` claim, in seconds since the epoch. */
  expiresAt: number;
  /** The `sub` claim: `G...`, or `G...:memo` when a memo was sent. */
  subject: string;
}

export async function authenticate(params: Sep10Params): Promise<AuthenticationResult> {
  const challenge = await requestChallenge(params);
  const signed = await signChallenge(challenge, params);
  return readToken(await exchangeForToken(signed, params));
}

interface Challenge {
  transaction: string;
  network_passphrase?: string;
}

async function requestChallenge(params: Sep10Params): Promise<Challenge> {
  const { webAuthEndpoint, accountKp, memoId, clientDomain, homeDomain, httpClient } = params;

  if (memoId !== undefined && !isPositiveInteger(memoId)) {
    throw new MoneyGramError(
      "authentication_failed",
      `A SEP-10 memo must be a positive integer, and ${memoId} is not`,
    );
  }

  // Built rather than concatenated: a home domain or a client domain is a URL component, and
  // the one place an anchor's own value lands in our request is not where to find out that it
  // needed escaping.
  const query = new URLSearchParams({ account: accountKp.publicKey, home_domain: homeDomain });
  if (memoId !== undefined) {
    query.set("memo", memoId);
  }
  if (clientDomain) {
    query.set("client_domain", clientDomain);
  }

  const response = await httpClient.get(`${webAuthEndpoint}?${query}`);
  const challenge = response.data as Challenge;

  if (!challenge?.transaction) {
    throw new MoneyGramError("authentication_failed", "The anchor returned no challenge");
  }
  return challenge;
}

async function signChallenge(challenge: Challenge, params: Sep10Params): Promise<Transaction> {
  const { networkPassphrase, serverSigningKey, homeDomain, webAuthEndpoint } = params;

  if (challenge.network_passphrase && challenge.network_passphrase !== networkPassphrase) {
    throw new MoneyGramError(
      "challenge_rejected",
      `The challenge is for ${challenge.network_passphrase}, not ${networkPassphrase}`,
    );
  }

  // The security of the whole handshake sits in this call: it checks the anchor really signed
  // the challenge with the key it publishes, that the challenge is scoped to this anchor and
  // this endpoint, that it cannot be submitted to the network, and that it has not expired.
  try {
    WebAuth.readChallengeTx(
      challenge.transaction,
      serverSigningKey,
      networkPassphrase,
      homeDomain,
      new URL(webAuthEndpoint).hostname,
    );
  } catch (cause) {
    throw new MoneyGramError("challenge_rejected", "The anchor's challenge did not verify", {
      cause,
    });
  }

  let transaction = TransactionBuilder.fromXdr(
    challenge.transaction,
    networkPassphrase,
  ) as Transaction;

  if (asksForClientDomain(transaction)) {
    transaction = await coSignForClientDomain(transaction, challenge.transaction, params);
  }

  params.walletSigner.signWithClientAccount({ transaction, accountKp: params.accountKp });
  return transaction;
}

function asksForClientDomain(transaction: Transaction): boolean {
  return transaction.operations.some(
    (operation) => operation.type === "manageData" && operation.name === "client_domain",
  );
}

async function coSignForClientDomain(
  transaction: Transaction,
  transactionXDR: string,
  { walletSigner, networkPassphrase, accountKp }: Sep10Params,
): Promise<Transaction> {
  const before = transaction.hash();

  const returned = await walletSigner.signWithDomainAccount({
    transactionXDR,
    networkPassphrase,
    accountKp,
  });

  // A signing service is entitled to refuse, not to rewrite. `hash()` covers the envelope but
  // not the signatures, so appending one leaves it alone and touching the operations, the source
  // account or the memo does not.
  if (!Buffer.from(returned.hash()).equals(Buffer.from(before))) {
    throw new MoneyGramError(
      "challenge_rejected",
      "The client-domain signer changed the challenge instead of only signing it",
    );
  }
  return returned;
}

async function exchangeForToken(signed: Transaction, params: Sep10Params): Promise<string> {
  const response = await params.httpClient.post(params.webAuthEndpoint, {
    transaction: signed.toXdr(),
  });

  const token = (response.data as { token?: string })?.token;
  if (!token) {
    throw new MoneyGramError("authentication_failed", "The anchor returned no token");
  }
  return token;
}

/**
 * Reads the claims this package needs out of the JWT.
 *
 * The signature is not checked, and does not need to be: the token is a bearer credential handed
 * straight back to the party that issued it, over a connection already authenticated by TLS.
 * What matters is that `exp` and `sub` say what we think they say.
 */
export function readToken(token: string): AuthenticationResult {
  const claims = decodeClaims(token);
  const expiresAt = Number(claims.exp);
  const subject = typeof claims.sub === "string" ? claims.sub : "";

  if (!Number.isFinite(expiresAt) || !subject) {
    throw new MoneyGramError(
      "authentication_failed",
      "The anchor's token carries no usable exp and sub",
    );
  }

  return { token, expiresAt, subject };
}

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new MoneyGramError("authentication_failed", "The anchor's token is not a JWT");
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch (cause) {
    throw new MoneyGramError("authentication_failed", "The anchor's token could not be read", {
      cause,
    });
  }
}

function isPositiveInteger(value: string): boolean {
  return /^\d+$/.test(value);
}
