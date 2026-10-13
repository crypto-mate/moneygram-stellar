import type { Types } from "@stellar/typescript-wallet-sdk";

import { TransferWindowExpiredError } from "./errors.js";
import type { Customer } from "./sep9.js";

import { TransactionStatus } from "./wallet-sdk.js";

/**
 * A SEP-24 transaction as MoneyGram returns it.
 *
 * Two of these fields are not in SEP-24 and are not modelled by the official SDK, yet they are
 * where the two deadlines that matter come from:
 *
 *  - `user_action_required_by` — see {@link deadlineFor}.
 *  - `refunded` — the older SEP-24 spelling, which MoneyGram still sends alongside `refunds`.
 *
 * Every other field is optional because which ones are populated depends on `status`, and because
 * a failed transaction comes back with almost nothing in it.
 */
export type MoneyGramTransaction = Partial<
  Types.DepositTransaction & Types.WithdrawTransaction
> & {
  id: string;
  status: Types.TransactionStatus;
  user_action_required_by?: string;
  refunded?: boolean;
};

export interface StartParams {
  /**
   * The amount, as a decimal string.
   *
   * MoneyGram only requires it of custodial wallets, but sending it costs nothing and saves the
   * customer typing it into the hosted screen.
   */
  amount: string;
  /** Prefill for the hosted screens. Anything missing is just a box the customer fills in. */
  customer?: Customer;
}

/** What MoneyGram hands back when a flow is opened: a screen to show, and an id to poll. */
export interface StartedFlow {
  /**
   * The anchor's transaction id — **the only stable identifier there is.** Persist it before you
   * show the customer anything: without it you cannot ask about the transaction again, and
   * MoneyGram does not offer a way to look it up by anything else that works (see
   * {@link settles}).
   */
  id: string;
  /** The MoneyGram-hosted screen. KYC, the location pick and the confirmation all happen there. */
  url: string;
}

/** Where the USDC has to go, as the anchor dictates it, once a cash-out reaches that stage. */
export interface TransferInstruction {
  destination: string;
  /**
   * The memo the payment must carry.
   *
   * ⚠️ Not the SEP-10 memo. That one says who is authenticating; this one is how the anchor
   * recognises the payment. Sending this as a text memo when `memoType` says `id` is a payment
   * MoneyGram will not credit.
   */
  memo: string;
  memoType: string;
  /** What to send. Not what the customer asked for: the anchor has taken its fee out. */
  amount: string;
  /** When the anchor stops waiting. Past this, the payment is lost rather than late. */
  expiresAt?: Date;
}

/**
 * The deadline the anchor is currently holding you to, which is the same field meaning two
 * different things depending on where the transaction is:
 *
 *  - at `pending_user_transfer_start`, it is the window to send the USDC — about 30 minutes;
 *  - at `pending_user_transfer_complete`, it is how long the cash stays collectable at an
 *    agent — 60 days when we measured it, which is not the 90 days MoneyGram's consumer terms
 *    talk about.
 *
 * Read the field, never a constant. The numbers above are what we saw, not a promise.
 */
export function deadlineFor(transaction: MoneyGramTransaction): Date | undefined {
  const raw = transaction.user_action_required_by;
  if (!raw) {
    return undefined;
  }
  const deadline = new Date(raw);
  return Number.isNaN(deadline.getTime()) ? undefined : deadline;
}

/**
 * The transfer instruction for a cash-out, or `undefined` while the anchor has not issued one yet.
 *
 * Throws once the window has closed, rather than handing back instructions that would lose the
 * payment. A caller that wants to look at an expired transaction should read its fields directly.
 */
export function transferInstruction(
  transaction: MoneyGramTransaction,
  now: Date = new Date(),
): TransferInstruction | undefined {
  if (transaction.status !== TransactionStatus.pending_user_transfer_start) {
    return undefined;
  }

  const {
    withdraw_anchor_account: destination,
    withdraw_memo: memo,
    withdraw_memo_type: memoType,
    amount_in: amount,
  } = transaction;

  // Anything missing means the anchor has not finished issuing the instruction. Filling a gap
  // with a guess here would be a guess about where money goes.
  if (!destination || !memo || !memoType || !amount) {
    return undefined;
  }

  const expiresAt = deadlineFor(transaction);
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    throw new TransferWindowExpiredError(transaction.id, expiresAt);
  }

  return {
    destination,
    memo,
    memoType,
    amount,
    expiresAt,
  };
}

/**
 * Whether a payment that arrived on your account is the one that settles this cash-in.
 *
 * This exists because the obvious way to answer it does not work. SEP-24 offers, and the official
 * SDK exposes, a lookup by `stellar_transaction_id` — and MoneyGram answers that call with a web
 * page. Measured against a hash the anchor itself reports in the transaction, with and without the
 * SEP-10 memo: three calls, three failures.
 *
 * So the question is asked the other way round: fetch the transaction by its id and compare. The
 * three answers are kept apart because they want different handling, and the middle one is the
 * surprising one — MoneyGram can credit a deposit and leave its own record saying nothing about it.
 */
export type Settlement =
  | { kind: "settles" }
  /**
   * The anchor has not named a payment for this transaction. Seen repeatedly: still
   * `pending_user_transfer_start` with no `stellar_transaction_id` long after the USDC had
   * arrived. The deposit is real and the transaction stays open, so the two have to be
   * reconciled by something other than this answer.
   */
  | { kind: "anchor-has-not-recorded-its-payment"; status: Types.TransactionStatus }
  /** The anchor settled this transaction with a different payment, so yours is an ordinary deposit. */
  | { kind: "another-payment"; settledBy: string };

export function settles(
  transaction: MoneyGramTransaction,
  stellarTransactionId: string,
): Settlement {
  const recorded = transaction.stellar_transaction_id;

  if (!recorded) {
    return { kind: "anchor-has-not-recorded-its-payment", status: transaction.status };
  }
  if (recorded !== stellarTransactionId) {
    return { kind: "another-payment", settledBy: recorded };
  }
  return { kind: "settles" };
}

/**
 * True once MoneyGram has given the money back.
 *
 * Both spellings are checked: the status is what SEP-24 says to read, and `refunded` is the older
 * flag MoneyGram still sends. A refund can also be partial, in which case the status stays put and
 * only `refunds` moves — so a caller that cares about amounts reads `refunds`, not this.
 */
export function isRefunded(transaction: MoneyGramTransaction): boolean {
  return transaction.status === TransactionStatus.refunded || transaction.refunded === true;
}

/**
 * Where the customer cancels a cash-out and gets their money back.
 *
 * There is no refund endpoint. MoneyGram puts "Cancel transfer" on the transaction's own hosted
 * page, so the only thing to hand over is that URL. What comes back lands on the account that
 * paid — which, on a pooled account, is not the customer's wallet. Attributing it is yours.
 */
export function refundUrl(transaction: MoneyGramTransaction): string | undefined {
  return transaction.more_info_url;
}
