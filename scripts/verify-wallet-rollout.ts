import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { parseEnv } from "node:util";
import pg from "pg";

const stage = process.argv.includes("--after") ? "after" : "before";
const folder = "evidence/wallet-rollout";
const ref = "yirelxmcveyxcqofzayq";
const result: Record<string, unknown> = {
  checked_at: new Date().toISOString(),
  stage,
  read_only: true,
};
const assert = (value: unknown, code: string) => {
  if (!value) throw Error(code);
};
let pool: pg.Pool | undefined;
try {
  const api = parseEnv(await readFile(".env.render-api", "utf8"));
  const worker = parseEnv(await readFile(".env.render-worker", "utf8"));
  const localUrl = new URL(process.env.DATABASE_URL ?? ""),
    apiUrl = new URL(api.DATABASE_URL ?? ""),
    workerUrl = new URL(worker.DATABASE_URL ?? "");
  assert(
    localUrl.hostname === "aws-0-eu-west-1.pooler.supabase.com" &&
      decodeURIComponent(localUrl.username) === `postgres.${ref}` &&
      localUrl.port === "5432" &&
      localUrl.pathname === "/postgres",
    "intended_development_database_required",
  );
  for (const url of [localUrl, apiUrl, workerUrl]) {
    assert(
      url.hostname === localUrl.hostname &&
        url.username === localUrl.username &&
        url.password === localUrl.password &&
        url.port === localUrl.port &&
        url.pathname === localUrl.pathname &&
        url.searchParams.get("sslmode") === "verify-full" &&
        url.searchParams.has("sslrootcert"),
      "verified_shared_database_configuration_required",
    );
  }
  assert(
    api.APP_BASE_URL === "https://muuve.onrender.com" &&
      api.SOLANA_CLUSTER === "devnet" &&
      worker.SOLANA_CLUSTER === "devnet" &&
      api.PAYOUT_PROVIDER === "mock" &&
      worker.PAYOUT_PROVIDER === "mock",
    "devnet_mock_hosted_configuration_required",
  );
  assert(
    process.env.SESSION_SECRET && process.env.SESSION_SECRET === api.SESSION_SECRET,
    "stable_private_snapshot_key_required",
  );
  const migrationRoot = new URL("../supabase/migrations/", import.meta.url);
  const names = [
    "001_backend.sql",
    "002_state_guards.sql",
    "003_treasury_origin.sql",
    "004_immutable_terms.sql",
    "005_worker_leases.sql",
    "006_wallet_login.sql",
  ];
  const hashes: Record<string, string> = {};
  for (const name of names)
    hashes[name] = createHash("sha256")
      .update(await readFile(new URL(name, migrationRoot)))
      .digest("hex");
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 15000,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const stream = client.connection.stream as unknown as {
      encrypted?: boolean;
      authorized?: boolean;
    };
    assert(stream.encrypted && stream.authorized, "certificate_verified_database_tls_required");
    const ledger = (
      await client.query("SELECT name,checksum FROM public.muuve_migrations ORDER BY name")
    ).rows;
    assert(
      ledger.every((row) => hashes[row.name] === row.checksum),
      "applied_migration_checksum_mismatch",
    );
    const expected = stage === "before" ? names.slice(0, 5) : names;
    assert(
      JSON.stringify(ledger.map((row) => row.name)) === JSON.stringify(expected),
      "unexpected_hosted_migration_state",
    );
    result.target = {
      project: ref,
      host: localUrl.hostname,
      port: localUrl.port,
      database: localUrl.pathname.slice(1),
      tls_authorized: true,
    };
    result.configuration = {
      api_origin: api.APP_BASE_URL,
      cluster: api.SOLANA_CLUSTER,
      payouts: api.PAYOUT_PROVIDER,
      otp: api.OTP_PROVIDER,
      api_worker_database_matches: true,
      live_render_auto_deploy: "not_observed",
      blueprint_auto_deploy: "off",
    };
    result.migrations = ledger.map((row) => row.name);
    result.migration_006_sha256 = hashes["006_wallet_login.sql"];
    const preserved: Record<string, unknown> = {};
    for (const table of [
      "users",
      "sessions",
      "otp_challenges",
      "links",
      "link_slots",
      "principals",
    ]) {
      const rows = (
        await client.query(`SELECT to_jsonb(t)::text AS row FROM muuve.${table} t ORDER BY id`)
      ).rows;
      const digest = createHmac("sha256", process.env.SESSION_SECRET!);
      for (const row of rows) digest.update(row.row).update("\n");
      preserved[table] = { count: rows.length, private_keyed_fingerprint: digest.digest("hex") };
    }
    result.existing_records = preserved;
    const violations = (
      await client.query(`SELECT
      (SELECT count(*)::int FROM muuve.users WHERE NOT ((auth_origin='wallet' AND wallet_address IS NOT NULL) OR (auth_origin!='wallet' AND phone_e164 IS NOT NULL))) AS users,
      (SELECT count(*)::int FROM muuve.sessions WHERE NOT ((purpose='account' AND user_id IS NOT NULL) OR (purpose IN ('claim','proof') AND phone_e164 IS NOT NULL))) AS sessions,
      (SELECT count(*)::int FROM muuve.principals WHERE source!='wallet' AND owner_phone IS NULL) AS principals`)
    ).rows[0];
    assert(
      Object.values(violations).every((n) => n === 0),
      "existing_rows_violate_new_identity_constraints",
    );
    result.new_constraint_existing_row_violations = violations;
    const present = (
      await client.query(
        "SELECT to_regclass('muuve.wallet_auth_challenges') IS NOT NULL AS present",
      )
    ).rows[0].present;
    assert(present === (stage === "after"), "wallet_challenge_table_state_mismatch");
    result.wallet_challenge_table_present = present;
    const columns = (
      await client.query(
        "SELECT table_name,column_name,is_nullable FROM information_schema.columns WHERE table_schema='muuve' AND (table_name,column_name) IN (('users','phone_e164'),('sessions','phone_e164'),('principals','owner_phone')) ORDER BY table_name,column_name",
      )
    ).rows;
    assert(
      columns.length === 3 &&
        columns.every((column) => column.is_nullable === (stage === "after" ? "YES" : "NO")),
      "phone_nullability_mismatch",
    );
    result.phone_columns = columns;
    if (stage === "after") {
      const before = JSON.parse(await readFile(`${folder}/before.json`, "utf8"));
      assert(
        before.migration_006_sha256 === hashes["006_wallet_login.sql"],
        "reviewed_migration_hash_changed",
      );
      assert(
        JSON.stringify(before.existing_records) === JSON.stringify(preserved),
        "existing_records_changed_since_preflight",
      );
      result.existing_records_unchanged = true;
      const constraints = (
        await client.query(
          "SELECT t.relname AS table_name,c.conname AS name,c.convalidated AS validated,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='muuve' AND (t.relname='wallet_auth_challenges' OR c.conname IN ('users_identity_required','users_auth_origin_check','sessions_identity_required','principal_recipient_phone_required')) ORDER BY t.relname,c.conname",
        )
      ).rows;
      for (const name of [
        "users_identity_required",
        "users_auth_origin_check",
        "sessions_identity_required",
        "principal_recipient_phone_required",
      ])
        assert(
          constraints.some((constraint) => constraint.name === name && constraint.validated),
          "identity_constraint_missing_or_unvalidated",
        );
      assert(
        constraints.filter((constraint) => constraint.table_name === "wallet_auth_challenges")
          .length >= 4 && constraints.every((constraint) => constraint.validated),
        "challenge_constraints_missing",
      );
      result.constraints = constraints;
      const indexes = (
        await client.query(
          "SELECT i.relname AS name,pg_get_indexdef(i.oid) AS definition,x.indisvalid AS valid,x.indisready AS ready FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='muuve' AND t.relname='wallet_auth_challenges' ORDER BY i.relname",
        )
      ).rows;
      assert(
        indexes.length === 4 && indexes.every((index) => index.valid && index.ready),
        "challenge_indexes_missing_or_invalid",
      );
      result.challenge_indexes = indexes;
      const permissions = (
        await client.query(`SELECT t.relrowsecurity AS rls_enabled,
        NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(t.relacl,acldefault('r',t.relowner))) a WHERE a.grantee=0) AS public_table_blocked,
        NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE a.grantee=0 AND a.privilege_type='USAGE') AS public_schema_blocked
        FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='muuve' AND t.relname='wallet_auth_challenges'`)
      ).rows[0];
      assert(
        permissions?.rls_enabled &&
          permissions.public_table_blocked &&
          permissions.public_schema_blocked,
        "challenge_permissions_not_restricted",
      );
      result.challenge_permissions = permissions;
    }
    await client.query("COMMIT");
    result.state =
      stage === "before"
        ? "preflight_passed_migration_not_applied"
        : "hosted_migration_and_record_preservation_verified";
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
} catch (error) {
  result.state = "blocked_or_failed";
  result.code =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "configuration_or_database_check_failed";
  process.exitCode = 1;
} finally {
  await pool?.end();
}
await mkdir(folder, { recursive: true });
await writeFile(`${folder}/${stage}.json`, JSON.stringify(result, null, 2) + "\n");
console.info(JSON.stringify(result));
