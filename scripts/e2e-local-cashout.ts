// Local end-to-end check of the recipient cash-out path against real devnet.
// Runs the API in-process on a disposable loopback database (see e2e-local.mjs) with
// mock OTP and mock payouts: a fresh sender signs in with a wallet, links a phone, gets
// test dollars, funds a link; the recipient verifies, cashes out to a mock bank and
// the worker completes the payout. With --keep, a second recipient keeps their share: they
// create a Muuve account and the server generates their Privy wallet (creates a real user
// in the configured Privy app). Never prints keys, cookies, codes or the claim secret.
import { createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { handle } from "../apps/web/lib/server/router";
import { runJobs } from "../apps/web/lib/server/jobs";
import { closeDatabase } from "../apps/web/lib/server/db";

function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
assert(process.env.SOLANA_CLUSTER === "devnet", "devnet_only");
assert(
  ["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL ?? "").hostname),
  "loopback_database_only",
);
assert(process.env.OTP_PROVIDER === "mock" && process.env.PAYOUT_PROVIDER === "mock", "mocks_only");

const BASE = process.env.APP_BASE_URL!;
const KEEP = process.argv.includes("--keep");
const SENDER_PHONE = "+2348030000101",
  RECIPIENT_PHONE = "+2348030000102",
  KEEPER_PHONE = "+2348030000103",
  AMOUNT = "1000000"; // $1.00 per recipient

class Client {
  cookies = new Map<string, string>();
  async call<T = any>(path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await handle(
      new Request(new URL(path, BASE), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: BASE,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.cookies.size
            ? { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }
            : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair!.indexOf("=");
      const value = pair!.slice(eq + 1);
      if (value) this.cookies.set(pair!.slice(0, eq), value);
      else this.cookies.delete(pair!.slice(0, eq));
    }
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`${path} → ${res.status} ${json.error ?? "unknown"}`);
    return json as T;
  }
}

function signMessage(keypair: Keypair, message: string) {
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(keypair.secretKey.slice(0, 32)),
    ]),
    format: "der",
    type: "pkcs8",
  });
  return bs58.encode(sign(null, Buffer.from(message, "utf8"), key));
}
function signTx(base64: string, keypair: Keypair) {
  const tx = Transaction.from(Buffer.from(base64, "base64"));
  tx.partialSign(keypair);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}
async function waitFor<T>(label: string, read: () => Promise<T | null>, timeoutMs = 180_000) {
  const started = Date.now();
  for (let delay = 1500; Date.now() - started < timeoutMs; delay = Math.min(delay * 1.4, 8000)) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`${label}_timeout`);
}
async function finalized(client: Client, operationId: string) {
  return waitFor(`operation_${operationId.slice(0, 8)}`, async () => {
    const { state } = await client.call<{ state: string }>(`/api/operations/${operationId}`);
    if (state === "failed") throw new Error("operation_failed");
    return state === "finalized" ? state : null;
  });
}
const step = (name: string, detail: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ step: name, ...detail }));

