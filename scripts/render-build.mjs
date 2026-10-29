import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const kind = process.argv[2];
if (!["api", "worker"].includes(kind)) throw new Error("Expected api or worker");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const version = manifest.packageManager.split("@")[1];
if (process.version !== `v${readFileSync(".node-version", "utf8").trim()}`)
  throw new Error("Use the pinned .node-version");
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const installed = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
function pnpm(args) {
  if (installed.status === 0 && installed.stdout.trim() === version) run("pnpm", args);
  else run("npm", ["exec", "--yes", `--package=pnpm@${version}`, "--", "pnpm", ...args]);
}
pnpm(["install", "--frozen-lockfile", "--prod=false"]);
pnpm(["typecheck"]);
if (kind === "api") pnpm(["build"]);
// tsx is intentionally retained for the server-only TypeScript worker.
