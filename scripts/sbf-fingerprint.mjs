import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
export function sourceFingerprint() {
  const paths = [
    "Cargo.toml",
    "Cargo.lock",
    "programs/muuve_escrow/Cargo.toml",
    "programs/muuve_escrow/build.rs",
  ];
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".rs")) paths.push(file);
    }
  }
  walk("programs/muuve_escrow/src");
  const hash = createHash("sha256");
  for (const file of paths.sort()) {
    hash.update(file);
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}
export const fileHash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
