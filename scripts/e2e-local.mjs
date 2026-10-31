// Runs scripts/e2e-local-cashout.ts against a disposable loopback Postgres and real devnet.
// Chain keys and RPC come from apps/web/.env.local (loaded by Node, never printed); the
// database, OTP and payouts are overridden to local/mock so no hosted record or SMS is made.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const envFile = "apps/web/.env.local";
if (!existsSync(envFile)) throw new Error(`${envFile} is required for devnet keys`);
mkdirSync(".cache", { recursive: true });
const root = mkdtempSync(resolve(".cache/pg-e2e-")),
  data = resolve(root, "data"),
  port = 55441;
function run(cmd, args, env = process.env) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}
let started = false;
try {
  run("initdb", ["-D", data, "--auth=trust", "--no-locale", "-E", "UTF8", "-U", "postgres"]);
  run("pg_ctl", [
    "-D",
    data,
    "-l",
    resolve(root, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${root}`,
    "-w",
    "start",
  ]);
  started = true;
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    MUUVE_ALLOW_MIGRATIONS: "1",
    MUUVE_DATABASE_PROJECT_REF: "",
    APP_ENV: "local",
    APP_BASE_URL: "http://127.0.0.1:3000",
    OTP_PROVIDER: "mock",
    PAYOUT_PROVIDER: "mock",
    TRUSTED_PROXY: "false",
  };
  run("pnpm", ["exec", "tsx", `--env-file=${envFile}`, "scripts/migrate.ts"], env);
  run(
    "pnpm",
    [
      "exec",
      "tsx",
      `--env-file=${envFile}`,
      "scripts/e2e-local-cashout.ts",
      ...process.argv.slice(2),
    ],
    env,
  );
} finally {
  if (started)
    spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "inherit" });
  rmSync(root, { recursive: true, force: true });
}
