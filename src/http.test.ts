import { describe, expect, it } from "vitest";

import { looksLikeHtml } from "./http.js";

describe("looksLikeHtml", () => {
  it("catches the page the anchor serves instead of data", () => {
    expect(looksLikeHtml("text/html; charset=utf-8", "<!DOCTYPE html><html>...")).toBe(true);
  });

  it("catches a page served under a JSON content type", () => {
    expect(looksLikeHtml("application/json", "\n  <!doctype html><html>...")).toBe(true);
    expect(looksLikeHtml(undefined, "<html lang='en'>")).toBe(true);
  });

  it("lets data through", () => {
    expect(looksLikeHtml("application/json", { id: "abc", status: "completed" })).toBe(false);
    expect(looksLikeHtml("application/json", '{"id":"abc"}')).toBe(false);
    expect(looksLikeHtml(undefined, undefined)).toBe(false);
  });

  it("does not mistake data that merely starts with an angle bracket", () => {
    expect(looksLikeHtml("application/json", "<not-a-page>")).toBe(false);
  });
});
