import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

if (!process.argv.includes("--operator-approved"))
  throw Error("Review the dedicated Privy test user/wallet effects and pass --operator-approved");
const api = parseEnv(readFileSync(".env.render-api", "utf8"));
if (
  api.SOLANA_CLUSTER !== "devnet" ||
  api.PAYOUT_PROVIDER !== "mock" ||
  api.APP_BASE_URL !== "https://muuve.onrender.com"
)
  throw Error("Intended devnet configuration required");
mkdirSync(".cache", { recursive: true });
const root = mkdtempSync(resolve(".cache/pg-privy-")),
  data = resolve(root, "data");
const env = {
  ...process.env,
  ...api,
  DATABASE_URL: "postgresql://127.0.0.1:55441/postgres",
  MUUVE_ALLOW_MIGRATIONS: "1",
  MUUVE_DATABASE_PROJECT_REF: "",
  MUUVE_PRIVY_TEST_APPROVED: "1",
};
for (const name of Object.keys(env))
  if (name.endsWith("_SECRET_FILE") || name === "AUTH_JWT_PRIVATE_KEY_FILE") delete env[name];
function run(cmd, args, childEnv = process.env) {
  const result = spawnSync(cmd, args, { env: childEnv, stdio: "inherit", timeout: 180000 });
  if (result.status !== 0)
    throw Error("Privy verification subprocess failed; see redacted evidence");
}
let started = false;
try {
  run("initdb", ["-D", data, "--auth=trust", "--no-locale", "-E", "UTF8"]);
  run("pg_ctl", [
    "-D",
    data,
    "-l",
    resolve(root, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p 55441 -k ${root}`,
    "-w",
    "start",
  ]);
  started = true;
  run("node", ["--import", "tsx", "scripts/migrate.ts"], env);
  run("node", ["--import", "tsx", "scripts/verify-privy-live.ts"], env);
} catch {
  process.exitCode = 1;
} finally {
  if (started)
    spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "inherit" });
  rmSync(root, { recursive: true, force: true });
}
