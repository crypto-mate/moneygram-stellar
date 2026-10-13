# @cryptomate/moneygram-stellar

A reference client for MoneyGram cash-in and cash-out on Stellar, in TypeScript.

> **Unofficial.** Not published, endorsed or supported by MoneyGram or by the Stellar Development
> Foundation. It is a reference implementation of an integration that has been live in production
> since September 2026, and every claim it makes about the anchor's behaviour was measured against
> MoneyGram's sandbox on the dates recorded in [`VERIFIED.md`](./VERIFIED.md). It is not a
> maintained product.

It builds on [`@stellar/typescript-wallet-sdk`](https://github.com/stellar/typescript-wallet-sdk)
rather than replacing it: SEP-24, the anchor's TOML, the transaction watcher and the Horizon
client all come from there. What this package adds is the MoneyGram layer around them.

- **SEP-10 with a memo and a `client_domain` in the same challenge.** Not a memo on its own —
  both together, which is what a wallet that holds funds for several customers on one Stellar
  account needs: the domain says which wallet is asking, the memo says which of its customers.
  MoneyGram keeps a separate KYC record per memo.
- **SEP-9 prefill** from a customer record, including the three details that are easy to get
  wrong and silent when you do.
- **A Horizon watcher** that ties an incoming payment to the cash-in it settles, because the
  anchor's own record cannot be relied on to name it.
- **Refund detection**, and the deadline arithmetic around both of MoneyGram's windows.
- **Guard rails** for the ways this anchor surprises you, each one pinned by a test.

## Install

```sh
npm install @cryptomate/moneygram-stellar
```

Node 22.12 or newer.

## Opening a session

This package never holds, reads or asks for a private key. You give it something that signs.

```ts
import { MoneyGram, MONEYGRAM_SANDBOX, PublicKeypair, type WalletSigner } from "@cryptomate/moneygram-stellar";

const walletSigner: WalletSigner = {
  signWithClientAccount({ transaction, accountKp }) {
    // Your key, your HSM, your MPC. Returns the signed transaction.
    return signLocally(transaction, accountKp);
  },
  async signWithDomainAccount({ transactionXDR, networkPassphrase }) {
    // The key published as SIGNING_KEY in your own stellar.toml. The SDK's `DomainSigner`
    // does this over HTTP if your signing service exposes one.
    return coSign(transactionXDR, networkPassphrase);
  },
};

const moneyGram = MoneyGram.open({
  anchor: MONEYGRAM_SANDBOX, // omit for production
  clientDomain: "wallet.example",
  walletSigner,
});
```

Then authenticate as the account, and — when that account carries more than one customer — as
one of them:

```ts
const session = await moneyGram.authenticate({
  accountKp: PublicKeypair.fromPublicKey(holdingAccount),
  memoId: "2938417465", // leave out for an account that is one customer
});
```

The token's subject comes back as `G...:2938417465`. Two customers on the same account get two
subjects, and MoneyGram treats them as two people: separate KYC, separate documents, separate
addresses.

## Cash-out

The customer sends USDC and collects cash at an agent.

```ts
import { transferInstruction, isRefunded, refundUrl } from "@cryptomate/moneygram-stellar";

const cashOut = await session.startWithdraw({ amount: "100.00", customer });

// Persist cashOut.id before you show the customer anything: it is the only stable
// identifier, and there is no working way to find a transaction without it.
show(cashOut.url);

const transaction = await session.getTransaction(cashOut.id);
const instruction = transferInstruction(transaction);

if (instruction) {
  // You send the payment. This package tells you where it goes and by when.
  await pay({
    to: instruction.destination,
    memo: instruction.memo, // memoType is "id": a text memo is not credited
    amount: instruction.amount, // net of the anchor's fee, not what the customer asked for
    before: instruction.expiresAt,
  });
}
```

`transferInstruction` throws `TransferWindowExpiredError` once the window has closed, rather than
handing you instructions that would lose the payment.

To offer a refund, send the customer to `refundUrl(transaction)` — MoneyGram puts "Cancel
transfer" on the transaction's own page — and watch for `isRefunded(transaction)`.

## Cash-in

The customer pays cash at an agent and USDC arrives.

```ts
const session = await moneyGram.authenticate({
  accountKp: PublicKeypair.fromPublicKey(customerWallet),
});

const cashIn = await session.startDeposit({ amount: "100.00", customer });
show(cashIn.url);

const transaction = await session.getTransaction(cashIn.id);
const payment = await session.waitForDeposit({ memo: transaction.deposit_memo! });

payment.hash; // the Stellar transaction that carried it
```

`waitForDeposit` matches on the memo **and** on the asset's issuer, which it reads from the
anchor's own `stellar.toml`. Matching an asset by code alone is not safe: anyone can issue
something called USDC and pay you with it, carrying any memo they like.

## What it does not do

By design, so that it fits a non-custodial wallet and a pooled treasury equally:

- **No keys.** It takes a signer.
- **No payments.** It hands you the instruction; sending is yours.
- **No state.** No database, no migrations. You persist the anchor's transaction id.
- **No fees and no accounting.** Those belong to your business, not to a protocol client.
- **No server.** It is a library.

## Things that will surprise you

Each of these is measured, and each has a test with its name on it. The reasoning lives in the
code comments; the evidence lives in [`VERIFIED.md`](./VERIFIED.md).

- Looking a transaction up by its Stellar hash does not work, so this package does not offer it.
  Use `settles(transaction, hash)` instead: fetch by id and compare.
- An API call can come back as a web page rather than as data, and not as an error status. A
  session re-authenticates once on its own and reports it honestly if that does not help.
- `completed` on a cash-out means the cash is waiting at an agent, not that anyone took it.
- The two deadlines are the same field, `user_action_required_by`, meaning different things at
  different stages. Read the field; never hardcode either number.
- One open transaction per Stellar account — per account, not per customer. Serialise.
- On a cash-in, the anchor's own record may never name the payment it sent you. That is what the
  Horizon watcher is for.

## Tests

```sh
npm test       # unit tests, plus contract tests against a local stand-in anchor
npm run check  # type-check everything: the package, the tests and the example
npm run smoke  # load the built package on plain Node
```

The contract tests run a real SEP-10 handshake — a genuinely signed challenge, verified the same
way a real one is — against a fake anchor that can also be told to misbehave in the ways the real
one does.

`smoke` is not ceremony. A test runner resolves modules its own way, so a suite can be entirely
green while the published package fails to load for the first person who installs it. Loading the
build on plain Node is the only thing that rules that out.

## License

MIT. See [`LICENSE`](./LICENSE).
