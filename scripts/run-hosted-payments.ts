import { readFile, writeFile, rename, mkdir, stat, open, unlink } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID, randomBytes, sign, createPrivateKey } from "node:crypto";
import { Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import bs58 from "bs58";
import pg from "pg";
import { setTimeout as pause } from "node:timers/promises";
import { Chain, ata } from "../apps/web/lib/server/solana/chain";
import { reconcileOperation, prepareReplacement } from "../apps/web/lib/server/operations";
import { closeDatabase } from "../apps/web/lib/server/db";
import { reviewCreateTransaction } from "./hosted-payment-review";
import { hostedTestFetch } from "./hosted-test-http";

const file = "keys/backend-payment-run.json";
const action = process.argv.find((value) =>
  /^--(?:fund-main|recall-fixture|expiry-fixture|send-otp=[ab]|resend-otp=[ab]|verify-otp=[ab]|claim=[ab]|retry-b|negative-auth|status|logout)$/.test(
    value,
  ),
);
const evidence: Record<string, any> = {
  started_at: new Date().toISOString(),
  action,
  requests: [],
  checks: [],
  transactions: [],
  state: "running",
  http_transport: "curl_ipv4_verified_tls_no_retries",
};
const output = `evidence/backend-payment/run-${action?.slice(2).replace("=", "-") ?? "invalid"}-${randomUUID()}.json`;
let progress: any;
let pool: pg.Pool | undefined;
let api: ReturnType<typeof parseEnv>;
let lock: Awaited<ReturnType<typeof open>> | undefined;
function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
async function save() {
  await writeFile(file + ".tmp", JSON.stringify(progress, null, 2) + "\n", { mode: 0o600 });
  await rename(file + ".tmp", file);
}
async function main() {
  try {
    lock = await open(file + ".lock", "wx", 0o600);
    await lock.writeFile(String(process.pid));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("payment_stage_already_running_reconcile_stale_lock_before_retry");
    throw error;
  }
  assert(
    action &&
      process.argv.includes("--operator-approved-test-budget") &&
      process.env.OPERATOR_APPROVED_DEVNET === "1" &&
      process.env.MUUVE_RUN_DEVNET_TRANSACTIONS === "1",
    "explicit_approved_devnet_test_required",
  );
  const approval = JSON.parse(await readFile("evidence/backend-payment/approval.json", "utf8"));
  assert(
    approval.max_new_funding_base_units === "1900000" &&
      approval.max_fee_and_rent_lamports === 50000000 &&
      approval.cluster === "devnet" &&
      approval.payouts === "mock",
    "approved_budget_required",
  );
  const local = parseEnv(await readFile(".env.local", "utf8"));
  api = parseEnv(await readFile(".env.render-api", "utf8"));
  const target = new URL(local.DATABASE_URL!),
    remote = new URL(api.DATABASE_URL!);
  assert(
    target.hostname === "aws-0-eu-west-1.pooler.supabase.com" &&
      decodeURIComponent(target.username) === "postgres.yirelxmcveyxcqofzayq" &&
      target.pathname === "/postgres" &&
      target.port === "5432" &&
      target.searchParams.get("sslmode") === "verify-full" &&
      target.hostname === remote.hostname &&
      target.password === remote.password &&
      target.username === remote.username,
    "hosted_database_mismatch",
  );
  assert(
    api.APP_BASE_URL === "https://muuve.onrender.com" &&
      api.SOLANA_CLUSTER === "devnet" &&
      api.PAYOUT_PROVIDER === "mock" &&
      ["twilio", "textbee"].includes(api.OTP_PROVIDER ?? "") &&
      local.SOLANA_CLUSTER === "devnet" &&
      local.PAYOUT_PROVIDER === "mock",
    "hosted_policy_mismatch",
  );
  for (const name of [
    "MUUVE_PROGRAM_ID",
    "USDT_MINT",
    "TOKEN_PROGRAM_ID",
    "TREASURY_TOKEN_ACCOUNT",
  ])
    assert(local[name] === api[name], "public_configuration_mismatch");
  Object.assign(process.env, local);
  pool = new pg.Pool({
    connectionString: local.DATABASE_URL,
    options: "-c search_path=muuve,public",
    connectionTimeoutMillis: 15000,
    query_timeout: 15000,
    max: 1,
  });
  const manifest = JSON.parse(await readFile("config/devnet-public.json", "utf8"));
  const senderFile = "keys/devnet/test-sender.json";
  assert(((await stat(senderFile)).mode & 0o077) === 0, "private_sender_permissions_required");
  const sender = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(await readFile(senderFile, "utf8"))),
  );
  assert(
    sender.publicKey.toBase58() === manifest.roles["test-sender"].public_key,
    "sender_mismatch",
  );
  const phoneFile = "keys/hosted-test-phones.json";
  assert(((await stat(phoneFile)).mode & 0o077) === 0, "phone_file_permissions_required");
  const phones = JSON.parse(await readFile(phoneFile, "utf8"));
  assert(
    phones.authorize_sms === true &&
      phones.wallet_recipient &&
      phones.cashout_recipient &&
      phones.wallet_recipient !== phones.cashout_recipient,
    "authorized_recipient_numbers_required",
  );
  const chain = new Chain();
  chain.send = async () => {
    throw new Error("all_financial_submissions_must_use_hosted_api");
  };
  evidence.stage = "devnet_readiness";
  const config = await chain.readiness();
  try {
    assert(((await stat(file)).mode & 0o077) === 0, "private_progress_permissions_required");
    progress = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    assert(action === "--fund-main", "start_with_main_fixture");
    progress = {
      origin: api.APP_BASE_URL,
      sender: sender.publicKey.toBase58(),
      fixtures: {},
      cookies: {},
      funding_reserved: "0",
      fee_reservations: {},
      submissions: {},
      roles: {
        a: { phone: phones.wallet_recipient, cookies: {}, code: "" },
        b: { phone: phones.cashout_recipient, cookies: {}, code: "" },
      },
    };
    await save();
  }
  assert(
    progress.origin === api.APP_BASE_URL &&
      progress.sender === sender.publicKey.toBase58() &&
      progress.roles.a.phone === phones.wallet_recipient &&
      progress.roles.b.phone === phones.cashout_recipient,
    "private_progress_identity_mismatch",
  );
  async function call(path: string, body?: unknown, jar = progress.cookies, expected = 200) {
    evidence.stage = path;
    assert(!/^\/api\/(fund|cron)\//.test(path), "funding_mints_and_global_cron_forbidden");
    assert(
      /^\/api\/(?:health|me|auth\/(?:wallet\/(?:challenge|login)|logout|otp\/(?:send|verify))|links(?:\/.*)?|operations\/[^/]+|public\/links\/[^/]+|claims\/[^/]+\/(?:share|intent\/(?:prepare|submit)|cashout\/(?:quote|prepare|submit|retry))|payouts\/[^/]+|webhooks\/payout)$/.test(
        path,
      ),
      "path_outside_payment_test_scope",
    );
    const response = await hostedTestFetch(api.APP_BASE_URL + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: api.APP_BASE_URL!,
        "content-type": "application/json",
        cookie: Object.entries(jar)
          .map(([name, value]) => `${name}=${value}`)
          .join("; "),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(45000),
      redirect: "manual",
    });
    const request: Record<string, unknown> = { path, status: response.status };
    evidence.requests.push(request);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`non_json_http_${response.status}`);
    }
    if (typeof data.error === "string" && /^[a-z_]+$/.test(data.error)) request.error = data.error;
    assert(response.status === expected, `hosted_http_${response.status}`);
    for (const value of response.headers.getSetCookie()) {
      assert(
        value.includes("HttpOnly") && value.includes("Secure") && value.includes("SameSite=Lax"),
        "cookie_flags_required",
      );
      const pair = value.split(";")[0]!,
        index = pair.indexOf("="),
        name = pair.slice(0, index),
        token = pair.slice(index + 1);
      if (token) jar[name] = token;
      else delete jar[name];
    }
    await save();
    return data;
  }
  async function login() {
    evidence.stage = "sender_session_check";
    if (progress.cookies.muuve_session) {
      const response = await hostedTestFetch(api.APP_BASE_URL + "/api/me", {
        headers: {
          cookie: Object.entries(progress.cookies)
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
        },
        signal: AbortSignal.timeout(45000),
      });
      if (response.status === 200) {
        let me;
        try {
          me = await response.json();
        } catch {
          throw new Error(`non_json_session_http_${response.status}`);
        }
        assert(
          me.user.id === progress.user_id && me.user.wallet_address === progress.sender,
          "sender_session_mismatch",
        );
        return;
      }
      assert(response.status === 401, "sender_session_check_failed");
      progress.cookies = {};
      await save();
    }
    const challenge = await call("/api/auth/wallet/challenge", { wallet_address: progress.sender });
    assert(
      challenge.message.includes(`URI: ${api.APP_BASE_URL}\nVersion: 1\nChain ID: devnet`) &&
        challenge.message.includes(progress.sender),
      "challenge_binding_mismatch",
    );
    const key = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        sender.secretKey.slice(0, 32),
      ]),
      type: "pkcs8",
      format: "der",
    });
    const signature = bs58.encode(sign(null, Buffer.from(challenge.message, "utf8"), key));
    const result = await call("/api/auth/wallet/login", {
      challenge_id: challenge.challenge_id,
      signature,
    });
    assert(result.user.wallet_address === progress.sender, "sender_wallet_mismatch");
    progress.user_id = result.user.id;
    await save();
  }
  function reserveFee(id: string, amount: number) {
    if (progress.fee_reservations[id]) return;
    const used = Object.values(progress.fee_reservations).reduce<number>(
      (sum, value) => sum + Number(value),
      0,
    );
    assert(used + amount <= 50000000, "approved_fee_budget_exhausted");
    progress.fee_reservations[id] = amount;
  }
  async function finishOperation(id: string, signature: string) {
    for (let attempt = 0; attempt < 25; attempt++) {
      const status = await chain.status(signature);
      if (status?.confirmationStatus === "finalized") {
        assert(!status.err, "finalized_chain_transaction_failed");
        const receipt = await chain.rpc((connection) =>
          connection.getTransaction(signature, {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          }),
        );
        assert(receipt?.meta && !receipt.meta.err, "successful_finalized_receipt_required");
        await reconcileOperation(id, chain);
        const row = (await pool!.query("SELECT state FROM operations WHERE id=$1", [id])).rows[0];
        assert(row?.state === "finalized", "hosted_sql_finalization_incomplete");
        const spent = receipt.meta.preBalances[0]! - receipt.meta.postBalances[0]!;
        assert(
          Math.max(receipt.meta.fee, spent) <= progress.fee_reservations[id],
          "fee_or_rent_exceeded_reservation",
        );
        const record = {
          operation_id: id,
          signature,
          explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
          commitment: "finalized",
          chain_error: null,
          fee_lamports: receipt.meta.fee,
          payer_net_debit_lamports: spent,
          hosted_operation_state: row.state,
        };
        progress.submissions[id].state = "finalized";
        progress.submissions[id].receipt = record;
        await save();
        evidence.transactions.push(record);
        return;
      }
      if (attempt < 24) await pause(2000);
    }
    throw new Error("transaction_outcome_unresolved_reconcile_before_retry");
  }
  async function submit(
    path: string,
    prepared: any,
    key: Keypair,
    jar: any,
    fixture: any,
    kind: string,
    index?: number,
  ) {
    const id = prepared.operation_id;
    const old = progress.submissions[id];
    if (old) {
      await finishOperation(id, old.signature);
      return old;
    }
    const owned = (await pool!.query("SELECT kind,link_id FROM operations WHERE id=$1", [id]))
      .rows[0];
    assert(owned?.kind === kind && owned.link_id === fixture.id, "operation_scope_mismatch");
    let transaction = Transaction.from(Buffer.from(prepared.tx, "base64"));
    const height = await chain.height();
    if (height >= prepared.last_valid_block_height - 12) {
      // No client signature has been issued. Reconcile before preparing a fresh stored attempt.
      const status = await chain.status(prepared.signature);
      assert(!status, "prepared_transaction_already_visible_reconcile_first");
      prepared = { ...(await prepareReplacement(id, chain)), operation_id: id };
      prepared = await call(`/api/operations/${id}`, undefined, jar);
      assert(prepared.state !== "held", "replacement_not_submittable");
      transaction = Transaction.from(Buffer.from(prepared.tx, "base64"));
    }
    if (kind === "create") {
      reviewCreateTransaction(prepared.tx, {
        program: chain.program.toBase58(),
        payer: chain.keys.payer.publicKey.toBase58(),
        sender: progress.sender,
        mint: config.mint,
        tokenProgram: config.tokenProgram,
        linkIdHex: fixture.local_id,
        claimPublicKey: Keypair.fromSecretKey(
          Uint8Array.from(fixture.claim_secret),
        ).publicKey.toBase58(),
        amounts: fixture.amounts,
        blockhash: prepared.blockhash,
      });
      const rent = await chain.rpc(
        async (connection) =>
          (await connection.getMinimumBalanceForRentExemption(1047)) +
          (await connection.getMinimumBalanceForRentExemption(165)) +
          ((await connection.getFeeForMessage(transaction.compileMessage(), "finalized")).value ??
            1000000),
      );
      assert(rent <= 12000000, "create_rent_or_fee_above_budget");
    } else {
      const state = await chain.link(fixture.pda);
      assert(state, "funded_link_required");
      let expected;
      if (kind === "intent")
        expected = await chain.intent(
          fixture.pda,
          state,
          index!,
          transaction.instructions[1]!.data.subarray(9, 25).toString("hex"),
          "cashout",
        );
      else
        expected = await chain.settle(
          fixture.pda,
          state,
          kind === "claim_cashout" ? "claim_cashout" : "recall",
          index,
          kind === "claim_cashout" ? state.treasuryOwner : undefined,
        );
      const wanted = Transaction.from(Buffer.from(expected.tx, "base64"));
      assert(
        transaction.instructions.length === wanted.instructions.length &&
          transaction.feePayer?.equals(chain.keys.payer.publicKey),
        "unexpected_payment_instructions",
      );
      for (const position of [0, 1]) {
        const actual = transaction.instructions[position]!,
          targetIx = wanted.instructions[position]!;
        assert(
          actual.programId.equals(targetIx.programId) &&
            actual.data.equals(targetIx.data) &&
            actual.keys.length === targetIx.keys.length &&
            actual.keys.every(
              (account, at) =>
                account.pubkey.equals(targetIx.keys[at]!.pubkey) &&
                account.isSigner === targetIx.keys[at]!.isSigner &&
                account.isWritable === targetIx.keys[at]!.isWritable,
            ),
          "payment_destination_or_terms_mismatch",
        );
      }
      const memo = transaction.instructions[2]!;
      assert(
        memo.programId.equals(wanted.instructions[2]!.programId) &&
          memo.keys.length === 0 &&
          /^[0-9a-f-]{36}$/.test(memo.data.toString()),
        "unexpected_payment_memo",
      );
      assert(
        transaction.verifySignatures(false) &&
          transaction.signatures.find((entry) => entry.publicKey.equals(key.publicKey))
            ?.signature === null,
        "invalid_or_preexisting_client_signature",
      );
      const fee = await chain.rpc((connection) =>
        connection.getFeeForMessage(transaction.compileMessage(), "finalized"),
      );
      assert(fee.value !== null && fee.value <= 250000, "settlement_fee_above_budget");
    }
    reserveFee(id, kind === "create" ? 12000000 : 250000);
    await save();
    transaction.partialSign(key);
    assert(transaction.verifySignatures(true), "fully_signed_transaction_required");
    const signed = transaction.serialize().toString("base64"),
      signature = bs58.encode(transaction.signatures[0]!.signature!);
    const record = {
      operation_id: id,
      signature,
      tx: signed,
      idempotency_key: `backend-test-${id}`,
      state: "signed_not_submitted",
    };
    progress.submissions[id] = record;
    await save();
    record.state = "submission_started";
    await save();
    await call(
      path,
      { operation_id: id, tx: signed, idempotency_key: record.idempotency_key },
      jar,
    );
    await finishOperation(id, signature);
    return record;
  }
  async function fund(name: "main" | "recall" | "expiry", amounts: string[]) {
    await login();
    let fixture = progress.fixtures[name];
    if (!fixture) {
      const amount = amounts.reduce((sum, value) => sum + BigInt(value), 0n);
      assert(
        BigInt(progress.funding_reserved) + amount <= 1900000n,
        "approved_token_budget_exhausted",
      );
      assert(
        BigInt(await chain.balance(progress.sender)) >= amount,
        "insufficient_prefunded_tokens",
      );
      fixture = {
        local_id: randomBytes(16).toString("hex"),
        claim_secret: [...Keypair.generate().secretKey],
        amounts,
        phase: "new",
      };
      progress.fixtures[name] = fixture;
      progress.funding_reserved = (BigInt(progress.funding_reserved) + amount).toString();
      await save();
    }
    if (!fixture.prepared) {
      const claim = Keypair.fromSecretKey(Uint8Array.from(fixture.claim_secret));
      const data = await call("/api/links/prepare", {
        link_id_hex: fixture.local_id,
        claim_pubkey: claim.publicKey.toBase58(),
        note: `Backend devnet ${name} fixture`,
        recipients: ["a", "b"].map((role, index) => ({
          phone_e164: progress.roles[role].phone,
          amount_base_units: amounts[index],
        })),
      });
      fixture.prepared = data;
      fixture.id = data.link.id;
      fixture.pda = PublicKey.findProgramAddressSync(
        [Buffer.from("link"), sender.publicKey.toBuffer(), Buffer.from(fixture.local_id, "hex")],
        chain.program,
      )[0].toBase58();
      await save();
    }
    await submit(
      "/api/links/submit",
      fixture.prepared,
      sender,
      progress.cookies,
      fixture,
      "create",
    );
    const link = await chain.link(fixture.pda);
    assert(link, "funded_link_missing");
    assert(
      link?.sender === progress.sender &&
        link.total === amounts.reduce((sum, value) => sum + BigInt(value), 0n).toString() &&
        link.slotCount === 2 &&
        link.openSlots === 2 &&
        link.slots.every((slot, index) => slot.status === 1 && slot.amount === amounts[index]) &&
        [172800, 240].includes(link.expiresAt - link.createdAt),
      "funded_chain_state_mismatch",
    );
    const db = await call(`/api/links/${fixture.id}`);
    assert(
      db.link.status === "open" &&
        db.link.slots.every(
          (slot: any, index: number) =>
            slot.status === "funded" && slot.amount_base_units === amounts[index],
        ) &&
        new Date(db.link.expires_at).getTime() === link.expiresAt * 1000,
      "funded_hosted_sql_mismatch",
    );
    const vaultBalance = await chain.rpc((connection) =>
      connection.getTokenAccountBalance(
        ata(fixture.pda, config.mint, config.tokenProgram),
        "finalized",
      ),
    );
    assert(vaultBalance.value.amount === link.total, "funded_vault_balance_mismatch");
    fixture.phase = "funded";
    fixture.expires_at = new Date(link.expiresAt * 1000).toISOString();
    await save();
    evidence.fixture = {
      name,
      id: fixture.id,
      pda: fixture.pda,
      amounts,
      expires_at: fixture.expires_at,
      vault_balance_base_units: vaultBalance.value.amount,
    };
    return fixture;
  }
  if (action === "--fund-main") {
    const fixture = await fund("main", ["500000", "1000000"]);
    const signed = progress.submissions[fixture.prepared.operation_id];
    await call("/api/links/submit", {
      operation_id: signed.operation_id,
      tx: signed.tx,
      idempotency_key: signed.idempotency_key,
    });
    const preview = await call(`/api/public/links/${fixture.id}`, undefined, {});
    assert(
      !("slots" in preview) && !("slot_count" in preview) && !("amount_base_units" in preview),
      "public_batch_membership_leaked",
    );
    await call(`/api/claims/${fixture.id}/share`, undefined, progress.cookies, 401);
    evidence.checks.push(
      "funding_replay_idempotent",
      "batch_preview_private",
      "sender_wallet_session_is_not_claim_proof",
    );
  } else if (action.startsWith("--send-otp=") || action.startsWith("--resend-otp=")) {
    const role = action.slice(-1),
      entry = progress.roles[role],
      fixture = progress.fixtures.main;
    if (action.startsWith("--resend-otp=")) {
      assert(entry.send_started_at && (entry.resends ?? 0) === 0, "one_scoped_resend_only");
      const previous = (
        await pool.query(
          `SELECT id,status,provider_ref IS NOT NULL AS provider_reference_present,expires_at<=now() AS expired
         FROM otp_challenges WHERE link_id=$1 AND phone_e164=$2 AND created_at>=$3::timestamptz-interval '2 seconds'
         ORDER BY created_at DESC`,
          [fixture.id, entry.phone, entry.send_started_at],
        )
      ).rows;
      assert(
        previous.length === 1 &&
          ((previous[0].expired && previous[0].status !== "verified") ||
            (previous[0].status === "failed" && !previous[0].provider_reference_present)),
        "prior_otp_outcome_requires_manual_reconciliation",
      );
      entry.challenge_history ??= [];
      entry.challenge_history.push({
        id: previous[0].id,
        status: previous[0].status,
        expired: previous[0].expired,
      });
      entry.resends = 1;
      delete entry.challenge_id;
      delete entry.send_started_at;
      await save();
    }
    assert(
      fixture?.phase === "funded" && !entry.challenge_id && !entry.send_started_at,
      "fresh_recipient_challenge_required",
    );
    entry.send_started_at = new Date().toISOString();
    await save();
    const response = await call(
      "/api/auth/otp/send",
      { phone_e164: entry.phone, channel: "sms", purpose: "claim", link_id: fixture.id },
      entry.cookies,
    );
    entry.challenge_id = response.challenge_id;
    entry.code = "";
    entry.state = "awaiting_private_code";
    await save();
    try {
      await writeFile(
        "keys/backend-payment-otp.json",
        JSON.stringify({ a: "", b: "" }, null, 2) + "\n",
        { mode: 0o600, flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    evidence.role = role;
    evidence.state = "awaiting_private_otp_code";
    evidence.private_code_location = `keys/backend-payment-otp.json:${role}`;
    return;
  } else if (action.startsWith("--verify-otp=")) {
    const role = action.slice(-1),
      entry = progress.roles[role],
      fixture = progress.fixtures.main;
    assert(
      ((await stat("keys/backend-payment-otp.json")).mode & 0o077) === 0,
      "private_code_permissions_required",
    );
    const codes = JSON.parse(await readFile("keys/backend-payment-otp.json", "utf8"));
    assert(
      entry.state === "awaiting_private_code" && /^\d{6}$/.test(codes[role]),
      "private_owner_code_required",
    );
    const code = codes[role];
    entry.code = "";
    await save();
    await call("/api/auth/otp/verify", { challenge_id: entry.challenge_id, code }, entry.cookies);
    const share = await call(`/api/claims/${fixture.id}/share`, undefined, entry.cookies);
    const index = role === "a" ? 0 : 1;
    assert(
      share.slot_index === index &&
        share.amount_base_units === fixture.amounts[index] &&
        !Object.keys(share).some((name) => /phone|recipients|slots/.test(name)),
      "verified_share_mismatch_or_privacy_leak",
    );
    await call(
      `/api/claims/${fixture.id}/intent/prepare`,
      { path: "cashout", slot_index: 1 - index },
      entry.cookies,
      400,
    );
    entry.state = "phone_verified";
    await save();
    evidence.role = role;
    evidence.checks.push(
      "actual_recipient_phone_and_exact_slot_verified",
      "client_slot_override_rejected",
    );
  } else if (action.startsWith("--claim=")) {
    const role = action.slice(-1),
      entry = progress.roles[role],
      fixture = progress.fixtures.main,
      index = role === "a" ? 0 : 1;
    assert(entry.state === "phone_verified", "real_recipient_phone_session_required");
    const claim = Keypair.fromSecretKey(Uint8Array.from(fixture.claim_secret));
    entry.intent ??= await call(
      `/api/claims/${fixture.id}/intent/prepare`,
      { path: "cashout" },
      entry.cookies,
    );
    await save();
    await submit(
      `/api/claims/${fixture.id}/intent/submit`,
      entry.intent,
      claim,
      entry.cookies,
      fixture,
      "intent",
      index,
    );
    const intended = await chain.link(fixture.pda);
    assert(
      intended?.slots[index]?.toTreasury &&
        intended.slots[index]!.destination === config.treasury &&
        intended.slots[index]!.version !== "0",
      "treasury_intent_not_finalized",
    );
    entry.quote ??= await call(`/api/claims/${fixture.id}/cashout/quote`, {}, entry.cookies);
    await save();
    entry.payout ??= await call(
      `/api/claims/${fixture.id}/cashout/prepare`,
      {
        quote_id: entry.quote.quote_id,
        bank_code: "100004",
        account_number: role === "a" ? "1234567890" : "1234560000",
      },
      entry.cookies,
    );
    await save();
    await submit(
      `/api/claims/${fixture.id}/cashout/submit`,
      entry.payout,
      claim,
      entry.cookies,
      fixture,
      "claim_cashout",
      index,
    );
    const cached = progress.submissions[entry.payout.operation_id];
    const duplicates = await Promise.all(
      [0, 1].map(() =>
        call(
          `/api/claims/${fixture.id}/cashout/submit`,
          {
            operation_id: cached.operation_id,
            tx: cached.tx,
            idempotency_key: cached.idempotency_key,
          },
          entry.cookies,
        ),
      ),
    );
    assert(
      duplicates.every((value) => value.state === "finalized"),
      "duplicate_claim_not_terminal",
    );
    const state = await chain.link(fixture.pda);
    assert(state?.slots[index]?.status === 2, "slot_not_claimed_onchain");
    const remaining = state.slots[1 - index]!;
    evidence.checks.push(
      "exact_treasury_destination",
      "duplicate_claims_return_same_finalized_operation",
    );
    evidence.other_slot = { amount_base_units: remaining.amount, status: remaining.status };
    entry.state = "treasury_claim_finalized";
    await save();
    evidence.payout_id = entry.payout.payout.id;
  } else if (action === "--retry-b") {
    const entry = progress.roles.b,
      fixture = progress.fixtures.main;
    assert(entry.state === "treasury_claim_finalized", "treasury_claim_required");
    if (!entry.retry) {
      const quote = await call(
        `/api/claims/${fixture.id}/cashout/quote`,
        { retry_of: entry.payout.payout.id },
        entry.cookies,
      );
      entry.retry = {
        quote_id: quote.quote_id,
        bank_code: "100004",
        account_number: "1234567890",
        idempotency_key: `retry-${randomUUID()}`,
      };
      await save();
    }
    const first = await call(`/api/claims/${fixture.id}/cashout/retry`, entry.retry, entry.cookies);
    const second = await call(
      `/api/claims/${fixture.id}/cashout/retry`,
      entry.retry,
      entry.cookies,
    );
    assert(first.payout.id === second.payout.id, "mock_retry_not_idempotent");
    entry.retry_payout_id = first.payout.id;
    await save();
    evidence.payout_id = first.payout.id;
    evidence.checks.push("failed_mock_payout_retry_reused_identity_no_chain_transfer");
  } else if (action === "--recall-fixture") {
    const fixture = await fund("recall", ["100000", "100000"]);
    for (const index of [0, undefined]) {
      const prepared = await call(
        `/api/links/${fixture.id}/recall/prepare`,
        index === undefined ? {} : { slot_index: index },
      );
      await submit(
        `/api/links/${fixture.id}/recall/submit`,
        prepared,
        sender,
        progress.cookies,
        fixture,
        "recall",
        index,
      );
    }
    const state = await chain.link(fixture.pda);
    assert(
      state?.openSlots === 0 && state.slots.every((slot) => slot.status === 3),
      "recall_state_mismatch",
    );
    const vault = await chain.rpc((connection) =>
      connection.getAccountInfo(ata(fixture.pda, config.mint, config.tokenProgram), "finalized"),
    );
    assert(vault === null, "recalled_vault_not_closed");
    evidence.checks.push("recall_one_and_all_to_original_sender", "recall_vault_closed");
    fixture.phase = "recalled";
    await save();
  } else if (action === "--expiry-fixture") {
    const fixture = await fund("expiry", ["100000", "100000"]);
    reserveFee("future_expiry", 250000);
    await save();
    evidence.expiry = {
      id: fixture.id,
      pda: fixture.pda,
      expires_at: fixture.expires_at,
      result: "funded_waiting_for_real_48_hour_deadline",
    };
  } else if (action === "--negative-auth") {
    const fixture = progress.fixtures.main;
    const path = "keys/devnet/test-recipient.json";
    assert(((await stat(path)).mode & 0o077) === 0, "foreign_test_key_permissions_required");
    const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, "utf8"))));
    assert(
      key.publicKey.toBase58() === manifest.roles["test-recipient"].public_key,
      "foreign_test_wallet_mismatch",
    );
    progress.foreign ??= { cookies: {} };
    const jar = progress.foreign.cookies;
    try {
      const challenge = await call(
        "/api/auth/wallet/challenge",
        { wallet_address: key.publicKey.toBase58() },
        jar,
      );
      assert(
        challenge.message.includes(`URI: ${api.APP_BASE_URL}\nVersion: 1\nChain ID: devnet`),
        "foreign_challenge_binding_mismatch",
      );
      const signer = createPrivateKey({
        key: Buffer.concat([
          Buffer.from("302e020100300506032b657004220420", "hex"),
          key.secretKey.slice(0, 32),
        ]),
        type: "pkcs8",
        format: "der",
      });
      const signed = bs58.encode(sign(null, Buffer.from(challenge.message, "utf8"), signer));
      const user = await call(
        "/api/auth/wallet/login",
        { challenge_id: challenge.challenge_id, signature: signed },
        jar,
      );
      assert(
        user.user.wallet_address === key.publicKey.toBase58(),
        "foreign_wallet_proof_mismatch",
      );
      progress.foreign.user_id = user.user.id;
      await save();
      await call(`/api/links/${fixture.id}`, undefined, jar, 404);
      await call(`/api/links/${fixture.id}/recall/prepare`, {}, jar, 404);
    } finally {
      if (jar.muuve_session) await call("/api/auth/logout", {}, jar);
      progress.foreign.cookies = {};
      await save();
    }
    await login();
    await call(`/api/links/${fixture.id}/recall/prepare`, { slot_index: 2 }, progress.cookies, 400);
    await call(
      `/api/links/${fixture.id}/recall/prepare`,
      { slot_index: 0, refund_destination: key.publicKey.toBase58() },
      progress.cookies,
      400,
    );
    await call(
      `/api/claims/${fixture.id}/intent/prepare`,
      { path: "cashout" },
      progress.cookies,
      401,
    );
    evidence.checks.push(
      "foreign_sender_cannot_read_or_recall_funded_link",
      "out_of_range_slot_rejected",
      "client_refund_redirect_rejected",
      "sender_wallet_cannot_authorize_claim_intent_without_otp",
    );
  } else if (action === "--logout") {
    for (const jar of [progress.cookies, progress.roles.a.cookies, progress.roles.b.cookies])
      if (Object.keys(jar).length) await call("/api/auth/logout", {}, jar);
    progress.cookies = {};
    progress.roles.a.cookies = {};
    progress.roles.b.cookies = {};
    progress.roles.a.code = "";
    progress.roles.b.code = "";
    await save();
  }
  const ids = Object.values(progress.fixtures)
    .map((fixture: any) => fixture.id)
    .filter(Boolean);
  evidence.database = {
    links: (
      await pool.query(
        "SELECT id,status,total_base_units,expires_at,capacity_state FROM links WHERE id=ANY($1::uuid[]) ORDER BY created_at",
        [ids],
      )
    ).rows,
    slots: (
      await pool.query(
        "SELECT link_id,slot_index,amount_base_units,status FROM link_slots WHERE link_id=ANY($1::uuid[]) ORDER BY link_id,slot_index",
        [ids],
      )
    ).rows,
    payouts: (
      await pool.query(
        "SELECT p.id,p.status,p.resolution,p.retry_of FROM payouts p JOIN principals r ON r.id=p.principal_id JOIN link_slots s ON s.id=r.link_slot_id WHERE s.link_id=ANY($1::uuid[])",
        [ids],
      )
    ).rows,
  };
  evidence.budget = {
    funding_reserved_base_units: progress.funding_reserved,
    fee_and_rent_reserved_lamports: Object.values(progress.fee_reservations).reduce<number>(
      (sum, value) => sum + Number(value),
      0,
    ),
  };
  evidence.sender_balance_base_units = await chain.balance(progress.sender);
  evidence.state = "passed_requested_backend_stage";
}
try {
  await main();
} catch (error) {
  evidence.state = "blocked_or_failed_reconcile_before_retry";
  if (error instanceof Error && /^[A-Za-z_]+$/.test(error.name)) evidence.error_class = error.name;
  const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof cause === "string" && /^[A-Z0-9_]+$/.test(cause)) evidence.transport_code = cause;
  evidence.code =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "configuration_transport_or_verification_failure";
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await unlink(file + ".lock");
  }
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
