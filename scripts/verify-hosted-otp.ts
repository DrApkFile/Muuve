import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { parseEnv } from "node:util";
import { exportJWK, createLocalJWKSet, jwtVerify } from "jose";
import { phone, uuid } from "@muuve/shared";
import { createPublicKey, createPrivateKey } from "node:crypto";
import pg from "pg";

const privateFile = "keys/hosted-test-auth.json";
const evidenceFile = "evidence/hosted-e2e/hosted-otp.json";
const roles = ["sender", "wallet_recipient", "cashout_recipient"] as const;
type Role = (typeof roles)[number];
type Progress = {
  origin: string;
  roles: Partial<
    Record<
      Role,
      {
        state: string;
        started_at?: string;
        challenge_id?: string;
        code?: string;
        cookies?: Record<string, string>;
        user_id?: string;
        link_id?: string;
        challenge_history?: { challenge_id: string; state: string }[];
      }
    >
  >;
};
const evidence: Record<string, unknown> = {
  checked_at: new Date().toISOString(),
  scope: "Actual hosted OTP, no local mock or session fabrication",
  calls: [],
  live_sms_requested: false,
};
function assert(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
async function main() {
  const api = parseEnv(await readFile(".env.render-api", "utf8")) as Record<string, string>;
  const phonesFile = "keys/hosted-test-phones.json",
    phones = JSON.parse(await readFile(phonesFile, "utf8"));
  assert(
    ((await stat(phonesFile)).mode & 0o077) === 0 && phones.authorize_sms === true,
    "authorized_private_phone_configuration_required",
  );
  for (const role of roles)
    assert(phone.safeParse(phones[role]).success, "valid_authorized_numbers_required");
  assert(
    new Set(roles.map((role) => phones[role])).size === 3,
    "distinct_phone_identities_required",
  );
  assert(
    api.APP_BASE_URL === "https://muuve.onrender.com" &&
      api.APP_ENV === "preview" &&
      api.OTP_PROVIDER === "twilio" &&
      api.SOLANA_CLUSTER === "devnet" &&
      api.PAYOUT_PROVIDER === "mock",
    "hosted_configuration_mismatch",
  );
  const action = process.argv.find(
    (arg) => arg.startsWith("--send=") || arg.startsWith("--verify="),
  );
  assert(action, "explicit_otp_action_required");
  const role = action.split("=")[1] as Role;
  assert(roles.includes(role), "invalid_test_role");
  let progress: Progress;
  try {
    assert(
      ((await stat(privateFile)).mode & 0o077) === 0,
      "private_auth_file_permissions_required",
    );
    progress = JSON.parse(await readFile(privateFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    progress = { origin: api.APP_BASE_URL, roles: {} };
  }
  assert(progress.origin === api.APP_BASE_URL, "auth_progress_origin_mismatch");
  const entry = progress.roles[role] ?? { state: "new", code: "", cookies: {} };
  progress.roles[role] = entry;
  evidence.role = role;
  const save = () =>
    writeFile(privateFile, JSON.stringify(progress, null, 2) + "\n", { mode: 0o600 });
  async function call(path: string, data?: unknown) {
    const response = await fetch(api.APP_BASE_URL + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        origin: api.APP_BASE_URL,
        "content-type": "application/json",
        cookie: Object.entries(entry.cookies ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: AbortSignal.timeout(45000),
      redirect: "manual",
    });
    const body = await response.json();
    (evidence.calls as unknown[]).push({
      path,
      status: response.status,
      ...(typeof body.error === "string" && /^[a-z_]+$/.test(body.error)
        ? { error_code: body.error }
        : {}),
      ...(typeof body.request_id === "string" && uuid.safeParse(body.request_id).success
        ? { request_id: body.request_id }
        : {}),
    });
    assert(response.status === 200, `hosted_http_${response.status}`);
    for (const value of response.headers.getSetCookie()) {
      assert(
        value.includes("HttpOnly") && value.includes("Secure") && value.includes("SameSite=Lax"),
        "cookie_flags_missing",
      );
      const pair = value.split(";")[0]!,
        i = pair.indexOf("="),
        name = pair.slice(0, i),
        token = pair.slice(i + 1);
      assert(
        ["muuve_session", "muuve_claim", "muuve_phone_proof"].includes(name),
        "unexpected_session_cookie",
      );
      entry.cookies ??= {};
      if (token) entry.cookies[name] = token;
      else delete entry.cookies[name];
    }
    return body;
  }
  if (action.startsWith("--send=")) {
    if (process.argv.includes("--new-challenge")) {
      assert(entry.challenge_id && !entry.user_id, "unverified_existing_challenge_required");
      assert((entry.challenge_history?.length ?? 0) < 1, "one_resend_limit_reached");
      const local = parseEnv(await readFile(".env.local", "utf8"));
      const db = new URL(local.DATABASE_URL ?? ""),
        expected = new URL(api.DATABASE_URL);
      assert(
        db.hostname === expected.hostname &&
          db.username === expected.username &&
          db.password === expected.password &&
          db.pathname === expected.pathname &&
          db.searchParams.get("sslmode") === "verify-full",
        "database_target_mismatch",
      );
      const pool = new pg.Pool({
        connectionString: local.DATABASE_URL,
        connectionTimeoutMillis: 15000,
        options: "-c search_path=muuve,public",
      });
      try {
        const old = (
          await pool.query(
            "SELECT expires_at<=now() AS expired,status FROM otp_challenges WHERE id=$1 AND phone_e164=$2",
            [entry.challenge_id, phones[role]],
          )
        ).rows[0];
        assert(old?.expired && old.status !== "verified", "challenge_must_expire_before_resend");
      } finally {
        await pool.end();
      }
      entry.challenge_history ??= [];
      entry.challenge_history.push({
        challenge_id: entry.challenge_id,
        state: "expired_without_verification",
      });
      delete entry.challenge_id;
      entry.state = "new";
      entry.code = "";
      await save();
    }
    if (entry.state !== "new") {
      evidence.state = "existing_attempt_preserved";
      evidence.progress_state = entry.state;
    } else {
      let linkId: string | undefined;
      if (role !== "sender") {
        linkId = process.argv.find((arg) => arg.startsWith("--link-id="))?.slice(10);
        assert(uuid.safeParse(linkId).success, "recipient_requires_actual_link_id");
      }
      entry.state = "send_started";
      entry.started_at = new Date().toISOString();
      if (linkId) entry.link_id = linkId;
      await save();
      evidence.live_sms_requested = true;
      const body = await call("/api/auth/otp/send", {
        phone_e164: phones[role],
        purpose: role === "sender" ? "account" : "claim",
        channel: "sms",
        ...(linkId ? { link_id: linkId } : {}),
      });
      assert(
        body.sent === true && uuid.safeParse(body.challenge_id).success,
        "unexpected_send_response",
      );
      entry.challenge_id = body.challenge_id;
      entry.state = "challenge_sent";
      entry.code = "";
      await save();
      evidence.state = "waiting_for_owner_code";
      evidence.private_code_location = `${privateFile}:roles.${role}.code`;
    }
  } else {
    assert(
      entry.state === "challenge_sent" && entry.challenge_id && /^\d{6}$/.test(entry.code ?? ""),
      "pending_challenge_and_private_code_required",
    );
    // One verification per invocation; never guess or print the supplied OTP.
    const code = entry.code;
    entry.code = "";
    entry.state = "verify_started";
    await save();
    let body;
    try {
      body = await call("/api/auth/otp/verify", { challenge_id: entry.challenge_id, code });
    } catch (error) {
      entry.state =
        error instanceof Error && error.message === "hosted_http_401"
          ? "challenge_sent"
          : "verification_outcome_unknown";
      await save();
      throw error;
    }
    entry.state = "phone_verified";
    await save();
    if (role === "sender" && body.needs_signup)
      await call("/api/auth/signup", { display_name: "Hosted E2E Sender", origin: "muuve" });
    if (role === "sender") {
      const me = await call("/api/me");
      assert(uuid.safeParse(me.user?.id).success, "hosted_account_identity_required");
      entry.user_id = me.user.id;
      await save();
      const sessionToken = entry.cookies?.muuve_session;
      assert(sessionToken, "hosted_account_cookie_required");
      const sessionProof = await jwtVerify(
        sessionToken,
        new TextEncoder().encode(api.SESSION_SECRET),
        {
          algorithms: ["HS256"],
          issuer: "muuve",
          audience: "muuve:account",
        },
      );
      assert(
        sessionProof.payload.purpose === "account" &&
          uuid.safeParse(sessionProof.payload.sid).success,
        "hosted_session_contract_mismatch",
      );
      evidence.session_signing_configuration_matches = true;
      const bridge = await call("/api/auth/privy-token"),
        keys = await call("/api/auth/jwks"),
        expected = await exportJWK(createPublicKey(createPrivateKey(api.AUTH_JWT_PRIVATE_KEY)));
      assert(
        Array.isArray(keys.keys) &&
          keys.keys.length === 1 &&
          keys.keys[0].x === expected.x &&
          keys.keys[0].y === expected.y,
        "hosted_signing_identity_mismatch",
      );
      const verified = await jwtVerify(bridge.token, createLocalJWKSet(keys), {
        algorithms: ["ES256"],
        issuer: api.APP_BASE_URL,
        audience: api.NEXT_PUBLIC_PRIVY_APP_ID,
      });
      assert(
        verified.payload.sub === entry.user_id && verified.protectedHeader.kid === api.AUTH_JWT_KID,
        "hosted_token_claim_mismatch",
      );
      evidence.account_session_verified = true;
      evidence.privy_bridge_claims_verified = true;
      evidence.test_user_id = entry.user_id;
    }
    entry.state = "verified";
    await save();
    evidence.state = "verified_through_hosted_api";
  }
}
try {
  await main();
} catch (error) {
  evidence.state = "blocked_or_failed";
  evidence.code =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "configuration_or_transport_failure";
  process.exitCode = 1;
}
await mkdir("evidence/hosted-e2e", { recursive: true });
await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
console.info(JSON.stringify(evidence));
