import { readFile, writeFile, stat, mkdir, rename, open, unlink } from "node:fs/promises";
import { parseEnv } from "node:util";
import { randomUUID } from "node:crypto";
import { jwtVerify } from "jose";
import pg from "pg";
import { phone, uuid } from "@muuve/shared";
import { hostedTestFetch } from "./hosted-test-http";

const file = "keys/single-phone-test.json",
  codeFile = "keys/single-phone-code.json";
const mode = process.argv.find((arg) =>
  ["--send", "--retry-unsent", "--verify", "--audit", "--reconcile", "--close"].includes(arg),
);
const evidence: Record<string, any> = {
  started_at: new Date().toISOString(),
  mode,
  scope:
    "Actual hosted account OTP to the owner's already verified number; no financial operations",
  requests: [],
  transactions_submitted: 0,
};
const output = `evidence/single-phone/otp-${mode?.slice(2) ?? "invalid"}-${randomUUID()}.json`;
function assert(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
let lock: Awaited<ReturnType<typeof open>> | undefined, pool: pg.Pool | undefined, progress: any;
async function save() {
  await writeFile(file + ".tmp", JSON.stringify(progress, null, 2) + "\n", { mode: 0o600 });
  await rename(file + ".tmp", file);
}
async function main() {
  assert(
    mode && process.argv.includes("--operator-approved-sms"),
    "explicit_verified_phone_sms_scope_required",
  );
  lock = await open(file + ".lock", "wx", 0o600);
  const env = parseEnv(await readFile(".env.render-api", "utf8")),
    local = parseEnv(await readFile(".env.local", "utf8"));
  assert(
    env.APP_BASE_URL === "https://muuve.onrender.com" &&
      env.APP_ENV === "preview" &&
      env.OTP_PROVIDER === "twilio" &&
      env.SOLANA_CLUSTER === "devnet" &&
      env.PAYOUT_PROVIDER === "mock",
    "intended_hosted_configuration_required",
  );
  const db = new URL(local.DATABASE_URL!),
    remote = new URL(env.DATABASE_URL!);
  assert(
    db.hostname === "aws-0-eu-west-1.pooler.supabase.com" &&
      decodeURIComponent(db.username) === "postgres.yirelxmcveyxcqofzayq" &&
      db.port === "5432" &&
      db.pathname === "/postgres" &&
      db.searchParams.get("sslmode") === "verify-full" &&
      db.hostname === remote.hostname &&
      db.username === remote.username &&
      db.password === remote.password,
    "intended_hosted_database_required",
  );
  const phonesPath = "keys/hosted-test-phones.json";
  assert(((await stat(phonesPath)).mode & 0o077) === 0, "private_phone_configuration_required");
  const phones = JSON.parse(await readFile(phonesPath, "utf8"));
  assert(
    phones.authorize_sms === true && phone.safeParse(phones.sender).success,
    "authorized_verified_test_number_required",
  );
  try {
    assert(((await stat(file)).mode & 0o077) === 0, "private_progress_permissions_required");
    progress = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    progress = { origin: env.APP_BASE_URL, phone: phones.sender, phase: "new", cookies: {} };
    await save();
  }
  assert(
    progress.origin === env.APP_BASE_URL && progress.phone === phones.sender,
    "test_identity_mismatch",
  );
  pool = new pg.Pool({
    connectionString: local.DATABASE_URL,
    options: "-c search_path=muuve,public",
    connectionTimeoutMillis: 15000,
    query_timeout: 15000,
    max: 1,
  });
  async function call(path: string, body?: unknown, expected = 200) {
    assert(
      [
        "/api/health",
        "/api/auth/otp/send",
        "/api/auth/otp/verify",
        "/api/auth/logout",
        "/api/me",
      ].includes(path),
      "nonfinancial_auth_paths_only",
    );
    evidence.stage = path;
    const response = await hostedTestFetch(env.APP_BASE_URL + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: env.APP_BASE_URL!,
        "content-type": "application/json",
        cookie: Object.entries(progress.cookies)
          .map(([name, value]) => `${name}=${value}`)
          .join("; "),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
        "session_cookie_flags_required",
      );
      const pair = value.split(";")[0]!,
        index = pair.indexOf("="),
        name = pair.slice(0, index),
        token = pair.slice(index + 1);
      assert(
        ["muuve_session", "muuve_phone_proof", "muuve_claim", "muuve_wallet_challenge"].includes(
          name,
        ),
        "unexpected_cookie",
      );
      if (token) progress.cookies[name] = token;
      else delete progress.cookies[name];
    }
    await save();
    return data;
  }
  if (mode === "--send" || mode === "--retry-unsent") {
    if (mode === "--send") {
      assert(progress.phase === "new", "existing_sms_attempt_preserved_reconcile_instead");
    } else {
      assert(
        progress.phase === "send_started" &&
          !progress.challenge_id &&
          !progress.unsent_retry &&
          Date.now() - Date.parse(progress.send_started_at) > 90000,
        "only_one_reconciled_unsent_retry_allowed",
      );
      const previous = await pool.query(
        "SELECT id FROM otp_challenges WHERE phone_e164=$1 AND purpose='account' AND created_at >= $2::timestamptz - interval '2 seconds'",
        [progress.phone, progress.send_started_at],
      );
      assert(previous.rowCount === 0, "prior_send_has_challenge_reconcile_instead");
      evidence.prior_send_confirmed_without_challenge = true;
      const health = await call("/api/health");
      assert(
        health.chain === "devnet" && health.payouts === "mock",
        "intended_healthy_service_required",
      );
    }
    const sid = env.TWILIO_ACCOUNT_SID,
      token = env.TWILIO_AUTH_TOKEN;
    assert(sid && token, "twilio_credentials_required");
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/OutgoingCallerIds.json?PageSize=100`,
      {
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    assert(response.ok, "twilio_verified_number_lookup_failed");
    const verified = await response.json();
    assert(
      Array.isArray(verified.outgoing_caller_ids) &&
        verified.outgoing_caller_ids.some((entry: any) => entry.phone_number === progress.phone),
      "number_not_in_actual_twilio_verified_list",
    );
    evidence.twilio_verified_destination_confirmed = true;
    const rates = (
      await pool.query(
        `SELECT count(*) FILTER(WHERE created_at>now()-interval '10 minutes')::int AS ten, count(*)::int AS day, count(*) FILTER(WHERE status IN ('pending','sent') AND expires_at>now())::int AS live FROM otp_challenges WHERE phone_e164=$1 AND created_at>now()-interval '24 hours'`,
        [progress.phone],
      )
    ).rows[0];
    assert(
      rates.ten < 3 && rates.day < 10 && rates.live === 0,
      "existing_challenge_or_rate_limit_requires_wait",
    );
    evidence.phone_rate_counts = rates;
    if (mode === "--send") {
      await writeFile(codeFile, JSON.stringify({ code: "" }, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    } else {
      assert(((await stat(codeFile)).mode & 0o077) === 0, "private_code_permissions_required");
      progress.unsent_retry = { previous_started_at: progress.send_started_at };
    }
    progress.phase = "send_started";
    progress.send_started_at = new Date().toISOString();
    await save();
    const sent = await call("/api/auth/otp/send", {
      phone_e164: progress.phone,
      channel: "sms",
      purpose: "account",
    });
    assert(
      sent.sent === true && uuid.safeParse(sent.challenge_id).success,
      "real_hosted_challenge_required",
    );
    progress.challenge_id = sent.challenge_id;
    progress.phase = "waiting_for_private_code";
    await save();
    evidence.challenge_id = sent.challenge_id;
    evidence.state = "sms_request_accepted_waiting_for_owner_code";
    evidence.private_code_file = codeFile;
  } else if (mode === "--reconcile") {
    assert(progress.send_started_at, "existing_send_attempt_required");
    const rows = (
      await pool.query(
        `SELECT id,status,provider_ref IS NOT NULL AS provider_reference_present,expires_at<=now() AS expired FROM otp_challenges WHERE phone_e164=$1 AND purpose='account' AND created_at >= $2::timestamptz - interval '2 seconds' ORDER BY created_at`,
        [progress.phone, progress.send_started_at],
      )
    ).rows;
    assert(rows.length <= 1, "multiple_challenges_require_manual_review");
    evidence.challenges = rows;
    if (rows[0]?.status === "sent" && rows[0].provider_reference_present && !rows[0].expired) {
      progress.challenge_id = rows[0].id;
      progress.phase = "waiting_for_private_code";
      await save();
      evidence.state = "accepted_sms_reconciled_waiting_for_owner_code";
    } else evidence.state = "sms_not_ready_or_expired_no_resend_performed";
  } else if (mode === "--verify") {
    assert(
      progress.phase === "waiting_for_private_code" && progress.challenge_id,
      "real_pending_challenge_required",
    );
    assert(((await stat(codeFile)).mode & 0o077) === 0, "private_code_permissions_required");
    const input = JSON.parse(await readFile(codeFile, "utf8"));
    assert(/^\d{6}$/.test(input.code), "six_digit_private_code_required");
    const code = input.code;
    await writeFile(codeFile, JSON.stringify({ code: "" }, null, 2) + "\n", { mode: 0o600 });
    const verified = await call("/api/auth/otp/verify", {
      challenge_id: progress.challenge_id,
      code,
    });
    const userCookie = progress.cookies.muuve_session,
      proofCookie = progress.cookies.muuve_phone_proof;
    assert(userCookie || proofCookie, "actual_phone_verified_session_required");
    const purpose = userCookie ? "account" : "proof";
    const signed = await jwtVerify(
      userCookie ?? proofCookie,
      new TextEncoder().encode(env.SESSION_SECRET),
      { algorithms: ["HS256"], issuer: "muuve", audience: `muuve:${purpose}` },
    );
    const session = (
      await pool.query(
        "SELECT user_id,phone_e164,purpose,expires_at>now() AS valid,revoked_at FROM sessions WHERE id=$1",
        [signed.payload.sid],
      )
    ).rows[0];
    assert(
      session?.phone_e164 === progress.phone &&
        session.purpose === purpose &&
        session.valid &&
        !session.revoked_at,
      "actual_phone_session_sql_binding_failed",
    );
    progress.verified_session_id = signed.payload.sid;
    if (userCookie) {
      const me = await call("/api/me");
      assert(me.user.id === session.user_id, "hosted_user_identity_mismatch");
    } else assert(verified.needs_signup === true, "phone_proof_response_mismatch");
    const row = (
      await pool.query(
        "SELECT status,verified_at IS NOT NULL AS verified FROM otp_challenges WHERE id=$1",
        [progress.challenge_id],
      )
    ).rows[0];
    assert(row?.status === "verified" && row.verified, "actual_otp_consumption_required");
    progress.phase = "phone_verification_passed";
    await save();
    evidence.state = "passed_actual_hosted_phone_verification";
    evidence.verified_session_purpose = purpose;
    await call("/api/auth/logout", {});
    progress.cookies = {};
    progress.phase = "verified_and_logged_out";
    await save();
    evidence.test_session_logged_out = true;
  } else if (mode === "--audit") {
    assert(progress.phase === "verified_and_logged_out", "completed_phone_test_required");
    const sessions = (
      await pool.query(
        "SELECT id,purpose,revoked_at IS NOT NULL AS revoked FROM sessions WHERE phone_e164=$1 AND purpose IN ('account','proof') AND created_at >= $2::timestamptz",
        [progress.phone, progress.send_started_at],
      )
    ).rows;
    assert(sessions.length === 1 && sessions[0].revoked, "unique_test_session_revocation_required");
    if (progress.verified_session_id)
      assert(sessions[0].id === progress.verified_session_id, "test_session_identity_mismatch");
    const challenge = (
      await pool.query(
        "SELECT status,verified_at IS NOT NULL AS verified FROM otp_challenges WHERE id=$1 AND phone_e164=$2 AND purpose='account'",
        [progress.challenge_id, progress.phone],
      )
    ).rows[0];
    assert(challenge?.status === "verified" && challenge.verified, "verified_challenge_required");
    assert(Object.keys(progress.cookies).length === 0, "logout_cookie_cleanup_required");
    await call("/api/me", undefined, 401);
    evidence.state = "passed_phone_verification_and_logout_audit";
    evidence.test_session_revoked_in_hosted_database = true;
    evidence.logged_out_me_rejected = true;
    evidence.code_file_cleared = JSON.parse(await readFile(codeFile, "utf8")).code === "";
    assert(evidence.code_file_cleared, "private_code_cleanup_required");
  } else {
    if (Object.keys(progress.cookies).length) await call("/api/auth/logout", {});
    progress.cookies = {};
    await save();
    evidence.state = "test_cookies_cleared";
  }
}
try {
  await main();
} catch (error) {
  evidence.state = "blocked_or_failed_no_automatic_retry";
  evidence.code =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "configuration_or_transport_failure";
  process.exitCode = 1;
} finally {
  await pool?.end();
  if (lock) {
    await lock.close();
    await unlink(file + ".lock");
  }
  evidence.finished_at = new Date().toISOString();
  await mkdir("evidence/single-phone", { recursive: true });
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  console.info(
    JSON.stringify({
      state: evidence.state,
      ...(evidence.code ? { code: evidence.code } : {}),
      evidence: output,
    }),
  );
}
