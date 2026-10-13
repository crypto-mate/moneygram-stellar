/**
 * The one guard that cannot be bolted on from outside: MoneyGram answers some API calls with a
 * web page instead of JSON.
 *
 * It is not a 401 and not a 4xx. Measured twice against the sandbox:
 *
 *  - with an expired SEP-10 token, where the fix is to authenticate again;
 *  - when asking for a transaction by its Stellar hash, where there is no fix and the call
 *    should never have been made (see `getTransaction`).
 *
 * Both arrive as a 200 carrying HTML, so the shape of the answer is the only signal there is.
 */

/**
 * True when a response body is a web page rather than data.
 *
 * The content type is checked first because it is what the anchor actually sets; the body is
 * checked as well because a misconfigured proxy can serve HTML as `application/json`, and the
 * cost of looking is one string comparison.
 */
export function looksLikeHtml(contentType: unknown, body: unknown): boolean {
  if (typeof contentType === "string" && contentType.toLowerCase().includes("text/html")) {
    return true;
  }
  if (typeof body !== "string") {
    return false;
  }
  const start = body.trimStart().slice(0, 14).toLowerCase();
  return start.startsWith("<!doctype html") || start.startsWith("<html");
}
