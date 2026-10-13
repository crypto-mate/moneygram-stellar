import bundled, * as namespaced from "@stellar/typescript-wallet-sdk";
import type * as WalletSdk from "@stellar/typescript-wallet-sdk";

/**
 * Where this package reaches the official SDK's values.
 *
 * The SDK ships as a single CommonJS bundle, and importing a bundle's named exports from an ES
 * module depends on who is doing the importing. Measured both ways:
 *
 * | | plain Node | a bundler-based test runner |
 * | --- | --- | --- |
 * | `import sdk from "…"` | 42 exports | 1, and not the ones you want |
 * | `import * as sdk from "…"` | the module's `default` and little else | 42 exports |
 *
 * Neither is wrong — each follows its own interop rules, and the SDK populates both shapes — but
 * no single import spelling works in both. So both are taken and whichever carries the SDK wins.
 *
 * The reason this is worth a file of its own: the two environments disagreeing is exactly the
 * kind of fault a test suite cannot see, because the test runner is one of the two. `npm test`
 * covers the bundler side and `npm run smoke` loads the built package on plain Node. Both have to
 * pass before this package has been shown to work.
 *
 * Types are untouched by any of it — they are erased long before — so the rest of the package
 * goes on importing them straight from the SDK with `import type`.
 */
function carriesTheSdk(candidate: unknown): candidate is typeof WalletSdk {
  return typeof (candidate as typeof WalletSdk | undefined)?.Wallet === "function";
}

const sdk = [namespaced, bundled].find(carriesTheSdk);

if (!sdk) {
  throw new Error(
    "@stellar/typescript-wallet-sdk did not load: neither its namespace nor its default export " +
      "carries a Wallet. Check that the installed version still publishes one.",
  );
}

export const {
  ApplicationConfiguration,
  DomainSigner,
  PublicKeypair,
  SigningKeypair,
  StellarConfiguration,
  Wallet,
} = sdk;

export const { AuthToken, TransactionStatus } = sdk.Types;
