import { readFile, writeFile, stat } from "node:fs/promises";
import { parseEnv } from "node:util";

const privateFile = "keys/hosted-test-auth.json";
const evidence: { checked_at: string; state: string; requests: unknown[]; code?: string } = {
  checked_at: new Date().toISOString(),
  state: "in_progress",
  requests: [],
};
function assert(value: unknown, code: string): asserts value {
  if (!value) throw Error(code);
}
async function main() {
  assert(process.argv.includes("--close-test-session"), "explicit_session_cleanup_required");
  assert(((await stat(privateFile)).mode & 0o077) === 0, "private_file_permissions_required");
  const env = parseEnv(await readFile(".env.render-api", "utf8"));
  const progress = JSON.parse(await readFile(privateFile, "utf8"));
  const entry = progress.roles.sender;
  assert(
    progress.origin === "https://muuve.onrender.com" &&
      env.APP_BASE_URL === progress.origin &&
      env.SOLANA_CLUSTER === "devnet" &&
      env.PAYOUT_PROVIDER === "mock" &&
      entry.state === "verified" &&
      entry.user_id &&
      entry.cookies?.muuve_session,
    "verified_hosted_test_account_required",
  );
  const save = () =>
    writeFile(privateFile, JSON.stringify(progress, null, 2) + "\n", { mode: 0o600 });
  const header = (cookies: Record<string, string>) =>
    Object.entries(cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  async function call(path: string, cookies: string, status: number, mutate = false) {
    const result = await fetch(progress.origin + path, {
      method: mutate ? "POST" : "GET",
      headers: { origin: progress.origin, "content-type": "application/json", cookie: cookies },
      ...(mutate ? { body: "{}" } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(45000),
    });
    evidence.requests.push({ path, method: mutate ? "POST" : "GET", status: result.status });
    assert(result.status === status, `unexpected_http_${result.status}`);
    const body = await result.json();
    return { body, cookies: result.headers.getSetCookie() };
  }
  const original = header(entry.cookies);
  assert((await call("/api/me", original, 200)).body.user.id === entry.user_id, "wrong_user");
  entry.state = "session_cleanup_started";
  await save();
  const refreshed = await call("/api/auth/refresh", original, 200, true);
  assert(refreshed.body.refreshed === true, "refresh_failed");
  const cookie = refreshed.cookies.find((value) => value.startsWith("muuve_session="));
  assert(cookie, "refreshed_cookie_missing");
  assert(
    cookie.includes("HttpOnly") && cookie.includes("Secure") && cookie.includes("SameSite=Lax"),
    "cookie_security_flags_missing",
  );
  const pair = cookie.split(";")[0]!;
  entry.cookies.muuve_session = pair.slice("muuve_session=".length);
  await save();
  await call("/api/me", original, 401);
  const current = header(entry.cookies);
  assert((await call("/api/me", current, 200)).body.user.id === entry.user_id, "wrong_user");
  const logout = await call("/api/auth/logout", current, 200, true);
  assert(logout.body.logged_out === true, "logout_failed");
  for (const name of ["muuve_session", "muuve_claim", "muuve_phone_proof"])
    assert(
      logout.cookies.some((value) => value.startsWith(`${name}=`) && value.includes("Max-Age=0")),
      "logout_cookie_not_cleared",
    );
  await call("/api/me", current, 401);
  await call("/api/auth/privy-token", current, 401);
  entry.cookies = {};
  entry.code = "";
  entry.state = "logged_out_after_verification";
  await save();
  evidence.state = "passed_actual_hosted_refresh_revocation_and_logout";
}
try {
  await main();
} catch (error) {
  evidence.state = "failed_or_unknown_session_outcome";
  evidence.code =
    error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
      ? error.message
      : "transport_or_configuration_failure";
  process.exitCode = 1;
}
await writeFile(
  "evidence/hosted-e2e/session-lifecycle.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.info(JSON.stringify(evidence));
