import { spawn } from "node:child_process";
const port = process.env.PORT ?? "3000";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  throw new Error("Invalid PORT");
if (process.env.RENDER) {
  const forbidden = Object.keys(process.env)
    .filter(
      (name) =>
        process.env[name] && /^(OPERATOR_|DEVNET_TEST_|TEST_MINT_SECRET(?:_FILE)?$)/.test(name),
    )
    .sort();
  if (forbidden.length)
    throw new Error(
      `Remove local operator variables from the Render API environment: ${forbidden.join(", ")}. See docs/render-deployment.md.`,
    );
  if (process.env.APP_ENV === "local" || process.env.OTP_PROVIDER === "mock")
    throw new Error("Local mock OTP is forbidden on Render");
  const url = new URL(process.env.APP_BASE_URL ?? "");
  if (url.protocol !== "https:" || url.origin !== process.env.APP_BASE_URL)
    throw new Error("APP_BASE_URL must be a canonical HTTPS origin");
}
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "0.0.0.0", "--port", port],
  { stdio: "inherit" },
);
// RUN_WORKER=true runs the background worker next to the API in this one service.
// Job and maintenance leases make it safe alongside a separate worker service too.
let worker;
let stopping = false;
function startWorker() {
  worker = spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], { stdio: "inherit" });
  worker.once("exit", () => {
    worker = undefined;
    if (!stopping) setTimeout(startWorker, 5000).unref();
  });
}
if (process.env.RUN_WORKER === "true") startWorker();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    child.kill(signal);
    worker?.kill(signal);
  });
child.once("error", () => {
  console.error("API startup failed");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  stopping = true;
  worker?.kill("SIGTERM");
  process.exitCode = code ?? (signal === "SIGTERM" ? 0 : 1);
});
