import { readFile, writeFile, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createHash, createHmac, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { exportJWK, SignJWT } from "jose";
import pg from "pg";
import { TLSSocket } from "node:tls";

class ProbeError extends Error {}
function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new ProbeError(code);
}
const localWorkerOnly = process.argv.includes("--local-worker-only");
const output = localWorkerOnly
  ? "evidence/hosted-e2e/local-worker.json"
  : "evidence/hosted-e2e/hosted-services.json";
const result: {
  started_at: string;
  finished_at?: string;
  origin?: string;
  scope: string;
  checks: { name: string; state: string; code?: string; details?: unknown }[];
  worker_events: { event: string; code?: string }[];
  http_requests: {
    method: string;
    path: string;
    status: number;
    request_id?: string;
    error_code?: string;
  }[];
  worker_pid?: number;
  fixture_jobs: { id: string; purpose: string }[];
  live_sms_sent: boolean;
  principal_release_submitted: boolean;
  state: string;
} = {
  started_at: new Date().toISOString(),
  scope: localWorkerOnly
    ? "Local worker against intended hosted Supabase only; does not verify Render database access"
    : "Real HTTPS Render requests and Supabase; optional one local worker; no user-auth bypass",
  checks: [],
  worker_events: [],
  http_requests: [],
  fixture_jobs: [],
  live_sms_sent: false,
  principal_release_submitted: false,
  state: "running",
};
async function save() {
  await mkdir("evidence/hosted-e2e", { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");
}
async function check(name: string, action: () => Promise<unknown>) {
  try {
    const details = await action();
    result.checks.push({ name, state: "passed", ...(details ? { details } : {}) });
  } catch (error) {
    result.checks.push({
      name,
      state: "failed",
      code: error instanceof ProbeError ? error.message : "probe_or_transport_failure",
    });
  }
  await save();
}
async function main() {
  const local = parseEnv(await readFile(".env.local", "utf8")) as Record<string, string>,
    api = parseEnv(await readFile(".env.render-api", "utf8")) as Record<string, string>,
    worker = parseEnv(await readFile(".env.render-worker", "utf8")) as Record<string, string>;
  for (const name of [
    "DATABASE_URL",
    "APP_BASE_URL",
    "AUTH_JWT_PRIVATE_KEY",
    "AUTH_JWT_KID",
    "CRON_SECRET",
    "SESSION_SECRET",
    "MOCK_WEBHOOK_SECRET",
  ])
    requireThat(api[name], `missing_${name}`);
  requireThat(local.DATABASE_URL && worker.DATABASE_URL, "missing_database_configuration");
  const origin = api.APP_BASE_URL;
  requireThat(origin === "https://muuve.onrender.com", "unexpected_hosted_origin");
  result.origin = origin;
  const urls = [local, api, worker].map((env) => new URL(env.DATABASE_URL));
  for (const url of urls)
    requireThat(
      url.hostname === "aws-0-eu-west-1.pooler.supabase.com" &&
        decodeURIComponent(url.username) === "postgres.yirelxmcveyxcqofzayq" &&
        url.port === "5432" &&
        url.pathname === "/postgres" &&
        url.searchParams.get("sslmode") === "verify-full",
      "unexpected_database_target_or_tls",
    );
  requireThat(
    urls.every((url) => url.password === urls[0]!.password) &&
      [local, api, worker].every(
        (env) => env.SOLANA_CLUSTER === "devnet" && env.PAYOUT_PROVIDER === "mock",
      ) &&
      [
        "MUUVE_PROGRAM_ID",
        "USDT_MINT",
        "TOKEN_PROGRAM_ID",
        "TREASURY_TOKEN_ACCOUNT",
        "MOCK_WEBHOOK_SECRET",
      ].every((key) => local[key] === api[key] && api[key] === worker[key]),
    "local_api_worker_configuration_mismatch",
  );
  requireThat(
    api.APP_ENV === "preview" && api.OTP_PROVIDER === "twilio",
    "hosted_otp_policy_mismatch",
  );
  const needles = [
    ...[
      "SESSION_SECRET",
      "CRON_SECRET",
      "MOCK_WEBHOOK_SECRET",
      "PRIVY_APP_SECRET",
      "TWILIO_AUTH_TOKEN",
      "AUTH_JWT_PRIVATE_KEY",
      "FEE_PAYER_SECRET",
      "ATTESTOR_SECRET",
      "TREASURY_SECRET",
      "TEST_MINT_AUTHORITY_SECRET",
    ].map((name) => api[name]),
    decodeURIComponent(urls[0]!.password),
    api.AUTH_JWT_PRIVATE_KEY?.split("\n")[1],
  ].filter((value): value is string => !!value && value.length >= 8);
  const pool = new pg.Pool({
    connectionString: local.DATABASE_URL,
    connectionTimeoutMillis: 15000,
    query_timeout: 30000,
    options: "-c search_path=muuve,public",
  });
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<[number | null, NodeJS.Signals | null]> | undefined;
  async function request(path: string, options: RequestInit = {}) {
    const response = await fetch(origin + path, {
      ...options,
      redirect: "manual",
      signal: AbortSignal.timeout(45000),
    });
    const text = await response.text();
    requireThat(text.length < 65536, "unexpected_response_size");
    requireThat(
      !needles.some((secret) => text.includes(secret)),
      "secret_value_in_hosted_response",
    );
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProbeError(`non_json_response_${response.status}`);
    }
    result.http_requests.push({
      method: options.method ?? "GET",
      path,
      status: response.status,
      ...(typeof data.request_id === "string" && /^[0-9a-f-]{36}$/i.test(data.request_id)
        ? { request_id: data.request_id }
        : {}),
      ...(typeof data.error === "string" && /^[a-z][a-z0-9_]{0,60}$/.test(data.error)
        ? { error_code: data.error }
        : {}),
    });
    return { status: response.status, data, headers: response.headers };
  }
  const post = (path: string, data: unknown, headers: Record<string, string> = {}) =>
    request(path, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(data),
    });
  function errorResponse(
    response: Awaited<ReturnType<typeof request>>,
    status: number,
    error?: string,
  ) {
    requireThat(
      response.status === status,
      `unexpected_http_${response.status}_expected_${status}`,
    );
    requireThat(
      Object.keys(response.data).every((key) => ["error", "request_id"].includes(key)) &&
        typeof response.data.error === "string" &&
        (!error || response.data.error === error),
      "unexpected_error_response_shape",
    );
  }
  async function counts() {
    return (
      await pool.query(`SELECT
      (SELECT count(*) FROM operations WHERE state NOT IN ('finalized','failed')) AS operations,
      (SELECT count(*) FROM payouts) AS payouts,
      (SELECT count(*) FROM principals) AS principals,
      (SELECT count(*) FROM jobs WHERE state IN ('pending','running')) AS jobs,
      (SELECT count(*) FROM worker_schedules WHERE lease_until>now()) AS maintenance_leases`)
    ).rows[0];
  }
  const abandonedLeaseTokens = new Map<string, string>();
  async function addNoop(purpose: string, abandoned = false) {
    const entity = randomUUID();
    const token = abandoned ? randomUUID() : null;
    const row = (
      await pool.query(
        "INSERT INTO jobs(kind,entity_id,dedupe_key,attempts,state,lease_until,lease_token) VALUES('payout',$1,$2,$3,$4,CASE WHEN $3::integer=1 THEN now()-interval '5 seconds' ELSE NULL END,$5) RETURNING id",
        [
          entity,
          `hosted-e2e:${purpose}:${entity}`,
          abandoned ? 1 : 0,
          abandoned ? "running" : "pending",
          token,
        ],
      )
    ).rows[0];
    result.fixture_jobs.push({ id: row.id, purpose });
    if (token) abandonedLeaseTokens.set(row.id, token);
    await save();
    return row.id as string;
  }
  try {
    await check("schema_checksums_and_verified_database_tls", async () => {
      const client = await pool.connect();
      try {
        requireThat(
          client.connection.stream instanceof TLSSocket &&
            client.connection.stream.authorized === true,
          "database_tls_not_authorized",
        );
        const migrations = (
          await client.query("SELECT name,checksum FROM public.muuve_migrations ORDER BY name")
        ).rows;
        requireThat(migrations.length === 5, "migration_count_mismatch");
        for (const migration of migrations) {
          requireThat(/^\d{3}_[a-z_]+\.sql$/.test(migration.name), "invalid_migration_filename");
          const sql = await readFile(`supabase/migrations/${migration.name}`);
          requireThat(
            createHash("sha256").update(sql).digest("hex") === migration.checksum,
            "migration_checksum_mismatch",
          );
        }
        return {
          project: "yirelxmcveyxcqofzayq",
          migrations: migrations.map((r) => r.name),
          client_tls_authorized: true,
        };
      } finally {
        client.release();
      }
    });
    if (!localWorkerOnly) {
      await check("hosted_health_and_security_headers", async () => {
        const r = await request("/api/health");
        requireThat(
          r.status === 200 &&
            r.data.service === "muuve-backend" &&
            r.data.chain === "devnet" &&
            r.data.payouts === "mock",
          "unexpected_health_response",
        );
        requireThat(
          r.headers.get("cache-control")?.includes("no-store") &&
            r.headers.get("x-content-type-options") === "nosniff",
          "security_headers_missing",
        );
        return {
          http_status: r.status,
          service: r.data.service,
          declared_chain: r.data.chain,
          declared_payouts: r.data.payouts,
        };
      });
      await check("hosted_public_jwks_matches_local_signing_identity", async () => {
        const r = await request("/api/auth/jwks");
        requireThat(
          r.status === 200 && Array.isArray(r.data.keys) && r.data.keys.length === 1,
          "jwks_unavailable",
        );
        const expected = await exportJWK(
            createPublicKey(createPrivateKey(api.AUTH_JWT_PRIVATE_KEY)),
          ),
          key = r.data.keys[0];
        requireThat(
          !("d" in key) &&
            (["kty", "crv", "x", "y"] as const).every((k) => key[k] === expected[k]) &&
            key.kid === api.AUTH_JWT_KID &&
            key.alg === "ES256",
          "jwks_identity_mismatch",
        );
        return { public_key_matches: true, kid_matches: true, private_fields_absent: true };
      });
      for (const path of [
        "/api/me",
        "/api/links",
        "/api/balance",
        "/api/banks",
        `/api/operations/${randomUUID()}`,
        `/api/claims/${randomUUID()}/share`,
        `/api/payouts/${randomUUID()}`,
      ])
        await check(`unauthenticated_${path.split("/")[2]}`, async () => {
          errorResponse(await request(path), 401, "unauthorized");
        });
      await check("missing_and_foreign_origin_rejected", async () => {
        for (const originValue of [undefined, "https://untrusted.invalid"]) {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (originValue) headers.origin = originValue;
          const r = await request("/api/auth/otp/send", { method: "POST", headers, body: "{}" });
          errorResponse(r, 403, "invalid_origin");
          requireThat(
            !r.headers.get("access-control-allow-origin"),
            "untrusted_cors_origin_allowed",
          );
        }
      });
      await check("hosted_origin_accepts_validation_without_sending_sms", async () => {
        errorResponse(await post("/api/auth/otp/send", {}), 400, "invalid_body");
      });
      await check("nonexistent_otp_challenge_rejected_without_provider_action", async () => {
        errorResponse(
          await post("/api/auth/otp/verify", { challenge_id: randomUUID(), code: "0".repeat(6) }),
          401,
          "invalid_challenge",
        );
      });
      await check("invalid_and_expired_account_tokens_rejected", async () => {
        const expired = await new SignJWT({ sid: randomUUID(), purpose: "account" })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer("muuve")
          .setAudience("muuve:account")
          .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
          .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
          .sign(new TextEncoder().encode(api.SESSION_SECRET));
        for (const token of ["invalid-token", expired])
          errorResponse(
            await request("/api/me", { headers: { cookie: `muuve_session=${token}` } }),
            401,
            "unauthorized",
          );
      });
      await check("unsigned_cron_and_webhook_rejected", async () => {
        errorResponse(await post("/api/cron/work", {}), 401, "unauthorized");
        errorResponse(await post("/api/webhooks/payout", {}), 401, "invalid_webhook");
      });
      await check("signed_mock_webhook_validates_secret_but_rejects_unknown_payout", async () => {
        const data = {
            event_id: `hosted-e2e:${randomUUID()}`,
            payout_id: randomUUID(),
            provider_ref: `mock-${randomUUID()}`,
            status: "paid",
          },
          raw = JSON.stringify(data);
        for (const age of [0, 600]) {
          const timestamp = String(Math.floor(Date.now() / 1000) - age),
            signature = createHmac("sha256", api.MOCK_WEBHOOK_SECRET)
              .update(`${timestamp}.${raw}`)
              .digest("hex");
          errorResponse(
            await post("/api/webhooks/payout", data, {
              "x-muuve-timestamp": timestamp,
              "x-muuve-signature": signature,
            }),
            age ? 401 : 409,
            age ? "invalid_webhook" : "unknown_provider_reference",
          );
        }
      });
      await check("authenticated_hosted_monitor", async () => {
        const r = await post(
          "/api/cron/monitor",
          {},
          { authorization: `Bearer ${api.CRON_SECRET}` },
        );
        requireThat(
          r.status === 200 &&
            r.data.counts &&
            Array.isArray(r.data.deficits) &&
            Number.isInteger(r.data.fee_payer_lamports),
          "monitor_or_cron_configuration_failed",
        );
        return {
          counts: r.data.counts,
          deficit_count: r.data.deficits.length,
          fee_payer_lamports: r.data.fee_payer_lamports,
        };
      });
    }
    const workerRequested = localWorkerOnly || process.argv.includes("--run-worker-check");
    const passed = (name: string) =>
      result.checks.some((check) => check.name === name && check.state === "passed");
    if (
      workerRequested &&
      process.argv.includes("--allow-test-records") &&
      passed("schema_checksums_and_verified_database_tls") &&
      (localWorkerOnly ||
        (passed("hosted_health_and_security_headers") && passed("authenticated_hosted_monitor")))
    ) {
      if (!localWorkerOnly)
        await check("hosted_cron_processes_unique_job_in_intended_database_once", async () => {
          requireThat(
            Object.values(await counts()).every((v) => Number(v) === 0),
            "existing_work_prevents_probe",
          );
          const id = await addNoop("remote-cron");
          const deliveries = await Promise.all(
            [0, 1].map(() =>
              post("/api/cron/work", {}, { authorization: `Bearer ${api.CRON_SECRET}` }),
            ),
          );
          requireThat(
            deliveries.every((r) => r.status === 200) &&
              deliveries
                .map((r) => r.data.processed)
                .sort()
                .join(",") === "0,1",
            "concurrent_queue_delivery_not_once",
          );
          {
            const r = await post(
              "/api/cron/work",
              {},
              { authorization: `Bearer ${api.CRON_SECRET}` },
            );
            requireThat(
              r.status === 200 && r.data.processed === 0,
              "remote_cron_did_not_process_expected_job_count",
            );
          }
          const job = (
            await pool.query("SELECT state,attempts,lease_token FROM jobs WHERE id=$1", [id])
          ).rows[0];
          requireThat(
            job?.state === "done" && job.attempts === 1 && !job.lease_token,
            "remote_job_state_mismatch",
          );
          return {
            job_id: id,
            kind: "obsolete-payout-noop",
            processed_once: true,
            concurrent_deliveries: 2,
            repeated_delivery_processed: 0,
            principal_released: false,
          };
        });
      if (localWorkerOnly || passed("hosted_cron_processes_unique_job_in_intended_database_once"))
        await check("single_local_worker_processes_hosted_job_and_drains", async () => {
          requireThat(
            Object.values(await counts()).every((v) => Number(v) === 0),
            "existing_work_prevents_probe",
          );
          const id = await addNoop("local-worker");
          const recoveryId = await addNoop("expired-lease-fixture", true);
          const processWorker = spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
            env: {
              PATH: process.env.PATH,
              ...worker,
              NODE_ENV: "production",
              DATABASE_URL: local.DATABASE_URL,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          child = processWorker;
          result.worker_pid = processWorker.pid;
          exited = once(processWorker, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
          let buffered = "";
          processWorker.stdout!.on("data", (chunk: Buffer) => {
            buffered += chunk.toString();
            for (;;) {
              const index = buffered.indexOf("\n");
              if (index < 0) break;
              const line = buffered.slice(0, index);
              buffered = buffered.slice(index + 1);
              try {
                const event = JSON.parse(line);
                if (
                  /^(worker|monitor)\.[a-z_]+$/.test(event.event) &&
                  result.worker_events.length < 50
                )
                  result.worker_events.push({
                    event: event.event,
                    ...(["reconcile", "expire", "failed_payouts", "monitor"].includes(event.code)
                      ? { code: event.code }
                      : {}),
                  });
              } catch {}
            }
          });
          processWorker.stderr!.resume();
          let done = false;
          for (let i = 0; i < 60; i++) {
            const jobs = (
              await pool.query(
                "SELECT id,state,attempts,lease_token FROM jobs WHERE id=ANY($1::uuid[])",
                [[id, recoveryId]],
              )
            ).rows;
            done =
              jobs.length === 2 &&
              jobs.every(
                (job) =>
                  job.state === "done" &&
                  job.attempts === (job.id === recoveryId ? 2 : 1) &&
                  !job.lease_token,
              );
            if (done || processWorker.exitCode !== null) break;
            await pause(500);
          }
          requireThat(done, "local_worker_job_not_completed");
          const stale = await pool.query(
            "UPDATE jobs SET state='pending' WHERE id=$1 AND lease_token=$2 AND state='running'",
            [recoveryId, abandonedLeaseTokens.get(recoveryId)],
          );
          requireThat(stale.rowCount === 0, "stale_lease_modified_recovered_job");
          processWorker.kill("SIGTERM");
          const status = await Promise.race([
            exited,
            pause(115000, undefined, { ref: false }).then(() => undefined),
          ]);
          requireThat(status?.[0] === 0, "local_worker_did_not_drain_cleanly");
          const leased = await counts();
          requireThat(
            Number(leased.maintenance_leases) === 0 && Number(leased.jobs) === 0,
            "leases_not_released",
          );
          return {
            job_id: id,
            expired_lease_fixture_id: recoveryId,
            expired_lease_recovered: true,
            stale_owner_update_rejected: true,
            processed_once: true,
            exit_code: status[0],
            database_target: "hosted Supabase",
            only_connection_difference: "local public CA file path",
            principal_released: false,
          };
        });
    } else
      result.checks.push({
        name: "queue_and_worker_probes",
        state: "blocked",
        code: workerRequested ? "preflight_failed" : "explicit_test_record_flags_required",
      });
    if (!localWorkerOnly)
      result.checks.push({
        name: "positive_hosted_payment_lifecycle",
        state: "blocked",
        code: "requires_authorized_phone_verification_and_real_privy_wallet_ownership",
      });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited,
        pause(115000, undefined, { ref: false }).then(() => undefined),
      ]);
      if (!stopped) child.kill("SIGKILL");
    }
    await pool.end();
  }
  result.state = result.checks.some((c) => c.state === "failed")
    ? "failed"
    : result.checks.some((c) => c.state === "blocked")
      ? "partial_verified_with_blockers"
      : "passed";
  result.finished_at = new Date().toISOString();
  await save();
  console.info(
    JSON.stringify({
      state: result.state,
      passed: result.checks.filter((c) => c.state === "passed").length,
      failed: result.checks.filter((c) => c.state === "failed").length,
      blocked: result.checks.filter((c) => c.state === "blocked").length,
      evidence: output,
    }),
  );
  if (result.state === "failed") process.exitCode = 1;
}
main().catch(async (error: unknown) => {
  result.state = "blocked";
  result.checks.push({
    name: "safety_preflight",
    state: "blocked",
    code: error instanceof ProbeError ? error.message : "configuration_or_transport_failure",
  });
  result.finished_at = new Date().toISOString();
  await save();
  console.error(JSON.stringify({ state: result.state, evidence: output }));
  process.exitCode = 1;
});
