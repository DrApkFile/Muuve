import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { sourceFingerprint, fileHash } from "./sbf-fingerprint.mjs";
const fixture = process.argv.includes("--fixture");
const programId = fixture
  ? "Fg6PaFpoGXkYsidMpWxTWqkZ7FEfcYkgMQhgV7tTqKpP"
  : process.env.MUUVE_PROGRAM_ID;
if (!programId)
  throw new Error(
    "Supply an operator-assigned MUUVE_PROGRAM_ID or explicitly use --fixture for local tests",
  );
new PublicKey(programId);
const root = process.env.SBF_TOOLCHAIN_ROOT;
if (!root)
  throw new Error(
    "Set SBF_TOOLCHAIN_ROOT to the verified platform-tools v1.58 directory; see runbook",
  );
const tools = resolve(root),
  target = resolve("target/sbf-check");
rmSync(resolve(target, "build-info.json"), { force: true });
const r = spawnSync(
  resolve(tools, "rust/bin/cargo"),
  [
    "build",
    "--locked",
    "--release",
    "--target",
    "sbpf-solana-solana",
    "--manifest-path",
    "programs/muuve_escrow/Cargo.toml",
    "--lib",
    "--jobs",
    "2",
  ],
  {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      MUUVE_PROGRAM_ID: programId,
      RUSTC: resolve(tools, "rust/bin/rustc"),
      CC: resolve(tools, "llvm/bin/clang"),
      AR: resolve(tools, "llvm/bin/llvm-ar"),
      CARGO_TARGET_DIR: target,
    },
  },
);
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
if (r.status !== 0) process.exit(r.status ?? 1);
if (/^Error:/m.test((r.stdout ?? "") + (r.stderr ?? "")))
  throw new Error("SBF diagnostic rejected; artifact is not verified");
mkdirSync(target, { recursive: true });
writeFileSync(
  resolve(target, "build-info.json"),
  JSON.stringify(
    {
      program_id: programId,
      fixture,
      toolchain: "platform-tools-v1.58",
      target: "sbpf-solana-solana",
      source_sha256: sourceFingerprint(),
      artifact_sha256: fileHash(resolve(target, "sbpf-solana-solana/release/muuve_escrow.so")),
      deployment_verified: false,
    },
    null,
    2,
  ) + "\n",
);
console.info("SBF artifact built without deployment or keypair generation.");
