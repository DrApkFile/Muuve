import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
const reserve = createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const address = reserve.address();
if (!address || typeof address === "string") throw new Error("No local test port");
const selected = address.port;
await new Promise((resolve) => reserve.close(resolve));
const port = selected,
  base = `http://127.0.0.1:${port}`;
const server = spawn(
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
  { stdio: "ignore", env: { ...process.env, APP_BASE_URL: "https://muuve.test" } },
);
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
    "Production HTTP smoke: health, session, Origin and webhook guards passed. No external service contacted.",
  );
} finally {
  server.kill("SIGTERM");
  await Promise.race([once(server, "exit"), new Promise((r) => setTimeout(r, 5000))]);
  if (server.exitCode === null) server.kill("SIGKILL");
}
