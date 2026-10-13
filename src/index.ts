// Re-exported so that calling this package takes one import, and so that how the SDK
// underneath is packaged never becomes the caller's problem.
export { DomainSigner, PublicKeypair, SigningKeypair } from "./wallet-sdk.js";
export type { AccountKeypair, WalletSigner } from "@stellar/typescript-wallet-sdk";

export { MoneyGram, Session } from "./session.js";
export type { Identity, MoneyGramOptions } from "./session.js";

export { deadlineFor, isRefunded, refundUrl, settles, transferInstruction } from "./flows.js";
export type {
  MoneyGramTransaction,
  Settlement,
  StartParams,
  StartedFlow,
  TransferInstruction,
} from "./flows.js";

export { depositIn, waitForDeposit } from "./horizon.js";
export type {
  ExpectedDeposit,
  HorizonServer,
  IncomingPayment,
  OperationLike,
  WatchParams,
} from "./horizon.js";

export { MONEYGRAM_PRODUCTION, MONEYGRAM_SANDBOX } from "./config.js";
export type { AnchorDescriptor } from "./config.js";

export { toSep9 } from "./sep9.js";
export type { Customer, CustomerAddress } from "./sep9.js";

export {
  MoneyGramError,
  TransferWindowExpiredError,
  AnchorReturnedHtmlError,
  TransactionNotFoundError,
  AccountHasAnOpenTransactionError,
} from "./errors.js";
export type { MoneyGramErrorCode } from "./errors.js";
