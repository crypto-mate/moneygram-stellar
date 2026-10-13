import type { Stellar } from "@stellar/typescript-wallet-sdk";

/**
 * Watching the network for the payment that settles a cash-in.
 *
 * This exists because MoneyGram's own record of a cash-in cannot be relied on to name its
 * payment. Measured repeatedly against the sandbox: the transaction sat at
 * `pending_user_transfer_start` with an empty `stellar_transaction_id` long after the USDC had
 * landed. So the link between "MoneyGram paid" and "a payment arrived" has to be made on-chain,
 * and the only thing joining them is the memo the anchor told you to expect.
 */

/** The Horizon client, borrowed from the official SDK so there is only ever one copy of it. */
export type HorizonServer = Stellar["server"];

export interface ExpectedDeposit {
  /** The account that should receive the funds. */
  account: string;
  /**
   * The memo the anchor said its payment would carry — `deposit_memo` on the SEP-24 transaction.
   */
  memo: string;
  assetCode: string;
  /**
   * The issuer of that asset. Required, and not a formality: **an asset code is not an identity
   * on Stellar.** Anyone can issue something called USDC, pay you one unit of it with any memo
   * they like, and watch you credit a customer. Matching the issuer is what makes the memo safe
   * to match on.
   */
  assetIssuer: string;
  /** When given, the payment must be for exactly this amount. */
  amount?: string;
}

export interface IncomingPayment {
  /** The Stellar transaction that carried the payment. */
  hash: string;
  amount: string;
  /** The account that paid, which for a cash-in is MoneyGram's. */
  from: string;
}

/**
 * The part of a Horizon operation record this needs. Structural on purpose: a real record fits,
 * and so does a fixture written by hand.
 */
export interface OperationLike {
  type: string;
  to?: string;
  from?: string;
  amount?: string;
  asset_code?: string;
  asset_issuer?: string;
}

/** Credited the destination account; a path payment settles in the destination asset too. */
const CREDITING_OPERATIONS = new Set([
  "payment",
  "path_payment_strict_receive",
  "path_payment_strict_send",
]);

/**
 * Finds, among the operations of one Stellar transaction, the payment that is the deposit being
 * waited for — or nothing, if this transaction merely happened to carry the right memo.
 */
export function depositIn(
  operations: readonly OperationLike[],
  expected: ExpectedDeposit,
): Omit<IncomingPayment, "hash"> | undefined {
  for (const operation of operations) {
    if (!CREDITING_OPERATIONS.has(operation.type)) {
      continue;
    }
    if (operation.to !== expected.account) {
      continue;
    }
    if (operation.asset_code !== expected.assetCode) {
      continue;
    }
    if (operation.asset_issuer !== expected.assetIssuer) {
      continue;
    }
    if (expected.amount !== undefined && operation.amount !== expected.amount) {
      continue;
    }
    if (!operation.amount || !operation.from) {
      continue;
    }

    return { amount: operation.amount, from: operation.from };
  }

  return undefined;
}

export interface WatchParams extends ExpectedDeposit {
  server: HorizonServer;
  /**
   * Where to start reading the account's history. Defaults to its latest transaction, so only
   * what happens from now on is considered. Pass a paging token to resume a watch that was
   * interrupted — otherwise a payment that arrives while your process is restarting is missed.
   */
  cursor?: string;
  /** How long to wait between polls when nothing new has happened. */
  pollMs?: number;
  /**
   * How to stop. Without one this waits indefinitely, which is usually what you want — the
   * customer may take hours to reach an agent — but it means the caller owns the lifetime.
   */
  signal?: AbortSignal;
}

/**
 * Waits for the deposit to arrive and hands back the payment that carried it.
 *
 * Polls rather than streams: a stream dies quietly on a dropped connection, and a cash-in that
 * is only noticed by a watcher is one you cannot afford to stop watching. Each page advances the
 * cursor, so a restart with the last cursor loses nothing.
 */
export async function waitForDeposit(params: WatchParams): Promise<IncomingPayment> {
  const { server, account, memo, signal, pollMs = 5_000 } = params;

  let cursor = params.cursor ?? (await latestCursor(server, account));

  for (;;) {
    signal?.throwIfAborted();

    // No cursor means the account has never been used, so there is nothing to skip past.
    const query = server.transactions().forAccount(account).order("asc").limit(200);
    const page = await (cursor ? query.cursor(cursor) : query).call();

    for (const transaction of page.records) {
      cursor = transaction.paging_token;

      // A failed transaction changes nothing on the ledger, and the memo is only a label: both
      // have to hold before the operations are worth fetching.
      if (!transaction.successful || transaction.memo !== memo) {
        continue;
      }

      const operations = await server.operations().forTransaction(transaction.hash).call();
      const payment = depositIn(operations.records as OperationLike[], params);
      if (payment) {
        return { ...payment, hash: transaction.hash };
      }
    }

    if (page.records.length === 0) {
      await sleep(pollMs, signal);
    }
  }
}

/**
 * The account's most recent paging token, or nothing for an account that has never been used —
 * in which case reading from the beginning costs one empty page.
 */
async function latestCursor(server: HorizonServer, account: string): Promise<string | undefined> {
  const page = await server.transactions().forAccount(account).order("desc").limit(1).call();
  return page.records[0]?.paging_token;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
