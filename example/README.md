# Running the example

`cash-out.ts` opens a cash-out against MoneyGram's sandbox, prints the hosted screen to complete,
then prints where to send the USDC and follows the transaction to the end.

## What you need before it will run

Two of these are not things a package can give you, and no amount of code will work around them.

**Sandbox access from MoneyGram.** The sandbox anchor is not open. MoneyGram grants access and
allowlists the domain you will authenticate from; there is no self-serve path. Without it the
handshake is refused.

**A domain that publishes a `SIGNING_KEY`.** MoneyGram's non-custodial model trusts a domain, not
an account. You need a `stellar.toml` at `https://<your-domain>/.well-known/stellar.toml`
containing the public key whose secret signs the challenge:

```toml
SIGNING_KEY="GABC...your domain key..."
```

MoneyGram fetches that file on every challenge and refuses the handshake if the second signature
does not match it.

**A funded testnet account** holding sandbox USDC, with a trustline to the issuer the anchor
publishes in its own `stellar.toml`.

## Environment

The example reads these and prints none of them.

| | |
| --- | --- |
| `MG_CLIENT_DOMAIN` | the domain publishing your `SIGNING_KEY`, e.g. `wallet.example` |
| `MG_DOMAIN_SECRET` | the `S...` secret for that key |
| `MG_ACCOUNT_SECRET` | the `S...` secret of the account that will pay |
| `MG_MEMO` | optional. A positive integer identifying one customer on a shared account. Leave it out and the account authenticates as itself. |
| `MG_AMOUNT` | optional, defaults to `10.00` |

Keep the two secrets out of your shell history and out of any file you commit.

## Run it

```sh
npm run build
node --experimental-strip-types example/cash-out.ts
```

The example imports the package by name, which works inside this repository because the package
declares an `exports` field — so the import line is the one you would write in your own project,
not a path into `src/`.

## What it will not do

It will not send the payment. It prints the destination, the memo, the amount and the deadline,
and waits for you. That is the same boundary the package itself keeps: it tells you where money
goes and never moves it.

Run it with `MG_MEMO` set to two different values on the same account to watch the thing this
package exists for — MoneyGram will take each one through KYC separately.
