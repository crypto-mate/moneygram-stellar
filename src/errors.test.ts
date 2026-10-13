import { describe, expect, it } from "vitest";

import {
  AccountHasAnOpenTransactionError,
  AnchorReturnedHtmlError,
  MoneyGramError,
  TransferWindowExpiredError,
} from "./errors.js";

describe("errors", () => {
  it("lets a caller branch on the code without instanceof", () => {
    const thrown: MoneyGramError[] = [
      new AnchorReturnedHtmlError("https://anchor.example/sep24/transaction"),
      new TransferWindowExpiredError("abc", new Date("2026-10-08T12:00:00Z")),
      new AccountHasAnOpenTransactionError("GABC", "def"),
    ];

    expect(thrown.map((e) => e.code)).toEqual([
      "anchor_returned_html",
      "transfer_window_expired",
      "account_has_an_open_transaction",
    ]);
  });

  it("keeps the detail that makes the error actionable", () => {
    const expired = new TransferWindowExpiredError("abc", new Date("2026-10-08T12:00:00Z"));

    expect(expired.transactionId).toBe("abc");
    expect(expired.message).toContain("2026-10-08T12:00:00.000Z");
  });
});
