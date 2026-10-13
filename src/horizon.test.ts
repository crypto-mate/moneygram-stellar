import { describe, expect, it } from "vitest";

import {
  depositIn,
  waitForDeposit,
  type ExpectedDeposit,
  type HorizonServer,
  type OperationLike,
} from "./horizon.js";

const ACCOUNT = "GBHG7IA3XQKHGWJ4QKMM6ZHMDVQ6VQHFB2XWXYWNLZ4FBPZQ6WWXUAZN";
const USDC = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const MONEYGRAM = "GD5NUMEX7LYHXGXCAD4PGW7JDMOUY2DKRGY5XSJ3ZJRGZ5PPKBXCOVET";

const expected: ExpectedDeposit = {
  account: ACCOUNT,
  memo: "2938417465",
  assetCode: "USDC",
  assetIssuer: USDC,
};

function payment(fields: Partial<OperationLike> = {}): OperationLike {
  return {
    type: "payment",
    to: ACCOUNT,
    from: MONEYGRAM,
    amount: "100.0000000",
    asset_code: "USDC",
    asset_issuer: USDC,
    ...fields,
  };
}

describe("depositIn", () => {
  it("finds the payment that credited the account", () => {
    expect(depositIn([payment()], expected)).toEqual({
      amount: "100.0000000",
      from: MONEYGRAM,
    });
  });

  it("ignores an asset with the right code and the wrong issuer", () => {
    // The reason the issuer is required: anyone can issue something called USDC, send a unit of
    // it with a memo they guessed, and wait to see whether a customer gets credited.
    const lookalike = payment({ asset_issuer: MONEYGRAM });

    expect(depositIn([lookalike], expected)).toBeUndefined();
  });

  it("ignores a payment to somebody else that happened to share the transaction", () => {
    const elsewhere = payment({ to: "GAIBOQQVZ3YFOXMFPRNBYXZEVRGL6W2NFHMZUMPYMB3AWQRJDWXGWJPZ" });

    expect(depositIn([elsewhere], expected)).toBeUndefined();
  });

  it("ignores operations that credit nothing", () => {
    expect(depositIn([payment({ type: "change_trust" })], expected)).toBeUndefined();
    expect(depositIn([payment({ type: "create_account" })], expected)).toBeUndefined();
  });

  it("takes a path payment, which settles in the destination asset", () => {
    const viaPath = payment({ type: "path_payment_strict_receive" });

    expect(depositIn([viaPath], expected)?.amount).toBe("100.0000000");
  });

  it("holds out for the exact amount when one is expected", () => {
    const short = payment({ amount: "99.9999999" });

    expect(depositIn([short], { ...expected, amount: "100.0000000" })).toBeUndefined();
    expect(depositIn([payment()], { ...expected, amount: "100.0000000" })).toBeDefined();
  });

  it("picks the right payment out of a transaction that carries several", () => {
    const operations = [
      payment({ to: "GAIBOQQVZ3YFOXMFPRNBYXZEVRGL6W2NFHMZUMPYMB3AWQRJDWXGWJPZ" }),
      payment({ asset_code: "XLM", asset_issuer: undefined }),
      payment({ amount: "42.0000000" }),
    ];

    expect(depositIn(operations, expected)?.amount).toBe("42.0000000");
  });

  it("finds nothing in a transaction that only shares the memo", () => {
    expect(depositIn([], expected)).toBeUndefined();
  });
});

/**
 * A Horizon stand-in. Only the three calls the watcher makes are implemented, which is the point:
 * anything else it started doing would fail loudly here.
 */
function horizonServing(
  pages: { records: Record<string, unknown>[] }[],
  operationsByHash: Record<string, OperationLike[]>,
): { server: HorizonServer; cursors: (string | undefined)[] } {
  const cursors: (string | undefined)[] = [];
  let page = 0;

  const server = {
    transactions: () => {
      let cursor: string | undefined;
      const query = {
        forAccount: () => query,
        order: (direction: string) => {
          if (direction === "desc") {
            // The opening call that asks where "now" is.
            return { limit: () => ({ call: async () => ({ records: [] }) }) };
          }
          return query;
        },
        limit: () => query,
        cursor: (value: string) => {
          cursor = value;
          return query;
        },
        call: async () => {
          cursors.push(cursor);
          return pages[page++] ?? { records: [] };
        },
      };
      return query;
    },
    operations: () => ({
      forTransaction: (hash: string) => ({
        call: async () => ({ records: operationsByHash[hash] ?? [] }),
      }),
    }),
  };

  return { server: server as unknown as HorizonServer, cursors };
}

describe("waitForDeposit", () => {
  it("returns the payment that carried the deposit", async () => {
    const { server } = horizonServing(
      [
        {
          records: [
            { hash: "aaa", memo: "other", successful: true, paging_token: "1" },
            { hash: "bbb", memo: "2938417465", successful: true, paging_token: "2" },
          ],
        },
      ],
      { bbb: [payment()] },
    );

    await expect(waitForDeposit({ server, ...expected, pollMs: 1 })).resolves.toEqual({
      hash: "bbb",
      amount: "100.0000000",
      from: MONEYGRAM,
    });
  });

  it("walks past a failed transaction that carries the same memo", async () => {
    const { server } = horizonServing(
      [
        {
          records: [
            { hash: "aaa", memo: "2938417465", successful: false, paging_token: "1" },
            { hash: "bbb", memo: "2938417465", successful: true, paging_token: "2" },
          ],
        },
      ],
      { aaa: [payment()], bbb: [payment({ amount: "7.0000000" })] },
    );

    const found = await waitForDeposit({ server, ...expected, pollMs: 1 });

    expect(found).toEqual({ hash: "bbb", amount: "7.0000000", from: MONEYGRAM });
  });

  it("advances the cursor across pages, so a restart loses nothing", async () => {
    const { server, cursors } = horizonServing(
      [
        { records: [{ hash: "aaa", memo: "other", successful: true, paging_token: "1" }] },
        { records: [{ hash: "bbb", memo: "2938417465", successful: true, paging_token: "2" }] },
      ],
      { bbb: [payment()] },
    );

    await waitForDeposit({ server, ...expected, pollMs: 1 });

    expect(cursors).toEqual([undefined, "1"]);
  });

  it("stops when the caller aborts", async () => {
    const { server } = horizonServing([], {});
    const stop = new AbortController();
    stop.abort(new Error("enough"));

    await expect(
      waitForDeposit({ server, ...expected, pollMs: 1, signal: stop.signal }),
    ).rejects.toThrow("enough");
  });
});
