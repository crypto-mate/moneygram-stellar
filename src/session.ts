import axios, { type AxiosInstance } from "axios";
import { Networks } from "@stellar/stellar-sdk";
import type { AccountKeypair, Anchor, Types, WalletSigner } from "@stellar/typescript-wallet-sdk";

import {
  ApplicationConfiguration,
  AuthToken,
  StellarConfiguration,
  Wallet,
} from "./wallet-sdk.js";

import { MONEYGRAM_PRODUCTION, type AnchorDescriptor } from "./config.js";
import { AnchorReturnedHtmlError, MoneyGramError, TransactionNotFoundError } from "./errors.js";
import type { MoneyGramTransaction, StartParams, StartedFlow } from "./flows.js";
import {
  waitForDeposit as watchForDeposit,
  type HorizonServer,
  type IncomingPayment,
} from "./horizon.js";
import { looksLikeHtml } from "./http.js";
import { authenticate } from "./sep10.js";
import { toSep9 } from "./sep9.js";

/**
 * A token is treated as spent a minute before it really expires. The clock that matters is the
 * anchor's, not ours, and a request in flight when the token turns over fails for a reason that
 * reads like something else entirely.
 */
const EXPIRY_SKEW_SECONDS = 60;

export interface MoneyGramOptions {
  /** Which anchor. Defaults to production. */
  anchor?: AnchorDescriptor;
  /**
   * The domain whose `stellar.toml` publishes the `SIGNING_KEY` MoneyGram checks the challenge
   * against. In the non-custodial model this is what MoneyGram allowlists — a domain, not an
   * account.
   */
  clientDomain: string;
  /**
   * Signs the SEP-10 challenge.
   *
   * Use the SDK's `DomainSigner` to have your own service co-sign over HTTP, or write your own
   * when the key lives in an HSM. This package never holds, reads or asks for a private key.
   */
  walletSigner: WalletSigner;
  /** Language for MoneyGram's hosted screens. Defaults to English. */
  lang?: string;
  /**
   * Allows a plain-HTTP anchor. There is one honest use for this and it is pointing the package
   * at a local stand-in, as this package's own contract tests do. MoneyGram is HTTPS.
   */
  allowHttp?: boolean;
}

export interface Identity {
  /** The Stellar account that will pay, or be paid. */
  accountKp: AccountKeypair;
  /**
   * What makes this session one customer rather than the whole account.
   *
   * SEP-10 puts it in the token's subject as `G...:memo`, and MoneyGram keeps a separate KYC
   * record per subject — the spec calls that "the same level of separation as two users with
   * different Stellar accounts". That is what lets one pooled account carry many customers.
   * Leave it out for an account that belongs to a single customer, where the address already
   * identifies them.
   *
   * Not the withdraw memo. That one is MoneyGram telling you what memo your on-chain payment
   * must carry; this one says who is authenticating.
   */
  memoId?: string;
}

export class MoneyGram {
  private constructor(
    readonly descriptor: AnchorDescriptor,
    /**
     * The Horizon client, for `waitForDeposit`. Borrowed from the official SDK rather than built
     * here, so the whole package uses one copy of it.
     */
    readonly horizon: HorizonServer,
    private readonly anchor: Anchor,
    private readonly options: MoneyGramOptions,
    private readonly note: HtmlNote,
    private readonly httpClient: AxiosInstance,
  ) {}

  static open(options: MoneyGramOptions): MoneyGram {
    const descriptor = options.anchor ?? MONEYGRAM_PRODUCTION;
    const note = new HtmlNote();
    const httpClient = clientThatRefusesHtml(note);

    const wallet = new Wallet({
      stellarConfiguration:
        descriptor.network === "PUBLIC"
          ? StellarConfiguration.MainNet()
          : StellarConfiguration.TestNet(),
      applicationConfiguration: new ApplicationConfiguration(options.walletSigner, httpClient),
    });

    return new MoneyGram(
      descriptor,
      wallet.stellar().server,
      wallet.anchor({
        homeDomain: descriptor.homeDomain,
        language: options.lang ?? "en",
        allowHttp: options.allowHttp,
      }),
      options,
      note,
      httpClient,
    );
  }

