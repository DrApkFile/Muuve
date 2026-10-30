import { readFile, writeFile, mkdir, stat, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { jwtVerify } from "jose";
import pg from "pg";
import { phone } from "@muuve/shared";
import { hostedTestFetch } from "./hosted-test-http";
import { privateProgressWriter } from "./private-progress";

// Real hosted claim-purpose OTP for the new, unsigned single-recipient fixture.
// No funding signatures, principal release, payout or wallet enrollment.
const mode = process.argv.find((a) => ["--send", "--verify", "--audit", "--reconcile"].includes(a)),
  path = "keys/replacement-claim-session.json",
  codePath = "keys/replacement-payment-otp.json",
  evidence: Record<string, any> = {
    started_at: new Date().toISOString(),
    mode,
    requests: [],
    transactions_submitted: 0,
    payout_requests: 0,
  };
let pool: pg.Pool | undefined, lock: Awaited<ReturnType<typeof open>> | undefined, progress: any;
const save = privateProgressWriter(path, () => progress);
function assert(x: unknown, code: string): asserts x {
  if (!x) throw new Error(code);
}
try {
  assert(mode && process.argv.includes("--operator-approved-sms"), "authorized_sms_test_required");
  lock = await open(path + ".lock", "wx", 0o600);
  const api = parseEnv(await readFile(".env.render-api", "utf8")),
    local = parseEnv(await readFile(".env.local", "utf8")),
    prepared = JSON.parse(await readFile("keys/replacement-payment-test.json", "utf8")),
    phones = JSON.parse(await readFile("keys/replacement-recipient-phone.json", "utf8")),
    db = new URL(local.DATABASE_URL!),
    remote = new URL(api.DATABASE_URL!);
  assert(
    api.APP_BASE_URL === "https://muuve.onrender.com" &&
      api.APP_ENV === "preview" &&
      api.OTP_PROVIDER === "textbee" &&
      api.SOLANA_CLUSTER === "devnet" &&
      api.PAYOUT_PROVIDER === "mock" &&
      db.hostname === "aws-0-eu-west-1.pooler.supabase.com" &&
      decodeURIComponent(db.username) === "postgres.yirelxmcveyxcqofzayq" &&
      db.port === "5432" &&
      db.pathname === "/postgres" &&
      db.searchParams.get("sslmode") === "verify-full" &&
      remote.hostname === db.hostname &&
      remote.username === db.username &&
      remote.password === db.password,
    "intended_hosted_environment_required",
  );
  assert(
    phones.authorize_sms === true &&
      phone.safeParse(phones.recipient).success &&
      prepared.phase === "prepared_unsigned" &&
      prepared.link_id,
    "actual_unsigned_fixture_required",
  );
  for (const f of ["keys/replacement-payment-test.json", "keys/replacement-recipient-phone.json"])
    assert(((await stat(f)).mode & 0o077) === 0, "private_fixture_permissions_required");
  pool = new pg.Pool({
    connectionString: local.DATABASE_URL,
    options: "-c search_path=muuve,public",
    connectionTimeoutMillis: 15000,
    query_timeout: 15000,
    max: 1,
  });
  const slots = (
    await pool.query(
      "SELECT slot_index,recipient_phone_e164,amount_base_units FROM link_slots WHERE link_id=$1 ORDER BY slot_index",
      [prepared.link_id],
    )
  ).rows;
  assert(
    slots.length === 1 &&
      slots[0].slot_index === 0 &&
      slots[0].recipient_phone_e164 === phones.recipient &&
      slots[0].amount_base_units === "100000",
    "new_recipient_fixed_allocation_required",
  );
  try {
    assert(((await stat(path)).mode & 0o077) === 0, "private_session_permissions_required");
    progress = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    progress = { phase: "new", phone: phones.recipient, link_id: prepared.link_id, cookies: {} };
    await save();
  }
  assert(
    progress.phone === phones.recipient && progress.link_id === prepared.link_id,
    "test_session_identity_mismatch",
  );
  async function call(route: string, body?: unknown) {
    const response = await hostedTestFetch(api.APP_BASE_URL + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: api.APP_BASE_URL!,
        "content-type": "application/json",
        cookie: Object.entries(progress.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const record: Record<string, unknown> = { path: route, status: response.status };
    evidence.requests.push(record);
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`non_json_http_${response.status}`);
    }
    if (typeof result.error === "string" && /^[a-z_]+$/.test(result.error))
      record.error = result.error;
    assert(response.status === 200, `hosted_http_${response.status}`);
    for (const header of response.headers.getSetCookie()) {
      assert(
        header.includes("Secure") && header.includes("HttpOnly") && header.includes("SameSite=Lax"),
        "secure_cookie_flags_required",
      );
      const pair = header.split(";")[0]!,
        at = pair.indexOf("="),
        name = pair.slice(0, at),
        value = pair.slice(at + 1);
      assert(["muuve_claim", "muuve_session"].includes(name), "unexpected_auth_cookie");
      if (value) progress.cookies[name] = value;
      else delete progress.cookies[name];
    }
    await save();
    return result;
  }
  async function challenge() {
    const rows = (
      await pool!.query(
        "SELECT id,status,provider_ref,expires_at>now() AS valid,verified_at IS NOT NULL AS verified FROM otp_challenges WHERE phone_e164=$1 AND link_id=$2 AND purpose='claim' AND created_at>=$3::timestamptz-interval '2 seconds'",
        [progress.phone, progress.link_id, progress.send_started_at],
      )
    ).rows;
    assert(rows.length === 1, "unique_actual_challenge_required");
    const row = rows[0];
    assert(row.provider_ref?.startsWith("textbee:v1:"), "actual_textbee_receipt_required");
    if (progress.challenge_id)
      assert(row.id === progress.challenge_id, "challenge_receipt_mismatch");
    evidence.challenge = {
      id: row.id,
      status: row.status,
      unexpired: row.valid,
      provider: "textbee",
      link_id: progress.link_id,
    };
    return row;
  }
  if (mode === "--send") {
    assert(progress.phase === "new", "existing_sms_attempt_preserved_reconcile_instead");
    await writeFile(codePath, JSON.stringify({ code: "" }) + "\n", { mode: 0o600, flag: "wx" });
    progress.phase = "send_started";
    progress.send_started_at = new Date().toISOString();
    await save();
    const sent = await call("/api/auth/otp/send", {
      phone_e164: progress.phone,
      channel: "sms",
      purpose: "claim",
      link_id: progress.link_id,
    });
    progress.challenge_id = sent.challenge_id;
    progress.phase = "waiting_for_code";
    await save();
    const row = await challenge();
    assert(row.status === "sent" && row.valid, "live_textbee_challenge_required");
    evidence.state = "hosted_textbee_claim_sms_accepted_waiting_for_private_code";
  } else if (mode === "--reconcile") {
    assert(progress.send_started_at, "recorded_send_required");
    const row = await challenge();
    assert(row.status === "sent" && row.valid, "live_textbee_challenge_required");
    progress.challenge_id = row.id;
    progress.phase = "waiting_for_code";
    await save();
    evidence.state = "accepted_challenge_reconciled_without_resend";
  } else {
    if (mode === "--verify") {
      assert(progress.phase === "waiting_for_code", "pending_actual_code_required");
      assert(((await stat(codePath)).mode & 0o077) === 0, "private_code_permissions_required");
      const input = JSON.parse(await readFile(codePath, "utf8"));
      assert(
        typeof input.code === "string" && /^\d{6}$/.test(input.code),
        "six_digit_private_code_required",
      );
      await writeFile(codePath, JSON.stringify({ code: "" }) + "\n", { mode: 0o600 });
      const row = await challenge();
      assert(row.status === "sent" && row.valid, "unexpired_actual_challenge_required");
      await call("/api/auth/otp/verify", { challenge_id: progress.challenge_id, code: input.code });
    }
    const row = await challenge();
    assert(row.status === "verified" && row.verified, "actual_phone_verification_required");
    assert(progress.cookies.muuve_claim, "actual_hosted_claim_cookie_required");
    const verified = await jwtVerify(
      progress.cookies.muuve_claim,
      new TextEncoder().encode(api.SESSION_SECRET),
      { algorithms: ["HS256"], issuer: "muuve", audience: "muuve:claim" },
    );
    const session = (
      await pool.query(
        "SELECT phone_e164,link_id,purpose,expires_at>now() AS valid,revoked_at,consumed_at FROM sessions WHERE id=$1",
        [verified.payload.sid],
      )
    ).rows[0];
    assert(
      verified.payload.purpose === "claim" &&
        session?.phone_e164 === progress.phone &&
        session.link_id === progress.link_id &&
        session.purpose === "claim" &&
        session.valid &&
        !session.revoked_at &&
        !session.consumed_at,
      "actual_claim_session_binding_failed",
    );
    const share = await call(`/api/claims/${progress.link_id}/share`);
    assert(
      share.slot_index === 0 &&
        share.amount_base_units === "100000" &&
        !Object.keys(share).some((k) => /phone|recipients|slots/.test(k)),
      "private_fixed_share_mismatch",
    );
    progress.phase = "phone_verified";
    await save();
    evidence.state = "passed_real_hosted_new_recipient_claim_verification";
    evidence.share = {
      slot_index: share.slot_index,
      amount_base_units: share.amount_base_units,
      status: share.status,
    };
    evidence.signed_session_and_sql_binding_verified = true;
  }
} catch (error) {
  evidence.state = "blocked_or_failed_no_automatic_resend";
  evidence.code =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "configuration_or_transport_failure";
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await unlink(path + ".lock");
  }
  await pool?.end();
  await mkdir("evidence/backend-payment", { recursive: true });
  const output = `evidence/backend-payment/replacement-otp-${randomUUID()}.json`;
  evidence.finished_at = new Date().toISOString();
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  console.info(JSON.stringify({ state: evidence.state, code: evidence.code, evidence: output }));
}
