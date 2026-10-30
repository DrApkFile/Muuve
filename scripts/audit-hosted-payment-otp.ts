import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { jwtVerify } from "jose";
import pg from "pg";

// Read-only audit of actual hosted challenges/sessions. Never checks a guessed
// code, synthesizes a session, sends SMS or releases principal.
const role = process.argv.find((arg) => /^--role=[ab]$/.test(arg))?.slice(-1),
  evidence: Record<string, unknown> = {
    checked_at: new Date().toISOString(),
    role,
    database_writes: 0,
    sms_requests: 0,
    transactions_submitted: 0,
  };
let pool: pg.Pool | undefined;
function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
try {
  assert(role, "explicit_test_recipient_required");
  const env = parseEnv(await readFile(".env.local", "utf8")),
    api = parseEnv(await readFile(".env.render-api", "utf8")),
    target = new URL(env.DATABASE_URL!),
    remote = new URL(api.DATABASE_URL!);
  assert(
    target.hostname === "aws-0-eu-west-1.pooler.supabase.com" &&
      decodeURIComponent(target.username) === "postgres.yirelxmcveyxcqofzayq" &&
      target.port === "5432" &&
      target.pathname === "/postgres" &&
      target.searchParams.get("sslmode") === "verify-full" &&
      target.hostname === remote.hostname &&
      target.password === remote.password &&
      target.username === remote.username &&
      api.APP_BASE_URL === "https://muuve.onrender.com" &&
      api.OTP_PROVIDER === "textbee" &&
      env.SOLANA_CLUSTER === "devnet",
    "intended_hosted_environment_required",
  );
  const progress = JSON.parse(await readFile("keys/backend-payment-run.json", "utf8")),
    entry = progress.roles[role],
    fixture = progress.fixtures.main;
  assert(entry.send_started_at, "recorded_sms_request_required");
  pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    options: "-c search_path=muuve,public",
    connectionTimeoutMillis: 15000,
    query_timeout: 15000,
    max: 1,
  });
  const slots = (
    await pool.query(
      "SELECT slot_index,recipient_phone_e164,amount_base_units,status FROM link_slots WHERE link_id=$1 ORDER BY slot_index",
      [fixture.id],
    )
  ).rows;
  const index = role === "a" ? 0 : 1;
  assert(
    slots.length === 2 &&
      slots[index]?.recipient_phone_e164 === entry.phone &&
      slots[index]?.amount_base_units === fixture.amounts[index],
    "original_recipient_allocation_mismatch",
  );
  const rows = (
    await pool.query(
      "SELECT id,purpose,status,provider_ref,verified_at,expires_at>now() AS valid FROM otp_challenges WHERE link_id=$1 AND phone_e164=$2 AND created_at>=$3::timestamptz-interval '2 seconds' ORDER BY created_at",
      [fixture.id, entry.phone, entry.send_started_at],
    )
  ).rows;
  assert(rows.length === 1, "unique_current_challenge_required");
  const challenge = rows[0];
  evidence.challenge = {
    id: challenge.id,
    purpose: challenge.purpose,
    status: challenge.status,
    unexpired: challenge.valid,
    provider_reference_present: !!challenge.provider_ref,
  };
  assert(challenge.provider_ref, "failed_or_incomplete_send_provider_unknown");
  assert(
    challenge.purpose === "claim" && challenge.provider_ref?.startsWith("textbee:v1:"),
    "hosted_challenge_not_textbee",
  );
  if (entry.challenge_id) assert(challenge.id === entry.challenge_id, "challenge_receipt_mismatch");
  evidence.challenge = {
    id: challenge.id,
    purpose: challenge.purpose,
    status: challenge.status,
    unexpired: challenge.valid,
    provider: "textbee",
    slot_index: index,
    amount_base_units: slots[index].amount_base_units,
  };
  if (process.argv.includes("--require-verified")) {
    assert(
      challenge.status === "verified" && challenge.verified_at,
      "actual_otp_verification_required",
    );
    assert(entry.cookies.muuve_claim, "actual_hosted_claim_cookie_required");
    const verified = await jwtVerify(
      entry.cookies.muuve_claim,
      new TextEncoder().encode(api.SESSION_SECRET),
      { algorithms: ["HS256"], issuer: "muuve", audience: "muuve:claim" },
    );
    assert(verified.payload.purpose === "claim", "claim_token_purpose_mismatch");
    const sessions = (
      await pool.query(
        "SELECT phone_e164,link_id,purpose,expires_at>now() AS valid,revoked_at,consumed_at FROM sessions WHERE id=$1",
        [verified.payload.sid],
      )
    ).rows;
    assert(
      sessions.length === 1 &&
        sessions[0].phone_e164 === entry.phone &&
        sessions[0].link_id === fixture.id &&
        sessions[0].purpose === "claim" &&
        sessions[0].valid &&
        !sessions[0].revoked_at &&
        !sessions[0].consumed_at,
      "actual_hosted_session_binding_failed",
    );
    evidence.signed_claim_session_and_sql_binding_verified = true;
  } else
    assert(
      challenge.status === "sent" && challenge.valid,
      "active_provider_accepted_challenge_required",
    );
  evidence.state = "passed_readonly_hosted_otp_audit";
} catch (error) {
  evidence.state = "blocked_or_failed_no_resend_performed";
  evidence.code =
    error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "otp_audit_configuration_or_database_failure";
  process.exitCode = 1;
} finally {
  await pool?.end();
  await mkdir("evidence/textbee", { recursive: true });
  const path = `evidence/textbee/hosted-otp-audit-${randomUUID()}.json`;
  await writeFile(path, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  console.info(JSON.stringify({ ...evidence, evidence: path }));
}
