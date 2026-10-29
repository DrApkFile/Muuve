import { readFileSync, statSync } from "node:fs";
import { assert } from "./errors";

/** File alternatives are server-only. Render can inject the value instead. */
export function secretValue(name: string): string | undefined {
  const value = process.env[name],
    file = process.env[`${name}_FILE`];
  assert(!(value && file), `conflicting_${name}`, 503);
  if (!file) return value || undefined;
  const info = statSync(file);
  assert(info.isFile() && (info.mode & 0o077) === 0, `insecure_${name}_file`, 503);
  return readFileSync(file, "utf8").trim();
}
