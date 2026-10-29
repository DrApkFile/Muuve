import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { sourceFingerprint, fileHash } from "./sbf-fingerprint.mjs";
const target = resolve("target/sbf-check"),
  info = JSON.parse(readFileSync(resolve(target, "build-info.json"), "utf8"));
const artifact = resolve(target, "sbpf-solana-solana/release/muuve_escrow.so");
if (!existsSync(artifact)) throw new Error("Run build:sbf first");
if (info.source_sha256 !== sourceFingerprint() || info.artifact_sha256 !== fileHash(artifact))
  throw new Error("SBF artifact is stale or unverified; rebuild first");
const r = spawnSync(
  "cargo",
  [
    "test",
    "--locked",
    "--manifest-path",
    "programs/muuve_escrow/Cargo.toml",
    "--test",
    "runtime",
    "--jobs",
    "2",
    "--",
    "--include-ignored",
    "--test-threads=1",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      MUUVE_SBF_SO: artifact,
      MUUVE_PROGRAM_ID: info.program_id,
      RUST_LOG: "error",
    },
  },
);
process.exit(r.status ?? 1);
