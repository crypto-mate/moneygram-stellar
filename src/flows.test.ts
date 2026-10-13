import { Types } from "@stellar/typescript-wallet-sdk";
import { describe, expect, it } from "vitest";

import { TransferWindowExpiredError } from "./errors.js";
import {
  deadlineFor,
  isRefunded,
  refundUrl,
  settles,
  transferInstruction,
  type MoneyGramTransaction,
} from "./flows.js";

const { TransactionStatus } = Types;

const NOW = new Date("2026-10-08T12:00:00Z");

function transaction(fields: Partial<MoneyGramTransaction> = {}): MoneyGramTransaction {
  return {
    id: "ec9b1082-ec2e-4bc9-9cd8-d5881da422d0",
    status: TransactionStatus.pending_user_transfer_start,
    ...fields,
  };
}

/** A cash-out at the stage where MoneyGram has said where to send the USDC. */
function awaitingTransfer(fields: Partial<MoneyGramTransaction> = {}): MoneyGramTransaction {
  return transaction({
    withdraw_anchor_account: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    withdraw_memo: "2938417465",
    withdraw_memo_type: "id",
    amount_in: "15.15",
    user_action_required_by: "2026-10-08T12:30:00Z",
    ...fields,
  });
}

describe("transferInstruction", () => {
  it("hands back where the USDC goes, with the memo the anchor dictated", () => {
    expect(transferInstruction(awaitingTransfer(), NOW)).toEqual({
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      memo: "2938417465",
      memoType: "id",
      amount: "15.15",
      expiresAt: new Date("2026-10-08T12:30:00Z"),
    });
  });

  it("has nothing to say until the transaction reaches that stage", () => {
    expect(
      transferInstruction(awaitingTransfer({ status: TransactionStatus.incomplete }), NOW),
    ).toBeUndefined();
    expect(
      transferInstruction(awaitingTransfer({ status: TransactionStatus.pending_anchor }), NOW),
    ).toBeUndefined();
  });

  it("refuses to fill a gap the anchor left", () => {
    expect(transferInstruction(awaitingTransfer({ withdraw_memo: undefined }), NOW)).toBeUndefined();
    expect(
      transferInstruction(awaitingTransfer({ withdraw_memo_type: undefined }), NOW),
    ).toBeUndefined();
    expect(
      transferInstruction(awaitingTransfer({ withdraw_anchor_account: undefined }), NOW),
    ).toBeUndefined();
    expect(transferInstruction(awaitingTransfer({ amount_in: undefined }), NOW)).toBeUndefined();
  });

  it("throws once the window has closed, instead of handing over a payment that is lost", () => {
    const tooLate = new Date("2026-10-08T12:30:01Z");

    expect(() => transferInstruction(awaitingTransfer(), tooLate)).toThrow(
      TransferWindowExpiredError,
    );
  });

  it("still works when the anchor sets no deadline", () => {
    const instruction = transferInstruction(
      awaitingTransfer({ user_action_required_by: undefined }),
      NOW,
    );

    expect(instruction?.expiresAt).toBeUndefined();
  });
});

describe("deadlineFor", () => {
  it("reads the deadline the anchor is holding you to", () => {
    expect(deadlineFor(awaitingTransfer())).toEqual(new Date("2026-10-08T12:30:00Z"));
  });

  it("is the same field for the 60 days the cash stays collectable", () => {
    const collectable = transaction({
      status: TransactionStatus.pending_user_transfer_complete,
      external_transaction_id: "14846223",
      user_action_required_by: "2026-12-07T12:00:00Z",
    });

    expect(deadlineFor(collectable)).toEqual(new Date("2026-12-07T12:00:00Z"));
  });

  it("says nothing rather than guessing when the field is absent or unreadable", () => {
    expect(deadlineFor(transaction())).toBeUndefined();
    expect(deadlineFor(transaction({ user_action_required_by: "soon" }))).toBeUndefined();
  });
});

describe("settles", () => {
  const hash = "7a1f0c2d9b4e6a8c5f3d1b0e9a7c4f2d8b6a0e3c1f5d9b7a2e4c6f8a0b3d5e7c";

  it("recognises the payment the anchor says settled the transaction", () => {
    expect(settles(transaction({ stellar_transaction_id: hash }), hash)).toEqual({
      kind: "settles",
    });
  });

  it("keeps apart the case where the anchor has not named its own payment", () => {
    // Seen repeatedly in the sandbox: the USDC had arrived and the transaction still said this.
    expect(settles(transaction(), hash)).toEqual({
      kind: "anchor-has-not-recorded-its-payment",
      status: TransactionStatus.pending_user_transfer_start,
    });
  });

  it("calls a payment that settled something else an ordinary deposit", () => {
    const other = "0e15d9f8c3b7a1e5d9f3b7c1a5e9d3f7b1c5a9e3d7f1b5c9a3e7d1f5b9c3a7e1";

    expect(settles(transaction({ stellar_transaction_id: other }), hash)).toEqual({
      kind: "another-payment",
      settledBy: other,
    });
  });
});

describe("isRefunded", () => {
  it("reads both spellings MoneyGram uses", () => {
    expect(isRefunded(transaction({ status: TransactionStatus.refunded }))).toBe(true);
    expect(isRefunded(transaction({ refunded: true }))).toBe(true);
  });

  it("is false while the transfer is still alive", () => {
    expect(isRefunded(transaction({ status: TransactionStatus.completed }))).toBe(false);
    expect(isRefunded(transaction())).toBe(false);
  });
});

describe("refundUrl", () => {
  it("points at the page where MoneyGram puts Cancel transfer", () => {
    const url = "https://extmgxanchor.moneygram.com/more_info?id=ec9b1082";

    expect(refundUrl(transaction({ more_info_url: url }))).toBe(url);
  });
});
