/**
 * The two MoneyGram anchors.
 *
 * Only the origin and the network are configured. The SEP-10 and SEP-24 endpoints and the
 * anchor's signing key are read at runtime from its SEP-1 `stellar.toml`, which is the anchor's
 * own source of truth — so a move or a key rotation on MoneyGram's side costs you nothing.
 */
export interface AnchorDescriptor {
  /** Anchor origin. */
  url: string;
  /** The SEP-10 `home_domain`. Derived from `url` so the two cannot drift apart. */
  homeDomain: string;
  network: "PUBLIC" | "TESTNET";
  /** The only asset MoneyGram ramps deal in. */
  assetCode: string;
}

function anchorAt(url: string, network: "PUBLIC" | "TESTNET"): AnchorDescriptor {
  return { url, homeDomain: new URL(url).host, network, assetCode: "USDC" };
}

export const MONEYGRAM_PRODUCTION: AnchorDescriptor = anchorAt(
  "https://mgxanchor.moneygram.com",
  "PUBLIC",
);

/** MoneyGram's sandbox, on Stellar testnet. Access is granted by MoneyGram, not self-serve. */
export const MONEYGRAM_SANDBOX: AnchorDescriptor = anchorAt(
  "https://extmgxanchor.moneygram.com",
  "TESTNET",
);
