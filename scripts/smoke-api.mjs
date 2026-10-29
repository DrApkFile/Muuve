import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8, createLocalJWKSet, jwtVerify } from "jose";
const suppliedPem =
  process.env.AUTH_JWT_PRIVATE_KEY ||
  (process.env.AUTH_JWT_PRIVATE_KEY_FILE
    ? readFileSync(process.env.AUTH_JWT_PRIVATE_KEY_FILE, "utf8")
    : undefined);
const pem =
  suppliedPem ??
  generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
const kid = process.env.AUTH_JWT_KID || "http-smoke-key",
  app = process.env.NEXT_PUBLIC_PRIVY_APP_ID || "http-smoke-app";
const runtimeEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !/^(OPERATOR_|DEVNET_TEST_|TEST_MINT_SECRET(?:_FILE)?$)/.test(name),
  ),
);
const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const address = reserve.address();
if (!address || typeof address === "string") throw new Error("No local test port");
const selected = address.port;
await new Promise((resolve) => reserve.close(resolve));
const port = selected,
  base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["scripts/start-api.mjs"], {
  stdio: "ignore",
  env: {
    ...runtimeEnv,
    PORT: String(port),
    RENDER: "true",
    APP_ENV: "preview",
    OTP_PROVIDER: "twilio",
    APP_BASE_URL: "https://muuve.test",
    AUTH_JWT_PRIVATE_KEY: pem,
    AUTH_JWT_PRIVATE_KEY_FILE: "",
    AUTH_JWT_KID: kid,
    NEXT_PUBLIC_PRIVY_APP_ID: app,
  },
});
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      ready = (await fetch(`${base}/api/health`)).status === 200;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error("API did not become ready");
  const health = await (await fetch(`${base}/api/health`)).json();
  if (health.service !== "muuve-backend") throw new Error("Unexpected API health");
  const keys = await (await fetch(`${base}/api/auth/jwks`)).json();
  if (keys.keys?.some((key) => "d" in key)) throw new Error("Private key exposed through JWKS");
  const subject = randomUUID();
  const token = await new SignJWT()
    .setProtectedHeader({ alg: "ES256", kid })
    .setSubject(subject)
    .setIssuer("https://muuve.test")
    .setAudience(app)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(await importPKCS8(pem, "ES256"));
  if (
    (
      await jwtVerify(token, createLocalJWKSet(keys), {
        algorithms: ["ES256"],
        issuer: "https://muuve.test",
        audience: app,
      })
    ).payload.sub !== subject
  )
    throw new Error("HTTP JWKS signature verification failed");
  if ((await fetch(`${base}/api/me`)).status !== 401)
    throw new Error("Unauthenticated request not rejected");
  if ((await fetch(`${base}/api/cron/reconcile`, { method: "POST" })).status !== 401)
    throw new Error("Unsigned cron request not rejected");
  if (
    (
      await fetch(`${base}/api/auth/signup`, {
        method: "POST",
        headers: { origin: "https://evil.test" },
        body: "{}",
      })
    ).status !== 403
  )
    throw new Error("Origin guard failed");
  if ((await fetch(`${base}/api/webhooks/payout`, { method: "POST", body: "{}" })).status !== 401)
    throw new Error("Unsigned webhook not rejected");
  console.info(
    "Production HTTP smoke: exact start command/PORT, health, public JWKS/signature, session, Origin and webhook guards passed. No external service contacted.",
  );
} finally {
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((r) => setTimeout(r, 5000))]);
  if (server.exitCode === null) server.kill("SIGKILL");
}
