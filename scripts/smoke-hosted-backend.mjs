import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { randomInt, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import pg from "pg";
import { createLocalJWKSet, jwtVerify } from "jose";
import { isValidPhoneNumber } from "libphonenumber-js";

// Explicit operator verification: leaves dedicated test records, never resets a database.
let url;
try {
  url = new URL(process.env.DATABASE_URL ?? "");
} catch {
  throw Error("Valid PostgreSQL connection required; no credential values logged");
}
const project = process.env.MUUVE_DATABASE_PROJECT_REF;
if (
  !process.argv.includes("--allow-test-records") ||
  process.env.APP_ENV !== "local" ||
  process.env.OTP_PROVIDER !== "mock" ||
  process.env.SOLANA_CLUSTER !== "devnet" ||
  !project ||
  !url.hostname.endsWith(".pooler.supabase.com") ||
  decodeURIComponent(url.username) !== `postgres.${project}` ||
  url.port !== "5432" ||
  url.searchParams.get("sslmode") !== "verify-full" ||
  !url.searchParams.get("sslrootcert")
)
  throw Error(
    "Explicit local/mock/devnet test-record consent and verified project pooler required",
  );

const pool = new pg.Pool({
  connectionString: url.toString(),
  connectionTimeoutMillis: 15000,
  query_timeout: 15000,
  options: "-c search_path=muuve,public",
});
const record = {
  checked_at: new Date().toISOString(),
  scope: "Loopback production HTTP and local worker with hosted Supabase; mock OTP; no payout",
  state: "running",
  checks: [],
  test_user_id: null,
  test_job_id: null,
  live_sms_sent: false,
  principal_release_submitted: false,
  child_exits: [],
};
function assert(value, code) {
  if (!value) throw Error(code);
}
let api, worker;
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const result = await Promise.race([
    exited,
    pause(15000, undefined, { ref: false }).then(() => null),
  ]);
  if (!result) {
    child.kill("SIGKILL");
    await exited;
    throw Error("child_shutdown_timeout");
  }
  record.child_exits.push({
    role: child === api ? "api" : "worker",
    exit_code: result[0],
    signal: result[1],
  });
  // Next translates requested SIGTERM into the conventional 128 + 15 exit status.
  assert(
    result[0] === 0 || (child === api && (result[0] === 143 || result[1] === "SIGTERM")),
    "child_shutdown_failed",
  );
}
try {
  const existing = (
    await pool.query(`SELECT
      (SELECT count(*) FROM operations) AS operations,
      (SELECT count(*) FROM payouts) AS payouts,
      (SELECT count(*) FROM principals) AS principals,
      (SELECT count(*) FROM jobs WHERE state IN ('pending','running')) AS active_jobs`)
  ).rows[0];
  assert(
    Object.values(existing).every((x) => Number(x) === 0),
    "empty_payment_fixture_required",
  );
  const phone = `+2348030000${randomInt(100, 1000)}`;
  assert(isValidPhoneNumber(phone), "invalid_synthetic_phone");
  assert(
    (await pool.query("SELECT id FROM users WHERE phone_e164=$1", [phone])).rowCount === 0,
    "synthetic_phone_already_used",
  );
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`,
    env = { ...process.env, NODE_ENV: "production", APP_BASE_URL: base },
    cookies = new Map();
  api = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "apps/web",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { env, stdio: "ignore" },
  );
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) })).ok;
    } catch {}
    if (ready) break;
    await pause(500);
  }
  assert(ready, "api_not_ready");
  async function request(path, status, data, suppliedCookie) {
    const response = await fetch(`${base}/api/${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        origin: base,
        "content-type": "application/json",
        cookie: suppliedCookie ?? [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(20000),
    });
    assert(response.status === status, `unexpected_status:${path}:${response.status}`);
    for (const value of response.headers.getSetCookie()) {
      assert(/HttpOnly; Secure; SameSite=Lax/.test(value), "cookie_flags_missing");
      const pair = value.split(";")[0],
        separator = pair.indexOf("="),
        name = pair.slice(0, separator),
        token = pair.slice(separator + 1);
      if (token) cookies.set(name, token);
      else cookies.delete(name);
    }
    return response.json();
  }
  await request("me", 401);
  const input = { phone_e164: phone, purpose: "account", channel: "sms" };
  const sent = await request("auth/otp/send", 200, input);
  await request("auth/otp/verify", 401, { challenge_id: sent.challenge_id, code: "1".repeat(6) });
  await request("auth/otp/verify", 200, { challenge_id: sent.challenge_id, code: "0".repeat(6) });
  const proof = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const signup = await request("auth/signup", 200, {
    display_name: `Hosted smoke ${randomUUID().slice(0, 8)}`,
  });
  record.test_user_id = signup.user.id;
  assert((await request("me", 200)).user.id === record.test_user_id, "signup_identity_mismatch");
  await request("auth/signup", 401, { display_name: "Repeated proof" }, proof);
  record.checks.push("mock OTP invalid-code rejection, signup, session and single-use proof");

  const { token } = await request("auth/privy-token", 200),
    jwks = await request("auth/jwks", 200),
    verified = await jwtVerify(token, createLocalJWKSet(jwks), {
      algorithms: ["ES256"],
      issuer: base,
      audience: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    });
  assert(verified.payload.sub === record.test_user_id, "jwt_identity_mismatch");
  const original = `muuve_session=${cookies.get("muuve_session")}`;
  await request("auth/refresh", 200, {});
  await request("me", 401, undefined, original);
  await request("me", 200);
  await request("auth/logout", 200, {});
  await request("me", 401);
  record.checks.push("public JWKS token verification, refresh rotation and logout revocation");

  const login = await request("auth/otp/send", 200, input);
  await request("auth/otp/verify", 200, { challenge_id: login.challenge_id, code: "0".repeat(6) });
  assert((await request("me", 200)).user.id === record.test_user_id, "login_identity_mismatch");
  await pool.query(
    "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1 AND revoked_at IS NULL",
    [record.test_user_id],
  );
  await request("me", 401);
  const expired = await request("auth/otp/send", 200, input);
  await pool.query(
    "UPDATE otp_challenges SET expires_at=now()-interval '1 second' WHERE id=$1 AND phone_e164=$2",
    [expired.challenge_id, phone],
  );
  await request("auth/otp/verify", 401, {
    challenge_id: expired.challenge_id,
    code: "0".repeat(6),
  });
  await request("auth/otp/send", 429, input);
  record.checks.push("existing-account login, expired sessions/challenges and OTP rate limit");

  const entity = randomUUID();
  record.test_job_id = (
    await pool.query(
      "INSERT INTO jobs(kind,entity_id,dedupe_key) VALUES('payout',$1,$2) RETURNING id",
      [entity, `hosted-smoke:${entity}`],
    )
  ).rows[0].id;
  // An obsolete payout job with no payout is a safe no-op; it releases no principal.
  worker = spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
    env: { ...env, WORKER_POLL_MS: "2000" },
    stdio: "ignore",
  });
  let completed = false;
  for (let i = 0; i < 60; i++) {
    const job = (
      await pool.query("SELECT state,attempts,lease_token FROM jobs WHERE id=$1", [
        record.test_job_id,
      ])
    ).rows[0];
    const schedules = await pool.query(
      "SELECT name FROM worker_schedules WHERE lease_token IS NULL AND next_run_at>now()",
    );
    completed =
      job?.state === "done" && job.attempts === 1 && !job.lease_token && schedules.rowCount === 4;
    if (completed || worker.exitCode !== null) break;
    await pause(500);
  }
  assert(completed, "worker_did_not_complete_job_and_maintenance");
  await stop(worker);
  record.checks.push(
    "real worker no-op queue progress, maintenance lease release and graceful SIGTERM",
  );
  record.state = "passed";
} catch (error) {
  record.state = "failed";
  record.failure_code = /^[-\w:]+$/.test(error.message) ? error.message : "verification_failed";
  process.exitCode = 1;
} finally {
  for (const child of [worker, api]) {
    try {
      await stop(child);
    } catch {
      record.state = "failed";
      record.failure_code ??= "child_shutdown_failed";
      record.cleanup_failure_code = "child_shutdown_failed";
      process.exitCode = 1;
    }
  }
  await pool.end();
  record.finished_at = new Date().toISOString();
  writeFileSync(
    "evidence/render-devnet/supabase-http-worker-result.json",
    JSON.stringify(record, null, 2) + "\n",
  );
  console.info(JSON.stringify(record));
}
