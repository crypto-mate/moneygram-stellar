import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { PublicKeypair, type WalletSigner } from "@stellar/typescript-wallet-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AnchorReturnedHtmlError,
  MoneyGram,
  settles,
  type AnchorDescriptor,
  type MoneyGramTransaction,
} from "../src/index.js";
import { startFakeAnchor, type FakeAnchor } from "./fake-anchor.js";

const CLIENT_DOMAIN = "wallet.example";

/** One customer's id, hashed down to the positive integer SEP-10 wants in a memo. */
const RAIN = "2938417465";
const RIVER = "8812094471";

let anchor: FakeAnchor;
let holding: Keypair;
let domainKey: Keypair;

beforeEach(async () => {
  anchor = await startFakeAnchor();
  holding = Keypair.random();
  domainKey = Keypair.random();
});

afterEach(async () => {
  await anchor.stop();
});

function descriptorFor(fake: FakeAnchor): AnchorDescriptor {
  return {
    url: `http://${fake.homeDomain}`,
    homeDomain: fake.homeDomain,
    network: "TESTNET",
    assetCode: "USDC",
  };
}

/** Stands in for a wallet that holds the account key and a service that holds the domain key. */
function signerFor(account: Keypair, domain: Keypair): WalletSigner {
  return {
    signWithClientAccount({ transaction }) {
      transaction.sign(account);
      return transaction;
    },
    async signWithDomainAccount({ transactionXDR, networkPassphrase }) {
      const transaction = TransactionBuilder.fromXdr(
        transactionXDR,
        networkPassphrase,
      ) as Transaction;
      transaction.sign(domain);
      return transaction;
    },
  };
}

function moneyGram() {
  return MoneyGram.open({
    anchor: descriptorFor(anchor),
    clientDomain: CLIENT_DOMAIN,
    walletSigner: signerFor(holding, domainKey),
    allowHttp: true,
  });
}

function sessionFor(memoId?: string) {
  return moneyGram().authenticate({
    accountKp: PublicKeypair.fromPublicKey(holding.publicKey()),
    memoId,
  });
}

function challenges() {
  return anchor.requests.filter((request) => request.path === "/auth" && request.method === "GET");
}

describe("SEP-10 against a live anchor", () => {
  it("sends the memo and the client domain together", async () => {
    // A pooled account authenticating as one of its customers needs both in one challenge: the
    // domain says which wallet is asking, the memo says which of its customers.
    await sessionFor(RAIN);

    expect(challenges()).toHaveLength(1);
    expect(challenges()[0]?.query).toMatchObject({
      account: holding.publicKey(),
      memo: RAIN,
      client_domain: CLIENT_DOMAIN,
      home_domain: anchor.homeDomain,
    });
  });

  it("comes back as the customer, not as the account", async () => {
    const session = await sessionFor(RAIN);
    const token = await session.token();

    expect(token.account).toBe(holding.publicKey());
    expect(token.memo).toBe(RAIN);
  });

  it("gives two customers on one account two identities", async () => {
    const rain = await (await sessionFor(RAIN)).token();
    const river = await (await sessionFor(RIVER)).token();

    expect(rain.account).toBe(river.account);
    expect(rain.memo).not.toBe(river.memo);
  });

  it("leaves the memo out for an account that is one customer", async () => {
    const session = await sessionFor();

    expect(challenges()[0]?.query).not.toHaveProperty("memo");
    expect((await session.token()).memo).toBeNull();
  });

  it("refuses a memo that is not a positive integer", async () => {
    await expect(sessionFor("rain")).rejects.toThrow(/positive integer/);
  });

  it("keeps the token instead of handshaking again on every call", async () => {
    const session = await sessionFor(RAIN);
    anchor.transactions.set("tx-1", { id: "tx-1", status: "completed" });

    await session.getTransaction("tx-1");
    await session.getTransaction("tx-1");

    expect(challenges()).toHaveLength(1);
  });
});

describe("when the anchor answers with a web page", () => {
  it("authenticates again and carries on", async () => {
    const session = await sessionFor(RAIN);
    anchor.transactions.set("tx-1", { id: "tx-1", status: "completed" });
    anchor.serveHtml(1);

    const transaction = await session.getTransaction("tx-1");

    expect(transaction.id).toBe("tx-1");
    expect(challenges()).toHaveLength(2);
  });

  it("reports what actually happened when a new token does not help", async () => {
    const session = await sessionFor(RAIN);
    anchor.transactions.set("tx-1", { id: "tx-1", status: "completed" });
    anchor.serveHtml(5);

    // Without this the caller gets a generic request failure wrapped around a stringified web
    // page, with no way to tell a spent token from a call the anchor does not serve.
    await expect(session.getTransaction("tx-1")).rejects.toBeInstanceOf(AnchorReturnedHtmlError);
    expect(challenges()).toHaveLength(2);
  });
});

describe("opening a flow", () => {
  it("sends the amount and the prefill the customer will not have to type", async () => {
    const session = await sessionFor(RAIN);

    const flow = await session.startWithdraw({
      amount: "100.00",
      customer: {
        firstName: "Ada",
        lastName: "Lovelace",
        phoneCountryCode: "44",
        phoneNumber: "2079460000",
        address: { city: "London", countryCode: "GBR" },
      },
    });

    expect(flow).toEqual({ id: "tx-1", url: "https://example/ui" });

    const opened = anchor.requests.find((request) => request.path.endsWith("/interactive"));
    expect(opened?.body).toMatchObject({
      asset_code: "USDC",
      account: holding.publicKey(),
      amount: "100.00",
      first_name: "Ada",
      last_name: "Lovelace",
      mobile_number: "+442079460000",
      city: "London",
      address_country_code: "GBR",
    });
    expect(opened?.body).not.toHaveProperty("state_or_province");
  });

  it("says so when the anchor opens nothing", async () => {
    const session = await sessionFor(RAIN);
    anchor.nextFlow = { type: "error", error: "amount too large" };

    await expect(session.startWithdraw({ amount: "999999.00" })).rejects.toThrow(
      /amount too large/,
    );
  });
});

describe("reconciling a cash-in", () => {
  const hash = "7a1f0c2d9b4e6a8c5f3d1b0e9a7c4f2d8b6a0e3c1f5d9b7a2e4c6f8a0b3d5e7c";

  it("matches the payment the anchor named", async () => {
    const session = await sessionFor();
    anchor.transactions.set("cash-in", {
      id: "cash-in",
      status: "completed",
      stellar_transaction_id: hash,
    });

    const transaction = await session.getTransaction("cash-in");

    expect(settles(transaction, hash)).toEqual({ kind: "settles" });
  });

  it("keeps the anchor's silence distinct from a mismatch", async () => {
    const session = await sessionFor();
    anchor.transactions.set("cash-in", {
      id: "cash-in",
      status: "pending_user_transfer_start",
    });

    // The shape MoneyGram's sandbox kept returning: funded on-chain, and its own record naming
    // no payment at all.
    const transaction: MoneyGramTransaction = await session.getTransaction("cash-in");

    expect(settles(transaction, hash)).toEqual({
      kind: "anchor-has-not-recorded-its-payment",
      status: "pending_user_transfer_start",
    });
  });
});