  /**
   * Authenticates and hands back a session.
   *
   * The handshake runs here rather than on the first real call, so a wrong `client_domain`, an
   * unpublished `SIGNING_KEY` or a refused signature surfaces where you can read it.
   */
  async authenticate(identity: Identity): Promise<Session> {
    const session = new Session(
      this.anchor,
      this.descriptor,
      {
        ...identity,
        clientDomain: this.options.clientDomain,
        walletSigner: this.options.walletSigner,
      },
      this.note,
      this.httpClient,
      this.horizon,
    );
    await session.token();
    return session;
  }
}

type SessionIdentity = Identity & { clientDomain: string; walletSigner: WalletSigner };

export class Session {
  private cached: Types.AuthToken | undefined;

  constructor(
    private readonly anchor: Anchor,
    readonly descriptor: AnchorDescriptor,
    private readonly identity: SessionIdentity,
    private readonly note: HtmlNote,
    private readonly httpClient: AxiosInstance,
    private readonly horizon: HorizonServer,
  ) {}

  /** The account this session acts as. */
  get account(): string {
    return this.identity.accountKp.publicKey;
  }

  /** The customer this session acts as, when the account carries more than one. */
  get memo(): string | undefined {
    return this.identity.memoId;
  }

  /** The current token, minted or renewed as needed. */
  async token(): Promise<Types.AuthToken> {
    if (this.cached && !isTokenExpired(this.cached.expiresAt, nowInSeconds())) {
      return this.cached;
    }

    // SEP-10 is the one step this package performs itself, because a pooled account has to
    // authenticate with a memo and a client domain at once. See `./sep10.ts`.
    const toml = await this.anchor.sep1();
    const { token } = await authenticate({
      webAuthEndpoint: toml.webAuthEndpoint,
      serverSigningKey: toml.signingKey,
      homeDomain: this.descriptor.homeDomain,
      networkPassphrase: this.descriptor.network === "PUBLIC" ? Networks.PUBLIC : Networks.TESTNET,
      accountKp: this.identity.accountKp,
      memoId: this.identity.memoId,
      clientDomain: this.identity.clientDomain,
      walletSigner: this.identity.walletSigner,
      httpClient: this.httpClient,
    });

    // Handed back as the SDK's own type, which it builds straight from the JWT. All it ever
    // reads is the string, but keeping its type is what lets the SEP-24 calls stay untouched.
    this.cached = AuthToken.from(token);
    return this.cached;
  }

  /** Throws the cached token away, so the next call mints a new one. */
  forget(): void {
    this.cached = undefined;
  }

  /** Opens a cash-out: USDC leaves this account, the customer collects cash at an agent. */
  async startWithdraw(params: StartParams): Promise<StartedFlow> {
    return this.start("withdraw", params);
  }

  /** Opens a cash-in: the customer pays cash at an agent, USDC arrives on this account. */
  async startDeposit(params: StartParams): Promise<StartedFlow> {
    return this.start("deposit", params);
  }

  /**
   * Waits for a cash-in to land on this account and hands back the payment that carried it.
   *
   * The issuer of the asset is read from the anchor's own stellar.toml, which is the only
   * authority on who issues the thing it pays in. Pass `assetIssuer` to override that: SEP-1
   * only recommends publishing currencies, so an anchor is free to stop.
   */
  async waitForDeposit(params: {
    /** `deposit_memo` from the SEP-24 transaction: the only thing joining the payment to it. */
    memo: string;
    amount?: string;
    assetIssuer?: string;
    cursor?: string;
    pollMs?: number;
    signal?: AbortSignal;
  }): Promise<IncomingPayment> {
    return watchForDeposit({
      server: this.horizon,
      account: this.account,
      assetCode: this.descriptor.assetCode,
      assetIssuer: params.assetIssuer ?? (await this.publishedIssuer()),
      memo: params.memo,
      amount: params.amount,
      cursor: params.cursor,
      pollMs: params.pollMs,
      signal: params.signal,
    });
  }

  /**
   * Asks the anchor about a transaction, by its id.
   *
   * There is no lookup by Stellar hash on this class, and its absence is deliberate. SEP-24
   * offers one and the official SDK exposes it, but MoneyGram answers that call with a web page
   * — measured with a hash the anchor itself reports, with and without the SEP-10 memo: three
   * calls, three failures. To find out whether a payment settled a transaction, fetch the
   * transaction by id and compare, which is what `settles` does.
   */
  async getTransaction(id: string): Promise<MoneyGramTransaction> {
    return this.withToken(async (authToken) => {
      const transaction = await this.anchor.sep24().getTransactionBy({ authToken, id });

      // The SDK's type allows a transaction with neither id nor status, which is how a failure
      // the anchor reports with nothing in it comes back. Checking here is what makes the
      // narrower type below honest rather than a cast over an empty object.
      if (!transaction?.id || !transaction.status) {
        throw new TransactionNotFoundError(id);
      }
      return transaction as MoneyGramTransaction;
    });
  }

