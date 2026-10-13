import { describe, expect, it } from "vitest";

import { isTokenExpired } from "./session.js";

const NOW = 1_800_000_000;

describe("isTokenExpired", () => {
  it("keeps a token that is still good", () => {
    expect(isTokenExpired(NOW + 3600, NOW)).toBe(false);
  });

  it("gives up on a token a minute before it really expires", () => {
    expect(isTokenExpired(NOW + 61, NOW)).toBe(false);
    expect(isTokenExpired(NOW + 59, NOW)).toBe(true);
  });

  it("reads the exp the SDK hands back, whichever way it is typed", () => {
    expect(isTokenExpired(String(NOW + 3600), NOW)).toBe(false);
    expect(isTokenExpired(String(NOW - 1), NOW)).toBe(true);
  });

  it("treats anything it cannot read as expired, so it never serves a stale token", () => {
    expect(isTokenExpired("not a number", NOW)).toBe(true);
    expect(isTokenExpired(Number.NaN, NOW)).toBe(true);
  });
});
