# What was verified, and what was not

This package encodes behaviour that is not in MoneyGram's documentation or in SEP-24. That is its
whole value, so it comes with its working.

Everything below was observed against **MoneyGram's Stellar sandbox**
(`extmgxanchor.moneygram.com`, Stellar testnet) between **15 September and 8 October 2026**, by
running real cash-outs, refunds, deliberate failures and cash-ins through it and reading both the
anchor's responses and the ledger.

The integration these findings come from has been live in production since September 2026. The
measurements below are from the sandbox, because that is where a transaction can be taken
deliberately to each of its failures; the production anchor is a different host and was not
measured.

An anchor is free to change. Nothing here is a promise about tomorrow; it is a record of a day.

## Observed

### The handshake

**A SEP-10 challenge may carry a `memo` and a `client_domain` at the same time.** The anchor
issues the challenge, accepts the signed result and returns a token whose `sub` is
`G<account>:<memo>`. SEP-10 describes exactly this subject format; nothing in the spec ties the
two parameters together.

**Separate customers on one account get separate KYC.** Two sessions on a single Stellar account,
differing only in their SEP-10 memo, were each taken through MoneyGram's hosted screens. The
anchor asked each one for identity documents independently and accepted different document types
and different addresses for each. Neither inherited anything from the other.

**A token outlives a single call and is reused.** One token minted in the evening was still
accepted by the anchor roughly twenty hours later.

### The cash-out

**`withdraw_memo_type` comes back as `id`.** The payment has to carry a numeric memo of that
type. A text memo with the same digits is not credited.

**The transfer window is about 30 minutes**, and the anchor states it in
`user_action_required_by` rather than leaving you to assume it. One transaction was deliberately
left unpaid and moved to an expired state at the deadline, with no later credit.

**`completed` means the cash is collectable, not collected.** At
`pending_user_transfer_complete` the anchor issues `external_transaction_id`, the reference
number a customer quotes at an agent. The transaction reads as finished while the money is still
sitting there.

**The collection window is reported as 60 days.** The same `user_action_required_by` field, read
at `pending_user_transfer_complete`, was 60 days out on both occasions it was checked.
MoneyGram's consumer-facing terms describe 90 days. The two disagree; this package reads the
field and takes no position on which is right.

**One open transaction per Stellar account, not per SEP-10 subject.** With two customers sharing
one account, a second cash-out was refused while the first was still in flight. The memo
separates identity, not concurrency.

**Refunds happen on the anchor's own page.** There is no refund endpoint. "Cancel transfer" lives
on the transaction's `more_info_url`. A refund was taken end to end: the transaction reported
itself refunded and the funds returned **to the account that paid**, which on a pooled account is
not the customer's wallet.

### The failures

**Looking a transaction up by its Stellar hash returns a web page, not data.** Three attempts,
three failures — including with a hash the anchor itself reported on the transaction, and both
with and without the SEP-10 memo on the session. The status is not an error status. This package
therefore does not expose that lookup at all, and reconciles by id instead.

**A spent token also returns a web page**, not `401`. The shape of the response is the only
signal there is, which is why this package inspects it.

**The anchor rejects an amount below its minimum** by moving the transaction to `too_small`
rather than by failing the call that opened it.

## Not verified

Said plainly, because a reference implementation that overstates itself is worse than none.

**No cash-in has completed end to end.** MoneyGram's sandbox did not fund the simulated cash
payment on any attempt: transactions stayed at `pending_user_transfer_start` with an empty
`stellar_transaction_id`, in one case long after the anchor had reported the deposit as complete
on its side. The deposit path in this package — `startDeposit`, `waitForDeposit` and the
`settles` reconciliation — is exercised only by the contract tests against the stand-in anchor
in `test/`. Its shape is drawn from what the anchor returned, not from a successful run.

That failure is also the reason the Horizon watcher exists, and it is the single most useful
thing in this file: **do not assume the anchor will name the payment it sent you.**

**`too_large` was never triggered.** The test account never held enough to reach the maximum.

**Muxed accounts (`M...`) were not tried.** SEP-10 allows a muxed address instead of a memo, and
it would give the same separation. Whether MoneyGram accepts one is unknown.

**Production was not measured.** Everything above is the sandbox. The production anchor is a
different host and may differ.

## Re-checking this

The behaviour above is pinned by tests in two layers. `npm test` runs both.

- The pure logic — the deadlines, the reconciliation, the SEP-9 mapping, the payment matching —
  is covered by unit tests that need no network.
- The parts that only exist over HTTP — the handshake carrying both parameters, the web page
  served instead of data, the re-authentication that follows — run against the stand-in anchor
  in `test/fake-anchor.ts`, which issues genuinely signed SEP-10 challenges.

Neither layer talks to MoneyGram. Confirming that the real anchor still behaves this way needs
sandbox access, which MoneyGram grants; there is no self-serve path.