  /**
   * Runs an anchor call with this session's token, and runs it once more with a fresh token if
   * the anchor answered with a web page.
   *
   * That answer has two meanings and only one is fixable: either the token is spent, which a new
   * one solves, or the call is one MoneyGram does not serve, which no token solves. Retrying
   * exactly once tells them apart, and the second failure is reported as what it is.
   */
  async withToken<T>(call: (token: Types.AuthToken) => Promise<T>): Promise<T> {
    try {
      return await call(await this.token());
    } catch (error) {
      const servedHtml = this.note.take();
      if (!servedHtml) {
        throw error;
      }

      this.forget();
      try {
        return await call(await this.token());
      } catch (retryError) {
        const again = this.note.take();
        throw again ? new AnchorReturnedHtmlError(again, { cause: retryError }) : retryError;
      }
    }
  }

  /** Who the anchor says issues the asset it deals in. */
  private async publishedIssuer(): Promise<string> {
    const { assetCode } = this.descriptor;
    const toml = await this.anchor.sep1();
    const issuer = toml.currencies?.find((currency) => currency.code === assetCode)?.issuer;

    if (!issuer) {
      throw new MoneyGramError(
        "asset_not_published",
        `The anchor's stellar.toml does not say who issues ${assetCode}, so pass assetIssuer`,
      );
    }
    return issuer;
  }

  private async start(
    kind: "deposit" | "withdraw",
    { amount, customer }: StartParams,
  ): Promise<StartedFlow> {
    const extraFields = { amount, ...(customer ? toSep9(customer) : {}) };

    return this.withToken(async (authToken) => {
      const sep24 = this.anchor.sep24();
      const assetCode = this.descriptor.assetCode;

      const response =
        kind === "withdraw"
          ? await sep24.withdraw({
              authToken,
              assetCode,
              extraFields,
              withdrawalAccount: this.account,
            })
          : await sep24.deposit({
              authToken,
              assetCode,
              extraFields,
              destinationAccount: this.account,
            });

      if (!response.id || !response.url) {
        throw new MoneyGramError(
          "flow_not_opened",
          `MoneyGram opened no ${kind}: ${response.error ?? response.type}`,
        );
      }

      return { id: response.id, url: response.url };
    });
  }
}

/**
 * The JWT's `exp` claim, in seconds since the epoch. The SDK types it as a string and fills it
 * with a number, so it is coerced rather than trusted; anything that is not a number is treated
 * as already expired, which costs one extra handshake and never serves a stale token.
 */
export function isTokenExpired(
  expiresAt: string | number,
  nowSeconds: number,
  skewSeconds: number = EXPIRY_SKEW_SECONDS,
): boolean {
  const exp = Number(expiresAt);
  return !Number.isFinite(exp) || exp - skewSeconds <= nowSeconds;
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Where the HTML guard leaves word that it fired.
 *
 * A note rather than the thrown error, because an error raised inside a response interceptor
 * does not reach the caller as itself: the request layer normalises it into an error of its own
 * and the original object is gone by then. So the interceptor leaves a note on its way out, and
 * the session reads the note instead of inspecting an error it will never see.
 *
 * One note per `MoneyGram` instance. Two calls in flight on the same instance can read each
 * other's note; the cost is one wasted handshake, never a wrong answer.
 */
class HtmlNote {
  private url: string | undefined;

  leave(url: string): void {
    this.url = url;
  }

  take(): string | undefined {
    const url = this.url;
    this.url = undefined;
    return url;
  }
}

function clientThatRefusesHtml(note: HtmlNote) {
  const client = axios.create();

  client.interceptors.response.use((response) => {
    if (looksLikeHtml(response.headers?.["content-type"], response.data)) {
      const url = response.config?.url ?? "the anchor";
      note.leave(url);
      throw new AnchorReturnedHtmlError(url);
    }
    return response;
  });

  return client;
}
