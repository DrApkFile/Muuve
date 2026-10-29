import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  readdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
describe("local key provisioning", () => {
  it("creates restrictive, distinct keys and never rotates them on repeat runs", () => {
    const root = mkdtempSync(join(tmpdir(), "muuve-key-test-"));
    try {
      function run() {
        return spawnSync(process.execPath, ["scripts/bootstrap-local.mjs", `--root=${root}`], {
          encoding: "utf8",
        });
      }
      expect(run().status).toBe(0);
      const files = [
        "keys/auth-private.pem",
        "keys/auth-kid.txt",
        ".env.local",
        ...readdirSync(join(root, "keys/devnet")).map((f) => `keys/devnet/${f}`),
      ];
      const hashes = files.map((f) =>
        createHash("sha256")
          .update(readFileSync(join(root, f)))
          .digest("hex"),
      );
      expect(files.every((f) => (statSync(join(root, f)).mode & 0o077) === 0)).toBe(true);
      expect(run().status).toBe(0);
      expect(
        files.map((f) =>
          createHash("sha256")
            .update(readFileSync(join(root, f)))
            .digest("hex"),
        ),
      ).toEqual(hashes);
      const manifest = JSON.parse(readFileSync(join(root, "config/devnet-public.json"), "utf8"));
      const addresses = Object.values(manifest.roles).map((x: any) => x.public_key);
      expect(new Set(addresses).size).toBe(addresses.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("refuses to regenerate a missing key belonging to a saved deployment identity", () => {
    const root = mkdtempSync(join(tmpdir(), "muuve-key-restore-test-"));
    try {
      const run = () =>
        spawnSync(process.execPath, ["scripts/bootstrap-local.mjs", `--root=${root}`], {
          encoding: "utf8",
        });
      expect(run().status).toBe(0);
      const manifest = readFileSync(join(root, "config/devnet-public.json"), "utf8");
      unlinkSync(join(root, "keys/devnet/program.json"));
      expect(run().status).not.toBe(0);
      expect(existsSync(join(root, "keys/devnet/program.json"))).toBe(false);
      expect(readFileSync(join(root, "config/devnet-public.json"), "utf8")).toBe(manifest);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
