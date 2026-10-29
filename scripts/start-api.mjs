import { spawn } from "node:child_process";
const port = process.env.PORT ?? "3000";
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  throw new Error("Invalid PORT");
if (process.env.RENDER) {
  if (
    Object.keys(process.env).some(
      (name) =>
        process.env[name] && /^(OPERATOR_|DEVNET_TEST_|TEST_MINT_SECRET(?:_FILE)?$)/.test(name),
    )
  )
    throw new Error("Operator keys are forbidden in the Render API environment");
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
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.once("error", () => {
  console.error("API startup failed");
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGTERM" ? 0 : 1);
});
