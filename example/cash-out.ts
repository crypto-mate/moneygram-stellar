/**
 * Opens a cash-out against MoneyGram's sandbox and follows it to the end.
 *
 * It stops short of one thing on purpose: it will not send the payment. The package hands you an
 * instruction and sending it is yours, so the example prints the instruction and waits for you to
 * act on it. A reference client that moves money while you are reading its output would be
 * teaching the wrong lesson.
 *
 *   npm run build
 *   node --experimental-strip-types example/cash-out.ts
 *
 * See example/README.md for what has to be in the environment first.
 */
import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import {
  MONEYGRAM_SANDBOX,
  MoneyGram,
  PublicKeypair,
  deadlineFor,
  isRefunded,
  refundUrl,
  transferInstruction,
  type WalletSigner,
} from "@cryptomate/moneygram-stellar";

const SETTLED = new Set(["completed", "refunded", "expired", "error", "too_small", "too_large"]);

const config = {
  clientDomain: required("MG_CLIENT_DOMAIN"),
  domainSecret: required("MG_DOMAIN_SECRET"),
  accountSecret: required("MG_ACCOUNT_SECRET"),
  memoId: process.env.MG_MEMO,
  amount: process.env.MG_AMOUNT ?? "10.00",
};

const account = Keypair.fromSecret(config.accountSecret);
const domainKey = Keypair.fromSecret(config.domainSecret);

/**
 * Both halves of the signing, done locally because this is an example. In a real wallet the
 * account key lives wherever you keep customer funds and the domain key behind a signing service
 * — the SDK's `DomainSigner` calls one over HTTP. Either way the package only ever sees this
 * object, never a key.
 */
const walletSigner: WalletSigner = {
  signWithClientAccount({ transaction }) {
    transaction.sign(account);
    return transaction;
  },
  async signWithDomainAccount({ transactionXDR, networkPassphrase }) {
    const transaction = TransactionBuilder.fromXdr(transactionXDR, networkPassphrase) as Transaction;
    transaction.sign(domainKey);
    return transaction;
  },
};

const moneyGram = MoneyGram.open({
  anchor: MONEYGRAM_SANDBOX,
  clientDomain: config.clientDomain,
  walletSigner,
});

const session = await moneyGram.authenticate({
  accountKp: PublicKeypair.fromPublicKey(account.publicKey()),
  memoId: config.memoId,
});

console.log(`authenticated as ${session.account}${session.memo ? ` : ${session.memo}` : ""}`);

const cashOut = await session.startWithdraw({
  amount: config.amount,
  customer: {
    firstName: "Ada",
    lastName: "Lovelace",
    birthDate: "1990-12-10",
    phoneCountryCode: "1",
    phoneNumber: "5555550123",
    address: { streetLine1: "1 Main St", city: "Austin", postalCode: "78701", countryCode: "USA" },
  },
});

console.log(`\ntransaction ${cashOut.id}`);
console.log(`open this and complete it: ${cashOut.url}\n`);

let announced = "";
let instructed = false;

for (;;) {
  const transaction = await session.getTransaction(cashOut.id);

  if (transaction.status !== announced) {
    announced = transaction.status;
    const deadline = deadlineFor(transaction);
    console.log(`status ${announced}${deadline ? `, until ${deadline.toISOString()}` : ""}`);
  }

  if (!instructed) {
    const instruction = transferInstruction(transaction);
    if (instruction) {
      instructed = true;
      console.log(`\n  send ${instruction.amount} USDC`);
      console.log(`    to ${instruction.destination}`);
      console.log(`    with memo ${instruction.memo} of type ${instruction.memoType}`);
      console.log(`    before ${instruction.expiresAt?.toISOString() ?? "no stated deadline"}`);
      console.log(`\n  to cancel instead: ${refundUrl(transaction) ?? "no page offered"}\n`);
    }
  }

  if (SETTLED.has(transaction.status)) {
    console.log(isRefunded(transaction) ? "\nrefunded" : `\nfinished as ${transaction.status}`);
    if (transaction.external_transaction_id) {
      console.log(`reference number for the agent: ${transaction.external_transaction_id}`);
    }
    break;
  }

  await new Promise((resolve) => setTimeout(resolve, 5_000));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. See example/README.md.`);
    process.exit(1);
  }
  return value;
}
