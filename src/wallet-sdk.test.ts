import { describe, expect, it } from "vitest";

import {
  ApplicationConfiguration,
  AuthToken,
  PublicKeypair,
  SigningKeypair,
  StellarConfiguration,
  TransactionStatus,
  Wallet,
} from "./wallet-sdk.js";

/**
 * Guards one half of a fault no single environment can show on its own: the import that works
 * here is not the one that works on plain Node. `npm run smoke` guards the other half.
 */
describe("the SDK's values resolve", () => {
  it("hands back constructors, not undefined", () => {
    for (const value of [
      Wallet,
      ApplicationConfiguration,
      StellarConfiguration,
      PublicKeypair,
      SigningKeypair,
      AuthToken,
    ]) {
      expect(typeof value).toBe("function");
    }
  });

  it("hands back the status enum the flows compare against", () => {
    expect(TransactionStatus.pending_user_transfer_start).toBe("pending_user_transfer_start");
    expect(TransactionStatus.refunded).toBe("refunded");
  });
});
