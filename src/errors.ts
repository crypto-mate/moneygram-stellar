/**
 * Every error this package throws carries a `code`. Branch on the code rather than
 * on `instanceof`: a dependency tree can end up with two copies of this package,
 * and then `instanceof` is false for an error that is otherwise the right one.
 */
export type MoneyGramErrorCode =
  | "transfer_window_expired"
  | "anchor_returned_html"
  | "transaction_not_found"
  | "account_has_an_open_transaction"
  | "flow_not_opened"
  | "challenge_rejected"
  | "authentication_failed"
  | "asset_not_published";

export class MoneyGramError extends Error {
  readonly code: MoneyGramErrorCode;

  constructor(code: MoneyGramErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MoneyGramError";
    this.code = code;
  }
}

/**
 * The 30 minutes MoneyGram gives you to send the USDC have run out. Sending it
 * anyway is how money gets lost: the anchor no longer has a transaction to credit.
 */
export class TransferWindowExpiredError extends MoneyGramError {
  constructor(
    readonly transactionId: string,
    readonly expiresAt: Date,
  ) {
    super(
      "transfer_window_expired",
      `The transfer window for transaction ${transactionId} closed at ${expiresAt.toISOString()}`,
    );
    this.name = "TransferWindowExpiredError";
  }
}

/**
 * The anchor answered an API call with a web page. Measured twice: with a stale
 * token, and when asked for a transaction by its Stellar hash. Neither case is a
 * 401 and neither says what went wrong, so the shape of the answer is the signal.
 */
export class AnchorReturnedHtmlError extends MoneyGramError {
  constructor(
    readonly url: string,
    options?: ErrorOptions,
  ) {
    super("anchor_returned_html", `The anchor answered ${url} with HTML instead of JSON`, options);
    this.name = "AnchorReturnedHtmlError";
  }
}

/** The anchor does not know this transaction under the identity you authenticated as. */
export class TransactionNotFoundError extends MoneyGramError {
  constructor(readonly transactionId: string) {
    super("transaction_not_found", `The anchor does not know transaction ${transactionId}`);
    this.name = "TransactionNotFoundError";
  }
}

/**
 * MoneyGram allows one open transaction per Stellar account, not per SEP-10 identity.
 * Two customers sharing an account have separate KYC records but cannot transact at
 * the same time, so the caller has to serialise by account.
 */
export class AccountHasAnOpenTransactionError extends MoneyGramError {
  constructor(
    readonly account: string,
    readonly openTransactionId: string,
  ) {
    super(
      "account_has_an_open_transaction",
      `Account ${account} already has transaction ${openTransactionId} open`,
    );
    this.name = "AccountHasAnOpenTransactionError";
  }
}
