import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
const targets = process.argv.slice(2);
if (targets.some((target) => !/^tests\/(db|api)\/[a-z][a-z0-9-]*\.test\.ts$/.test(target)))
  throw new Error("Expected explicit database/API test file paths");
mkdirSync(".cache", { recursive: true });
const root = mkdtempSync(resolve(".cache/pg-test-")),
  data = resolve(root, "data");
const port = 55439;
function run(cmd, args, env = process.env) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env });
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
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
    `-h 127.0.0.1 -p ${port} -k ${root}`,
    "-w",
    "start",
  ]);
  started = true;
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://127.0.0.1:${port}/postgres`,
    MUUVE_ALLOW_MIGRATIONS: "1",
    MUUVE_TEST_DB: "1",
    MUUVE_DATABASE_PROJECT_REF: "",
  };
  run("pnpm", ["exec", "tsx", "scripts/migrate.ts"], env);
  run("pnpm", ["exec", "tsx", "scripts/database-status.ts"], env);
  run(
    "pnpm",
    ["exec", "vitest", "run", ...(targets.length ? targets : ["tests/db", "tests/api"])],
    env,
  );
} finally {
  if (started)
    spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "inherit" });
  rmSync(root, { recursive: true, force: true });
}
