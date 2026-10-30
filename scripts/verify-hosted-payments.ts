import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash, randomBytes, randomUUID, sign, createPrivateKey } from "node:crypto";
import { Keypair, Transaction, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import pg from "pg";
import { phone, schemas, totalAllocations } from "@muuve/shared";
import { Chain } from "../apps/web/lib/server/solana/chain";
import { reconcileOperation } from "../apps/web/lib/server/operations";
import { closeDatabase } from "../apps/web/lib/server/db";
import { reviewCreateTransaction } from "./hosted-payment-review";

// This stage cannot sign a funding transaction, submit one, send SMS or request payouts.
const mode = process.argv.find((arg) => ["--preflight", "--prepare", "--cleanup"].includes(arg));
const privateFile = "keys/backend-payment-test.json";
const evidence: Record<string, any> = {
  started_at: new Date().toISOString(),
  mode,
  scope: "Hosted backend payment preflight/preparation only; no principal release",
  checks: [],
  requests: [],
  transactions_submitted: 0,
  sender_transactions_signed: 0,
  sms_requests: 0,
  payout_requests: 0,
};
const output = `evidence/backend-payment/${mode?.slice(2) ?? "invalid"}-${randomUUID()}.json`;
function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
let pool: pg.Pool | undefined;
let progress: any;
let api: ReturnType<typeof parseEnv>;
const save = () =>
  writeFile(privateFile, JSON.stringify(progress, null, 2) + "\n", { mode: 0o600 });
async function main() {
  assert(mode && process.argv.includes("--operator-approved-test-records"), "test_scope_required");
  const local = parseEnv(await readFile(".env.local", "utf8"));
  api = parseEnv(await readFile(".env.render-api", "utf8"));
  const worker = parseEnv(await readFile(".env.render-worker", "utf8"));
  const target = new URL(local.DATABASE_URL!);
  for (const env of [local, api, worker]) {
    const url = new URL(env.DATABASE_URL!);
    assert(
      url.hostname === "aws-0-eu-west-1.pooler.supabase.com" &&
        decodeURIComponent(url.username) === "postgres.yirelxmcveyxcqofzayq" &&
        url.port === "5432" &&
        url.pathname === "/postgres" &&
        url.searchParams.get("sslmode") === "verify-full" &&
        url.password === target.password &&
        env.SOLANA_CLUSTER === "devnet" &&
        env.PAYOUT_PROVIDER === "mock",
      "hosted_target_or_mock_policy_mismatch",
    );
    for (const key of [
      "MUUVE_PROGRAM_ID",
      "USDT_MINT",
      "TOKEN_PROGRAM_ID",
      "TREASURY_TOKEN_ACCOUNT",
      "MOCK_WEBHOOK_SECRET",
    ])
      assert(env[key] === local[key], "api_worker_configuration_mismatch");
  }
  assert(
    api.APP_BASE_URL === "https://muuve.onrender.com" &&
      api.APP_ENV === "preview" &&
      ["twilio", "textbee"].includes(api.OTP_PROVIDER ?? ""),
    "hosted_auth_policy_mismatch",
  );
  Object.assign(process.env, local);
  pool = new pg.Pool({
    connectionString: local.DATABASE_URL,
    options: "-c search_path=muuve,public",
    connectionTimeoutMillis: 15000,
    query_timeout: 15000,
    max: 1,
  });
  const manifest = JSON.parse(await readFile("config/devnet-public.json", "utf8"));
  const path = "keys/devnet/test-sender.json";
  assert(((await stat(path)).mode & 0o077) === 0, "private_sender_permissions_required");
  const sender = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, "utf8"))));
  assert(
    sender.publicKey.toBase58() === manifest.roles["test-sender"].public_key,
    "sender_mismatch",
  );
  const phonesFile = "keys/hosted-test-phones.json";
  assert(((await stat(phonesFile)).mode & 0o077) === 0, "private_phones_permissions_required");
  const phones = JSON.parse(await readFile(phonesFile, "utf8"));
  const recipients = [phones.wallet_recipient, phones.cashout_recipient];
  assert(
    phones.authorize_sms === true &&
      recipients.every((value) => phone.safeParse(value).success) &&
      new Set(recipients).size === 2,
    "two_distinct_authorized_recipient_numbers_required",
  );
  const chain = new Chain();
  // Reconciliation must never turn this preparatory tool into a submission path.
  chain.send = async () => {
    throw new Error("submission_forbidden_in_preparation_tool");
  };
  const config = await chain.readiness();
  const tokenBalance = await chain.balance(sender.publicKey.toBase58());
  const feeBalance = await chain.rpc((connection) =>
    connection.getBalance(chain.keys.payer.publicKey, "finalized"),
  );
  evidence.target = {
    api: api.APP_BASE_URL,
    database_project: "yirelxmcveyxcqofzayq",
    same_api_worker_database: true,
    cluster: "devnet",
    payouts: "mock",
  };
  evidence.chain = {
    program: chain.program.toBase58(),
    mint: config.mint,
    token_program: config.tokenProgram,
    treasury: config.treasury,
    sender: sender.publicKey.toBase58(),
    sender_balance_base_units: tokenBalance,
    fee_payer_lamports: feeBalance,
    claim_window_seconds: config.claimWindow,
    max_slot_base_units: config.maxSlot,
    max_link_base_units: config.maxLink,
  };
  const migrations = (await pool.query("SELECT name FROM public.muuve_migrations ORDER BY name"))
    .rows;
  assert(migrations.length === 6, "six_migrations_required");
  evidence.migrations = migrations.map((row) => row.name);
  const counts = (
    await pool.query(`SELECT
    (SELECT count(*)::int FROM operations WHERE state NOT IN ('finalized','failed')) AS active_operations,
    (SELECT count(*)::int FROM payouts) AS payouts,
    (SELECT count(*)::int FROM principals) AS principals,
    (SELECT count(*)::int FROM jobs WHERE state IN ('pending','running')) AS active_jobs,
    (SELECT count(*)::int FROM worker_schedules WHERE lease_until>now()) AS active_maintenance_leases`)
  ).rows[0];
  evidence.before = counts;
  evidence.authorized_recipient_count = 2;
  async function call(path: string, body?: unknown, jar: Record<string, string> = {}) {
    assert(
      [
        "/api/health",
        "/api/me",
        "/api/balance",
        "/api/auth/wallet/challenge",
        "/api/auth/wallet/login",
        "/api/auth/logout",
        "/api/links/prepare",
      ].includes(path),
      "path_outside_nonfinancial_test_scope",
    );
    const response = await fetch(api.APP_BASE_URL + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: api.APP_BASE_URL!,
        "content-type": "application/json",
        cookie: Object.entries(jar)
          .map(([key, value]) => `${key}=${value}`)
          .join("; "),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45000),
      redirect: "manual",
    });
    const data = await response.json();
    evidence.requests.push({
      path,
      status: response.status,
      ...(typeof data.error === "string" && /^[a-z_]+$/.test(data.error)
        ? { error: data.error }
        : {}),
    });
    assert(response.status === 200, `hosted_http_${response.status}`);
    for (const value of response.headers.getSetCookie()) {
      assert(
        value.includes("Secure") && value.includes("HttpOnly") && value.includes("SameSite=Lax"),
        "cookie_flags_required",
      );
      const pair = value.split(";")[0]!,
        split = pair.indexOf("=");
      const name = pair.slice(0, split),
        token = pair.slice(split + 1);
      if (token) jar[name] = token;
      else delete jar[name];
    }
    return data;
  }
  const health = await call("/api/health");
  assert(health.chain === "devnet" && health.payouts === "mock", "hosted_health_mismatch");
  const amounts = ["500000", "1000000"];
  assert(BigInt(tokenBalance) >= totalAllocations(amounts), "insufficient_test_token_balance");
  assert(feeBalance >= 20_000_000, "fee_payer_test_sol_required");
  if (mode === "--preflight") {
    assert(
      Object.values(counts).every((value) => value === 0),
      "existing_financial_work_requires_review",
    );
    evidence.state = "passed_readonly_backend_preflight";
    return;
  }
  try {
    assert(((await stat(privateFile)).mode & 0o077) === 0, "private_progress_permissions_required");
    progress = JSON.parse(await readFile(privateFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (mode === "--cleanup") {
    assert(
      progress?.operation_id && progress?.phase === "prepared_unsigned",
      "existing_unsigned_preparation_required",
    );
    const row = (
      await pool.query(
        "SELECT expected_signers FROM operations WHERE id=$1 AND link_id=$2 AND actor_user_id=$3",
        [progress.operation_id, progress.link_id, progress.user_id],
      )
    ).rows[0];
    assert(
      row?.expected_signers?.length === 1 &&
        row.expected_signers[0] === sender.publicKey.toBase58(),
      "client_signer_operation_required",
    );
    const tx = Transaction.from(Buffer.from(progress.tx, "base64"));
    assert(
      tx.signatures.find((entry) => entry.publicKey.equals(sender.publicKey))?.signature === null,
      "signed_transaction_cleanup_forbidden",
    );
    const height = await chain.rpc((connection) => connection.getBlockHeight("finalized"));
    assert(height > progress.last_valid_block_height + 32, "wait_for_finalized_blockhash_expiry");
    assert(!(await chain.link(progress.pda)), "chain_effect_requires_manual_reconciliation");
    const outcome = await reconcileOperation(progress.operation_id, chain);
    const after = (
      await pool.query("SELECT status,capacity_state,create_sig FROM links WHERE id=$1", [
        progress.link_id,
      ])
    ).rows[0];
    assert(
      outcome.state === "failed" &&
        after.status === "cancelled" &&
        after.capacity_state === "released" &&
        after.create_sig === null,
      "unsigned_preparation_cleanup_incomplete",
    );
    progress.phase = "cancelled_after_expiry";
    await save();
    evidence.cleanup = {
      operation_id: progress.operation_id,
      link_id: progress.link_id,
      ...after,
      onchain_account_exists: false,
    };
    evidence.state = "passed_unsigned_preparation_cleanup";
    return;
  }
  assert(!progress, "existing_payment_test_progress_preserved");
  assert(
    Object.values(counts).every((value) => value === 0),
    "existing_financial_work_requires_review",
  );
  const claim = Keypair.generate();
  progress = {
    origin: api.APP_BASE_URL!,
    sender: sender.publicKey.toBase58(),
    phase: "authenticating",
    cookies: {},
    link_id_hex: randomBytes(16).toString("hex"),
    claim_secret: [...claim.secretKey],
  };
  await save();
  try {
    const challenge = await call(
      "/api/auth/wallet/challenge",
      { wallet_address: progress.sender },
      progress.cookies,
    );
    assert(
      challenge.message.includes(`URI: ${api.APP_BASE_URL}\nVersion: 1\nChain ID: devnet`),
      "challenge_binding_mismatch",
    );
    const signature = bs58.encode(
      sign(
        null,
        Buffer.from(challenge.message, "utf8"),
        createPrivateKey({
          key: Buffer.concat([
            Buffer.from("302e020100300506032b657004220420", "hex"),
            sender.secretKey.slice(0, 32),
          ]),
          type: "pkcs8",
          format: "der",
        }),
      ),
    );
    const login = await call(
      "/api/auth/wallet/login",
      { challenge_id: challenge.challenge_id, signature },
      progress.cookies,
    );
    progress.user_id = login.user.id;
    await save();
    assert(login.user.wallet_address === progress.sender, "hosted_sender_wallet_mismatch");
    const body = schemas.create.parse({
      link_id_hex: progress.link_id_hex,
      claim_pubkey: claim.publicKey.toBase58(),
      note: "Backend-only devnet verification",
      recipients: recipients.map((number, index) => ({
        phone_e164: number,
        amount_base_units: amounts[index],
      })),
    });
    progress.phase = "preparation_requested";
    await save();
    const prepared = await call("/api/links/prepare", body, progress.cookies);
    Object.assign(progress, {
      operation_id: prepared.operation_id,
      link_id: prepared.link.id,
      tx: prepared.tx,
      blockhash: prepared.blockhash,
      last_valid_block_height: prepared.last_valid_block_height,
    });
    // Persist the receipt before further checks so an uncertain outcome cannot be discarded.
    await save();
    const review = reviewCreateTransaction(prepared.tx, {
      program: chain.program.toBase58(),
      payer: chain.keys.payer.publicKey.toBase58(),
      sender: progress.sender,
      mint: config.mint,
      tokenProgram: config.tokenProgram,
      linkIdHex: progress.link_id_hex,
      claimPublicKey: claim.publicKey.toBase58(),
      amounts,
      blockhash: prepared.blockhash,
    });
    progress.pda = review.link_pda;
    const slots = (
      await pool.query(
        "SELECT slot_index,recipient_phone_e164,amount_base_units FROM link_slots WHERE link_id=$1 ORDER BY slot_index",
        [progress.link_id],
      )
    ).rows;
    assert(
      slots.length === 2 &&
        slots.every(
          (slot, index) =>
            slot.slot_index === index &&
            slot.recipient_phone_e164 === recipients[index] &&
            slot.amount_base_units === amounts[index],
        ),
      "hosted_fixed_allocations_mismatch",
    );
    assert(!(await chain.link(review.link_pda)), "unexpected_funded_preparation");
    progress.phase = "prepared_unsigned";
    await save();
    evidence.review = {
      ...review,
      operation_id: progress.operation_id,
      link_id: progress.link_id,
      blockhash: progress.blockhash,
      last_valid_block_height: progress.last_valid_block_height,
      recipient_slots_verified_in_hosted_sql: true,
      claim_key_remained_local: true,
    };
    evidence.state = "passed_unsigned_hosted_preparation_awaiting_funding_approval";
  } finally {
    if (progress.cookies.muuve_session) {
      await call("/api/auth/logout", {}, progress.cookies);
      progress.cookies = {};
      await save();
    }
  }
}
try {
  await main();
} catch (error) {
  evidence.state = "blocked_or_failed";
  evidence.code =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "configuration_transport_or_verification_failure";
  process.exitCode = 1;
} finally {
  await pool?.end();
  await closeDatabase();
  evidence.finished_at = new Date().toISOString();
  await mkdir("evidence/backend-payment", { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  console.info(
    JSON.stringify({
      state: evidence.state,
      ...(evidence.code ? { code: evidence.code } : {}),
      evidence: output,
    }),
  );
}
