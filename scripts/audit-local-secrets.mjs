import { readFileSync, readdirSync, statSync, realpathSync, existsSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { parseEnv } from "node:util";
const needles = [];
function secrets(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) secrets(path);
    else if (/\.json$|private\.pem$/.test(entry.name)) {
      if ((statSync(path).mode & 0o077) !== 0) throw Error("Secret file permissions are too broad");
      const value = readFileSync(path, "utf8").trim();
      needles.push(Buffer.from(value));
      if (value.includes("BEGIN PRIVATE KEY")) needles.push(Buffer.from(value.split("\n")[1]));
    }
  }
}
secrets("keys");
const local = parseEnv(readFileSync(".env.local", "utf8"));
if (local.DATABASE_URL) {
  const password = decodeURIComponent(new URL(local.DATABASE_URL).password);
  if (password) needles.push(Buffer.from(password));
}
for (const name of [
  "SESSION_SECRET",
  "CRON_SECRET",
  "MOCK_WEBHOOK_SECRET",
  "DATABASE_URL",
  "PRIVY_APP_SECRET",
  "TWILIO_AUTH_TOKEN",
  "TEXTBEE_API_KEY",
]) {
  const value = local[name];
  if (value && value.length >= 16) needles.push(Buffer.from(value));
}
if ((statSync(".env.local").mode & 0o077) !== 0)
  throw Error("Local environment permissions are too broad");
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
if (
  tracked.some(
    (f) =>
      f.startsWith("keys/") ||
      (/(^|\/)\.env/.test(f) && f !== ".env.example") ||
      f.endsWith("-keypair.json") ||
      f.endsWith(".pem"),
  )
)
  throw Error("A secret path is tracked");
const reviewable = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((file) => file && existsSync(file) && lstatSync(file).isFile());
for (const file of reviewable) {
  const value = readFileSync(file);
  if (needles.some((secret) => value.includes(secret)))
    throw Error(`Local secret value found in a reviewable repository file: ${file}`);
}
let count = 0;
let dependencyLinks = 0;
const artifactRoot = realpathSync("apps/web/.next"),
  keyRoot = realpathSync("keys"),
  visited = new Set();
function scan(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      const target = realpathSync(path);
      if (
        target === keyRoot ||
        target.startsWith(keyRoot + sep) ||
        target === resolve(".env.local")
      )
        throw Error("Secret path linked into build artifacts");
      if (!target.startsWith(artifactRoot + sep)) {
        dependencyLinks++;
        continue;
      }
      if (visited.has(target)) continue;
      visited.add(target);
      if (statSync(target).isDirectory()) {
        scan(target);
        continue;
      }
    }
    if (entry.isDirectory()) scan(path);
    else {
      const value = readFileSync(path);
      if (path.endsWith(".nft.json")) {
        const trace = JSON.parse(value.toString());
        for (const file of trace.files ?? []) {
          const target = resolve(dir, file);
          if (
            target === keyRoot ||
            target.startsWith(keyRoot + sep) ||
            target === resolve(".env.local")
          )
            throw Error("Private file referenced by a build trace");
        }
      }
      if (needles.some((secret) => value.includes(secret)))
        throw Error(`Secret found in build artifact: ${path}`);
      count++;
    }
  }
}
scan("apps/web/.next");
console.info(
  JSON.stringify({
    state: "passed",
    checks: [
      "private file permissions",
      "Git exclusion",
      "no local secret values in reviewable source or evidence",
      "no local secret values in Next build artifacts",
    ],
    artifact_files_scanned: count,
    repository_files_scanned: reviewable.length,
    external_dependency_links_checked: dependencyLinks,
  }),
);
