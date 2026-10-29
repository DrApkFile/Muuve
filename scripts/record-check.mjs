import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, openSync, closeSync, readFileSync } from "node:fs";
const [name, command, ...args] = process.argv.slice(2);
if (!name || !/^[a-z0-9-]+$/.test(name) || !command)
  throw new Error("Expected safe check name and command");
mkdirSync("evidence/render-devnet", { recursive: true });
const started = Date.now();
const path = `evidence/render-devnet/${name}.log`,
  fd = openSync(path, "w");
let result;
try {
  result = spawnSync(command, args, { stdio: ["ignore", fd, fd], timeout: 900000 });
} finally {
  closeSync(fd);
}
const record = {
  name,
  command: [command, ...args],
  started_at: new Date(started).toISOString(),
  duration_ms: Date.now() - started,
  exit_code: result.status,
  signal: result.signal,
  passed: result.status === 0,
};
writeFileSync(`evidence/render-devnet/${name}.json`, JSON.stringify(record, null, 2) + "\n");
console.info(JSON.stringify(record));
if (result.status !== 0) process.stdout.write(readFileSync(path, "utf8").slice(-16000));
process.exit(result.status ?? 1);
