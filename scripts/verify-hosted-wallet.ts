import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createPrivateKey, sign, randomUUID, randomBytes, createHash } from "node:crypto";
import { Keypair, Transaction } from "@solana/web3.js";
import { PrivyClient, generateAuthorizationSignatures } from "@privy-io/node";
import { jwtVerify, createLocalJWKSet } from "jose";
import bs58 from "bs58";
import pg from "pg";
import { Chain } from "../apps/web/lib/server/solana/chain";
import { reconcileOperation } from "../apps/web/lib/server/operations";
import { closeDatabase } from "../apps/web/lib/server/db";

const file = "keys/hosted-wallet-test.json";
const folder = "evidence/wallet-hosted";
const mode = process.argv.find((v) =>
  ["--start", "--prepare-only", "--privy-token-check", "--finish"].includes(v),
);
const evidence: Record<string, any> = {
  started_at: new Date().toISOString(),
  mode,
  checks: [],
  requests: [],
  chain_transactions_submitted: 0,
  payout_requests: 0,
};
function assert(v: unknown, code: string): asserts v {
  if (!v) throw Error(code);
}
const checked = (name: string, detail: Record<string, unknown> = {}) =>
  evidence.checks.push({ name, state: "passed", ...detail });
let pool: pg.Pool | undefined;
let progress: any;
let lastStage = "preflight";
async function main() {
  assert(
    mode && process.argv.includes("--operator-approved-auth-test"),
    "explicit_hosted_auth_test_required",
  );
  const api = parseEnv(await readFile(".env.render-api", "utf8")),
    local = parseEnv(await readFile(".env.local", "utf8"));
  assert(
    api.APP_BASE_URL === "https://muuve.onrender.com" &&
      api.APP_ENV === "preview" &&
      api.SOLANA_CLUSTER === "devnet" &&
      api.PAYOUT_PROVIDER === "mock",
    "intended_hosted_configuration_required",
  );
  const target = new URL(local.DATABASE_URL!),
    exported = new URL(api.DATABASE_URL!);
  assert(
    target.hostname === "aws-0-eu-west-1.pooler.supabase.com" &&
      decodeURIComponent(target.username) === "postgres.yirelxmcveyxcqofzayq" &&
      target.port === "5432" &&
      target.searchParams.get("sslmode") === "verify-full" &&
      target.username === exported.username &&
      target.password === exported.password &&
      target.hostname === exported.hostname,
    "hosted_sql_target_mismatch",
  );
  pool = new pg.Pool({
    connectionString: local.DATABASE_URL,
    options: "-c search_path=muuve,public",
    connectionTimeoutMillis: 15000,
    max: 1,
  });
  assert(
    (await pool.query("SELECT count(*)::int AS n FROM public.muuve_migrations")).rows[0].n === 6,
    "six_migrations_required",
  );
  const manifest = JSON.parse(await readFile("config/devnet-public.json", "utf8"));
  async function load(role: string) {
    const path = `keys/devnet/${role}.json`;
    assert(((await stat(path)).mode & 0o077) === 0, "private_wallet_permissions_required");
    const key = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(path, "utf8"))));
    assert(
      key.publicKey.toBase58() === manifest.roles[role].public_key,
      "test_wallet_manifest_mismatch",
    );
    return key;
  }
  const sender = await load("test-sender"),
    other = await load("test-recipient");
  const signMessage = (key: Keypair, message: string) =>
    bs58.encode(
      sign(
        null,
        Buffer.from(message, "utf8"),
        createPrivateKey({
          key: Buffer.concat([
            Buffer.from("302e020100300506032b657004220420", "hex"),
            key.secretKey.slice(0, 32),
          ]),
          type: "pkcs8",
          format: "der",
        }),
      ),
    );
  try {
    assert(((await stat(file)).mode & 0o077) === 0, "private_progress_permissions_required");
    progress = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    progress = {
      origin: api.APP_BASE_URL,
      sender: sender.publicKey.toBase58(),
      phase: "new",
      cookies: {},
    };
  }
  assert(
    progress.origin === api.APP_BASE_URL && progress.sender === sender.publicKey.toBase58(),
    "private_progress_target_mismatch",
  );
  const save = () => writeFile(file, JSON.stringify(progress, null, 2) + "\n", { mode: 0o600 });
  await save();
  const header = (jar: Record<string, string>) =>
    Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  async function call(
    path: string,
    status: number,
    body?: unknown,
    jar = progress.cookies as Record<string, string>,
    origin: string = api.APP_BASE_URL!,
  ) {
    assert(
      !/\/submit(?:$|\/)|^\/api\/fund\/|^\/api\/cron\/|^\/api\/payouts\//.test(path),
      "financial_submission_and_global_worker_calls_forbidden",
    );
    lastStage = path;
    const response = await fetch(api.APP_BASE_URL + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "content-type": "application/json", cookie: header(jar) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(45000),
    });
    const raw = await response.text();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {}
    evidence.requests.push({
      path,
      method: body === undefined ? "GET" : "POST",
      status: response.status,
      ...(typeof data?.error === "string" && /^[a-z_]+$/.test(data.error)
        ? { error_code: data.error }
        : {}),
      ...(typeof data?.request_id === "string" && /^[0-9a-f-]{36}$/.test(data.request_id)
        ? { request_id: data.request_id }
        : {}),
    });
    assert(response.status === status, `unexpected_http_${response.status}`);
    assert(
      data && response.headers.get("content-type")?.includes("application/json"),
      "json_response_required",
    );
    if (status >= 400) {
      assert(
        typeof data.error === "string" &&
          typeof data.request_id === "string" &&
          Object.keys(data).every((k) => ["error", "request_id"].includes(k)),
        "redacted_error_schema_required",
      );
      for (const value of [
        api.SESSION_SECRET,
        api.PRIVY_APP_SECRET,
        api.AUTH_JWT_PRIVATE_KEY,
        api.DATABASE_URL,
      ])
        assert(!value || !raw.includes(value), "private_configuration_leaked");
    }
    for (const value of response.headers.getSetCookie()) {
      assert(
        value.includes("HttpOnly") && value.includes("Secure") && value.includes("SameSite=Lax"),
        "cookie_flags_required",
      );
      const pair = value.split(";")[0]!,
        i = pair.indexOf("="),
        name = pair.slice(0, i),
        token = pair.slice(i + 1);
      assert(
        ["muuve_session", "muuve_claim", "muuve_phone_proof", "muuve_wallet_challenge"].includes(
          name,
        ),
        "unexpected_cookie",
      );
      if (token) jar[name] = token;
      else delete jar[name];
    }
    return data;
  }
  async function makeChallenge(key: Keypair) {
    const jar: Record<string, string> = {};
    const data = await call(
      "/api/auth/wallet/challenge",
      200,
      { wallet_address: key.publicKey.toBase58() },
      jar,
    );
    assert(
      typeof data.message === "string" &&
        data.message.includes(`URI: ${api.APP_BASE_URL}\nVersion: 1\nChain ID: devnet`) &&
        data.message.includes(key.publicKey.toBase58()),
      "challenge_binding_invalid",
    );
    const issued = /Issued At: ([^\n]+)/.exec(data.message)?.[1],
      expires = /Expiration Time: ([^\n]+)/.exec(data.message)?.[1];
    assert(
      issued &&
        expires &&
        new Date(expires).getTime() - new Date(issued).getTime() === 300000 &&
        expires === data.expires_at,
      "challenge_lifetime_invalid",
    );
    const db = (
      await pool!.query("SELECT * FROM wallet_auth_challenges WHERE id=$1", [data.challenge_id])
    ).rows[0];
    assert(
      db?.wallet_address === key.publicKey.toBase58() &&
        db.origin === api.APP_BASE_URL &&
        db.message === data.message &&
        db.browser_hash === createHash("sha256").update(jar.muuve_wallet_challenge!).digest("hex"),
      "hosted_challenge_sql_binding_invalid",
    );
    return { ...data, cookies: jar };
  }
  async function accountRow() {
    const token = progress.cookies.muuve_session;
    assert(token, "real_account_cookie_required");
    const result = await jwtVerify(token, new TextEncoder().encode(api.SESSION_SECRET), {
      algorithms: ["HS256"],
      issuer: "muuve",
      audience: "muuve:account",
    });
    const row = (await pool!.query("SELECT * FROM sessions WHERE id=$1", [result.payload.sid]))
      .rows[0];
    assert(
      row?.user_id === progress.user_id &&
        row.phone_e164 === null &&
        row.purpose === "account" &&
        row.revoked_at === null,
      "real_phone_less_account_session_required",
    );
    return row;
  }
  if (mode === "--start") {
    assert(progress.phase === "new", "existing_test_state_preserved_use_prepare_or_finish");
    const health = await call("/api/health", 200, undefined, {});
    assert(health.chain === "devnet" && health.payouts === "mock", "hosted_health_safety_mismatch");
    await call("/api/me", 401, undefined, {});
    await call(
      "/api/auth/wallet/challenge",
      403,
      { wallet_address: progress.sender },
      {},
      "https://untrusted.example",
    );
    progress.phase = "issuing_challenge";
    await save();
    const c = await makeChallenge(sender);
    progress.challenge = c;
    progress.phase = "challenge_issued";
    await save();
    checked("actual_hosted_challenge_domain_cookie_lifetime_and_sql_binding");
    const signature = signMessage(sender, c.message);
    await call("/api/auth/wallet/login", 401, { challenge_id: c.challenge_id, signature }, {});
    await call(
      "/api/auth/wallet/login",
      403,
      { challenge_id: c.challenge_id, signature },
      { ...c.cookies },
      "https://untrusted.example",
    );
    await call(
      "/api/auth/wallet/login",
      401,
      { challenge_id: c.challenge_id, signature: signMessage(other, c.message) },
      { ...c.cookies },
    );
    await call(
      "/api/auth/wallet/login",
      401,
      { challenge_id: c.challenge_id, signature: signMessage(sender, c.message + "\nchanged") },
      { ...c.cookies },
    );
    checked("missing_cookie_foreign_origin_wrong_wallet_and_tampered_message_rejected");
    progress.cookies = { ...c.cookies };
    progress.phase = "login_started";
    await save();
    const logged = await call("/api/auth/wallet/login", 200, {
      challenge_id: c.challenge_id,
      signature,
    });
    assert(
      logged.user.wallet_address === progress.sender &&
        logged.user.auth_origin === "wallet" &&
        typeof logged.user.id === "string" &&
        !("phone_e164" in logged.user),
      "expected_wallet_identity_required",
    );
    progress.user_id = logged.user.id;
    progress.phase = "authenticated";
    await save();
    const me = await call("/api/me", 200);
    assert(
      me.user.id === progress.user_id && me.user.wallet_address === progress.sender,
      "hosted_me_identity_mismatch",
    );
    await accountRow();
    const consumed = (
      await pool!.query("SELECT consumed_at,attempts FROM wallet_auth_challenges WHERE id=$1", [
        c.challenge_id,
      ])
    ).rows[0];
    assert(
      consumed.consumed_at && consumed.attempts === 3,
      "durable_attempt_and_consumption_invalid",
    );
    checked("actual_signature_creates_hosted_wallet_only_session_and_me", {
      user_id: progress.user_id,
      wallet_address: progress.sender,
    });
    await call(
      "/api/auth/wallet/login",
      401,
      { challenge_id: c.challenge_id, signature },
      { ...c.cookies },
    );
    checked("consumed_challenge_replay_rejected");
    const jwt = await call("/api/auth/privy-token", 200),
      jwks = await call("/api/auth/jwks", 200, undefined, {});
    const verified = await jwtVerify(jwt.token, createLocalJWKSet(jwks), {
      algorithms: ["ES256"],
      issuer: api.APP_BASE_URL,
      audience: api.NEXT_PUBLIC_PRIVY_APP_ID,
      requiredClaims: ["sub", "iat", "exp"],
    });
    assert(
      verified.payload.sub === progress.user_id &&
        verified.protectedHeader.kid === api.AUTH_JWT_KID &&
        Number(verified.payload.exp) - Number(verified.payload.iat) === 300 &&
        jwks.keys.every((k: any) => !("d" in k)),
      "hosted_bridge_contract_mismatch",
    );
    checked("actual_hosted_bridge_jwt_and_jwks_contract_verified");
    const id = randomUUID();
    await call(`/api/claims/${id}/share`, 401);
    await call(`/api/claims/${id}/intent/prepare`, 401, { path: "keep" });
    checked("wallet_account_without_phone_proof_cannot_access_claim_routes");
    const missing = await call(`/api/operations/${randomUUID()}`, 404);
    assert(missing.error === "not_found", "missing_operation_error_mismatch");
    checked("missing_operation_now_returns_redacted_json_404");
    const live = JSON.parse(await readFile("keys/privy-live-test.json", "utf8"));
    const client = new PrivyClient({
      appId: api.NEXT_PUBLIC_PRIVY_APP_ID!,
      appSecret: api.PRIVY_APP_SECRET!,
      timeout: 15000,
      maxRetries: 0,
    });
    const known = await client.users().getByCustomAuthID({ custom_user_id: live.user_id });
    const wallet = known.linked_accounts.find(
      (a) => a.type === "wallet" && a.chain_type === "solana" && a.wallet_client_type === "privy",
    );
    assert(
      known.id === live.privy_user_id && wallet?.type === "wallet",
      "existing_privy_identity_mismatch",
    );
    checked("existing_dedicated_privy_test_identity_recognized", {
      wallet_address: wallet.address,
      identity_scope: "previous local integration identity; distinct from new hosted sender",
    });
    try {
      const current = await client.users().getByCustomAuthID({ custom_user_id: progress.user_id });
      evidence.hosted_sender_privy_record = { exists: true, id: current.id };
    } catch (e) {
      assert((e as { status?: number }).status === 404, "privy_lookup_unavailable");
      evidence.hosted_sender_privy_record = {
        exists: false,
        missing_step:
          "real Privy client authentication/enrollment for the hosted identity; no fake record created",
      };
    }
    const denied = await call("/api/auth/wallet", 403, { wallet_address: wallet.address });
    assert(denied.error === "wallet_not_owned", "unowned_privy_wallet_error_mismatch");
    assert(
      (await call("/api/me", 200)).user.wallet_address === progress.sender,
      "funding_wallet_changed",
    );
    checked("unowned_privy_wallet_now_returns_redacted_403_and_preserves_funding_wallet");
    const old = { ...progress.cookies };
    await call("/api/auth/refresh", 200, {});
    await save();
    await call("/api/me", 401, undefined, old);
    assert(
      (await call("/api/me", 200)).user.id === progress.user_id,
      "refreshed_identity_mismatch",
    );
    await accountRow();
    checked("hosted_refresh_revokes_old_cookie_and_preserves_wallet_identity");
    progress.expiry = await makeChallenge(sender);
    progress.phase = "waiting_for_natural_expiry";
    await save();
    evidence.wait_until = progress.expiry.expires_at;
    evidence.state = "hosted_auth_passed_natural_expiry_and_logout_pending";
  } else if (mode === "--privy-token-check") {
    assert(progress.phase === "waiting_for_natural_expiry", "authenticated_hosted_test_required");
    await accountRow();
    const token = await call("/api/auth/privy-token", 200);
    const jwks = await call("/api/auth/jwks", 200, undefined, {});
    await jwtVerify(token.token, createLocalJWKSet(jwks), {
      algorithms: ["ES256"],
      issuer: api.APP_BASE_URL,
      audience: api.NEXT_PUBLIC_PRIVY_APP_ID,
    });
    const client = new PrivyClient({
      appId: api.NEXT_PUBLIC_PRIVY_APP_ID!,
      appSecret: api.PRIVY_APP_SECRET!,
      timeout: 15000,
      maxRetries: 0,
    });
    lastStage = "real_privy_authorization_exchange_for_hosted_jwt";
    try {
      // This exported SDK function exchanges the actual hosted JWT for user authorization
      // and signs a diagnostic request locally. It does not dispatch the wallet request.
      const signatures = await generateAuthorizationSignatures(client, {
        authorizationContext: { user_jwts: [token.token] },
        input: {
          version: 1,
          method: "POST",
          url: "https://api.privy.io/v1/wallets/auth-verification-only/rpc",
          body: { diagnostic: "No wallet RPC or blockchain transaction submitted" },
          headers: { "privy-app-id": api.NEXT_PUBLIC_PRIVY_APP_ID! },
        },
      });
      assert(signatures.length === 1, "privy_authorization_exchange_failed");
      checked("actual_hosted_muuve_jwt_accepted_by_real_privy_authorization_exchange", {
        wallet_rpc_dispatched: false,
      });
      progress.hosted_jwt_privy_accepted = true;
      await save();
      evidence.state = "actual_hosted_jwt_accepted_by_privy";
    } catch (error) {
      evidence.state = "privy_authorization_exchange_blocked";
      evidence.provider_http_status = (error as { status?: number }).status ?? null;
      evidence.note = "No fake user or wallet record created to bypass provider authentication";
      process.exitCode = 1;
    }
  } else if (mode === "--prepare-only") {
    assert(
      progress.phase === "waiting_for_natural_expiry" && !progress.batch,
      "authenticated_state_required_no_duplicate_preparation",
    );
    await accountRow();
    const counts = (
      await pool.query(
        "SELECT (SELECT count(*) FROM operations)::int AS operations,(SELECT count(*) FROM payouts)::int AS payouts,(SELECT count(*) FROM jobs WHERE state IN ('pending','running'))::int AS jobs",
      )
    ).rows[0];
    assert(
      counts.operations === 0 && counts.payouts === 0 && counts.jobs === 0,
      "quiescent_financial_state_required",
    );
    const balance = await call("/api/balance", 200);
    assert(
      BigInt(balance.amount_base_units) >= 1500000n,
      "insufficient_existing_test_balance_no_funding_requested",
    );
    const phones = JSON.parse(await readFile("keys/hosted-test-phones.json", "utf8"));
    const request = {
      link_id_hex: randomBytes(16).toString("hex"),
      claim_pubkey: manifest.roles["test-claim"].public_key,
      recipients: [
        { phone_e164: phones.wallet_recipient, amount_base_units: "500000" },
        { phone_e164: phones.cashout_recipient, amount_base_units: "1000000" },
      ],
    };
    progress.batch = { phase: "preparing", request };
    await save();
    const prepared = await call("/api/links/prepare", 200, request);
    const tx = Transaction.from(Buffer.from(prepared.tx, "base64"));
    assert(
      tx.signatures.some((s) => s.publicKey.equals(sender.publicKey) && s.signature === null),
      "prepared_create_must_remain_unsigned_by_sender",
    );
    progress.batch = {
      ...progress.batch,
      phase: "prepared_not_submitted",
      operation_id: prepared.operation_id,
      link_id: prepared.link.id,
      last_valid_block_height: prepared.last_valid_block_height,
      signature: prepared.signature,
    };
    await save();
    const slots = (
      await pool.query(
        "SELECT recipient_phone_e164,amount_base_units,slot_index,status FROM link_slots WHERE link_id=$1 ORDER BY slot_index",
        [prepared.link.id],
      )
    ).rows;
    assert(
      slots.length === 2 &&
        slots.every(
          (s, i) =>
            s.recipient_phone_e164 === request.recipients[i]!.phone_e164 &&
            s.amount_base_units === request.recipients[i]!.amount_base_units &&
            s.status === "pending",
        ),
      "fixed_slot_persistence_mismatch",
    );
    assert(
      (await call(`/api/operations/${prepared.operation_id}`, 200)).operation_id ===
        prepared.operation_id,
      "owner_operation_access_failed",
    );
    checked("real_hosted_batch_preparation_fixed_allocations_and_owner_operation_access", {
      operation_id: prepared.operation_id,
      link_id: prepared.link.id,
      allocations: ["500000", "1000000"],
      submitted: false,
    });
    const c = await makeChallenge(other),
      jar = { ...c.cookies };
    const user = await call(
      "/api/auth/wallet/login",
      200,
      { challenge_id: c.challenge_id, signature: signMessage(other, c.message) },
      jar,
    );
    progress.foreign = { cookies: jar, user_id: user.user.id };
    await save();
    const foreign = await call(`/api/operations/${prepared.operation_id}`, 404, undefined, jar);
    assert(foreign.error === "not_found", "foreign_operation_not_redacted");
    checked("genuine_foreign_operation_returns_redacted_404");
    await call("/api/auth/logout", 200, {}, jar);
    progress.foreign.cookies = {};
    await save();
    evidence.state = "batch_prepared_never_submitted_pending_expiry_reconciliation";
  } else {
    assert(progress.phase === "waiting_for_natural_expiry", "unfinished_auth_test_required");
    const expiry = (
      await pool.query(
        "SELECT expires_at<=clock_timestamp() AS expired FROM wallet_auth_challenges WHERE id=$1",
        [progress.expiry.challenge_id],
      )
    ).rows[0];
    if (!expiry?.expired) {
      evidence.state = "waiting_for_natural_challenge_expiry";
      evidence.wait_until = progress.expiry.expires_at;
      return;
    }
    const response = await call(
      "/api/auth/wallet/login",
      401,
      {
        challenge_id: progress.expiry.challenge_id,
        signature: signMessage(sender, progress.expiry.message),
      },
      { ...progress.expiry.cookies },
    );
    assert(response.error === "invalid_wallet_challenge", "expired_challenge_error_mismatch");
    checked("naturally_expired_real_hosted_challenge_rejected");
    if (progress.batch?.phase === "prepared_not_submitted") {
      const op = (
        await pool.query("SELECT * FROM operations WHERE id=$1", [progress.batch.operation_id])
      ).rows[0];
      assert(
        op?.kind === "create" && op.actor_user_id === progress.user_id,
        "scoped_preparation_required",
      );
      const chain = new Chain();
      chain.send = async () => {
        throw Error("chain_submission_forbidden_in_auth_verification");
      };
      await chain.readiness();
      assert(
        (await chain.height()) > progress.batch.last_valid_block_height,
        "prepared_blockhash_not_expired_keep_reservation",
      );
      const reconciled = await reconcileOperation(op.id, chain);
      assert(reconciled.state === "failed", "unsubmitted_create_outcome_not_terminal");
      const link = (
        await pool.query("SELECT status,capacity_state FROM links WHERE id=$1", [
          progress.batch.link_id,
        ])
      ).rows[0];
      assert(
        link.status === "cancelled" && link.capacity_state === "released",
        "preparation_capacity_not_released",
      );
      progress.batch.phase = "expired_cancelled_capacity_released";
      await save();
      checked(
        "local_reconciler_with_hosted_sql_and_real_devnet_verifies_unsubmitted_preparation_terminal",
        {
          operation_id: op.id,
          capacity_released: true,
          execution_location: "local backend function; not hosted cron",
        },
      );
    }
    const cookie = { ...progress.cookies };
    await call("/api/auth/logout", 200, {});
    await save();
    await call("/api/me", 401, undefined, cookie);
    await call("/api/auth/privy-token", 401, undefined, cookie);
    checked("hosted_logout_revokes_real_session_and_bridge_access");
    progress.phase = "complete";
    progress.cookies = {};
    progress.challenge.cookies = {};
    progress.expiry.cookies = {};
    await save();
    evidence.state = "hosted_wallet_authentication_and_negative_cases_verified";
    evidence.unverified = [
      "natural 30-day account-session expiry; no session fabricated or shortened",
      "real upstream provider outage HTTP 503 mapping; tested locally, not forced on hosted",
      "new hosted sender Privy enrollment/signing via browser client",
      "funded hosted claims and mock cashout",
    ];
  }
}
try {
  await main();
} catch (e) {
  evidence.state = "failed_or_blocked";
  evidence.stage = lastStage;
  evidence.code =
    e instanceof Error && /^[a-z0-9_]+$/.test(e.message)
      ? e.message
      : "configuration_or_transport_failure";
  process.exitCode = 1;
} finally {
  await pool?.end();
  await closeDatabase();
}
await mkdir(folder, { recursive: true });
evidence.finished_at = new Date().toISOString();
await writeFile(
  `${folder}/${mode?.slice(2) ?? "error"}.json`,
  JSON.stringify(evidence, null, 2) + "\n",
);
console.info(JSON.stringify(evidence));