async function main() {
  const sender = new Client(),
    recipient = new Client(),
    wallet = Keypair.generate();

  // 1. Sender: wallet sign-in, then phone link (mock code), then test dollars.
  const challenge = await sender.call("/api/auth/wallet/challenge", {
    wallet_address: wallet.publicKey.toBase58(),
  });
  const login = await sender.call("/api/auth/wallet/login", {
    challenge_id: challenge.challenge_id,
    signature: signMessage(wallet, challenge.message),
  });
  assert(!login.user.phone_linked, "expected_unlinked_wallet_user");
  step("sender_signed_in", { wallet: wallet.publicKey.toBase58() });

  const blocked = await sender
    .call("/api/fund/demo", { amount_base_units: AMOUNT }, { "idempotency-key": randomUUID() })
    .then(() => null)
    .catch((e: Error) => e.message);
  assert(blocked?.includes("phone_required"), "funding_should_need_phone");
  const sent = await sender.call("/api/auth/otp/send", {
    phone_e164: SENDER_PHONE,
    channel: "sms",
    purpose: "account",
  });
  const linked = await sender.call("/api/me/phone", {
    challenge_id: sent.challenge_id,
    code: "000000",
  });
  assert(linked.user.phone_linked, "phone_not_linked");
  step("sender_phone_linked");

  const funding = await sender.call(
    "/api/fund/demo",
    { amount_base_units: KEEP ? "2000000" : AMOUNT },
    { "idempotency-key": randomUUID() },
  );
  await finalized(sender, funding.operation_id);
  step("sender_funded", { amount_base_units: AMOUNT });

  // 2. Sender funds a single-recipient link; the claim key stays in this process.
  const claimKey = Keypair.generate(),
    linkIdHex = randomBytes(16).toString("hex");
  const prepared = await sender.call("/api/links/prepare", {
    link_id_hex: linkIdHex,
    claim_pubkey: claimKey.publicKey.toBase58(),
    recipients: [
      { phone_e164: RECIPIENT_PHONE, amount_base_units: AMOUNT },
      ...(KEEP ? [{ phone_e164: KEEPER_PHONE, amount_base_units: AMOUNT }] : []),
    ],
  });
  await sender.call("/api/links/submit", {
    operation_id: prepared.operation_id,
    tx: signTx(prepared.tx, wallet),
    idempotency_key: randomUUID(),
  });
  await finalized(sender, prepared.operation_id);
  const linkId: string = prepared.link.id;
  await waitFor("link_open", async () => {
    const preview = await recipient.call(`/api/public/links/${linkId}`);
    return preview.status === "open" ? preview : null;
  });
  step("link_funded", { link_id: linkId });

  // 3. Recipient: verify by code, reserve the share for cash-out, pick a bank, confirm.
  const code = await recipient.call("/api/auth/otp/send", {
    phone_e164: RECIPIENT_PHONE,
    channel: "sms",
    purpose: "claim",
    link_id: linkId,
  });
  await recipient.call("/api/auth/otp/verify", { challenge_id: code.challenge_id, code: "000000" });
  const share = await recipient.call(`/api/claims/${linkId}/share`);
  assert(share.amount_base_units === AMOUNT, "share_amount_mismatch");
  step("recipient_verified", { status: share.status });

  const intent = await recipient.call(`/api/claims/${linkId}/intent/prepare`, {
    path: "cashout",
  });
  if (intent.state !== "finalized") {
    await recipient.call(`/api/claims/${linkId}/intent/submit`, {
      operation_id: intent.operation_id,
      tx: signTx(intent.tx, claimKey),
      idempotency_key: randomUUID(),
    });
    await finalized(recipient, intent.operation_id);
  }
  step("cashout_intent_finalized");

  const { banks } = await recipient.call("/api/banks");
  const bank = banks[0];
  const resolved = await recipient.call("/api/banks/resolve", {
    bank_code: bank.code,
    account_number: "0123456789",
  });
  const quote = await recipient.call(`/api/claims/${linkId}/cashout/quote`, {});
  const cashout = await recipient.call(`/api/claims/${linkId}/cashout/prepare`, {
    quote_id: quote.quote_id,
    bank_code: bank.code,
    account_number: "0123456789",
  });
  await recipient.call(`/api/claims/${linkId}/cashout/submit`, {
    operation_id: cashout.operation_id,
    tx: signTx(cashout.tx, claimKey),
    idempotency_key: randomUUID(),
  });
  await finalized(recipient, cashout.operation_id);
  step("cashout_finalized", {
    bank: bank.name,
    account_name: resolved.account_name,
    amount_ngn_kobo: quote.amount_ngn_kobo,
  });

  // 4. Worker dispatches the payout to the mock provider; poll until it settles.
  const payout = await waitFor("payout_settled", async () => {
    await runJobs({ maxJobs: 10, payoutIds: [cashout.payout.id] });
    const { payout } = await recipient.call(`/api/payouts/${cashout.payout.id}`);
    return ["paid", "failed", "resolved", "quarantined"].includes(payout.status) ? payout : null;
  });
  step("payout_settled", { status: payout.status, mock: payout.mock });
  assert(payout.status === "paid", "payout_not_paid");

  // 5. Optional: a second recipient keeps dollars in a new Muuve account.
  if (KEEP) {
    const keeper = new Client();
    const sentKeep = await keeper.call("/api/auth/otp/send", {
      phone_e164: KEEPER_PHONE,
      channel: "sms",
      purpose: "claim",
      link_id: linkId,
    });
    await keeper.call("/api/auth/otp/verify", {
      challenge_id: sentKeep.challenge_id,
      code: "000000",
    });
    const signedIn = await keeper
      .call("/api/me")
      .then(() => true)
      .catch(() => false);
    assert(!signedIn, "keeper_should_not_have_account_yet");
    await keeper.call("/api/auth/signup", { display_name: "Keep Tester", origin: "muuve" });
    const { wallet_address } = await keeper.call("/api/auth/wallet/embedded", {});
    step("keeper_account_created", { wallet: wallet_address });
    const keepIntent = await keeper.call(`/api/claims/${linkId}/intent/prepare`, { path: "keep" });
    if (keepIntent.state !== "finalized") {
      await keeper.call(`/api/claims/${linkId}/intent/submit`, {
        operation_id: keepIntent.operation_id,
        tx: signTx(keepIntent.tx, claimKey),
        idempotency_key: randomUUID(),
      });
      await finalized(keeper, keepIntent.operation_id);
    }
    const kept = await keeper.call(`/api/claims/${linkId}/keep/prepare`, {});
    if (!kept.done) {
      await keeper.call(`/api/claims/${linkId}/keep/submit`, {
        operation_id: kept.operation_id,
        tx: signTx(kept.tx, claimKey),
        idempotency_key: randomUUID(),
      });
      await finalized(keeper, kept.operation_id);
    }
    const keptShare = await keeper.call(`/api/claims/${linkId}/share`);
    const balance = await keeper.call("/api/balance");
    step("kept", { slot_status: keptShare.status, balance_base_units: balance.amount_base_units });
    assert(keptShare.status === "kept", "share_not_kept");
  }

  const final = await recipient.call(`/api/claims/${linkId}/share`);
  const detail = await sender.call(`/api/links/${linkId}`);
  step("done", { slot_status: final.status, link_status: detail.link?.status ?? detail.status });
}

main()
  .then(() => closeDatabase())
  .catch(async (error) => {
    console.error(JSON.stringify({ step: "failed", error: String(error?.message ?? error) }));
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
