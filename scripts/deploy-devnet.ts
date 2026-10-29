import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { PublicKey, Keypair } from "@solana/web3.js";
import { operatorConnection, requiredPublic } from "./operator";
import { keypair } from "../apps/web/lib/server/config";
import { assert, AppError } from "../apps/web/lib/server/errors";
import { pacedDeploy } from "./paced-deployment";
import { fileHash, sourceFingerprint } from "./sbf-fingerprint.mjs";
const artifact = "target/sbf-check/sbpf-solana-solana/release/muuve_escrow.so";
async function main() {
  const c = await operatorConnection(),
    program = requiredPublic("MUUVE_PROGRAM_ID"),
    authority = keypair("OPERATOR_DEPLOYMENT_SECRET");
  const manifest = JSON.parse(await readFile("config/devnet-public.json", "utf8"));
  const info = JSON.parse(await readFile("target/sbf-check/build-info.json", "utf8"));
  assert(
    !info.fixture &&
      info.program_id === program.toBase58() &&
      info.source_sha256 === sourceFingerprint() &&
      info.artifact_sha256 === fileHash(artifact),
    "deployment_artifact_mismatch",
  );
  assert(
    manifest.program_id === program.toBase58() &&
      manifest.roles["deployment-authority"].public_key === authority.publicKey.toBase58(),
    "deployment_identity_mismatch",
  );
  assert(
    (await readFile("Anchor.toml", "utf8")).includes(`muuve_escrow = "${program.toBase58()}"`),
    "anchor_program_id_mismatch",
  );
  const data = await readFile(artifact),
    loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const existing = await c.getAccountInfo(program, "finalized");
  if (existing) {
    assert(existing.executable && existing.owner.equals(loader), "unexpected_existing_program");
    const programData = new PublicKey(existing.data.subarray(4, 36)),
      account = await c.getAccountInfo(programData, "finalized");
    assert(
      account &&
        account.data[12] === 1 &&
        new PublicKey(account.data.subarray(13, 45)).equals(authority.publicKey),
      "upgrade_authority_mismatch",
    );
    assert(
      account.data.subarray(45, 45 + data.length).equals(data),
      "existing_program_differs_review_upgrade",
    );
    console.info(
      JSON.stringify({
        state: "existing_program_verified",
        program_id: program.toBase58(),
        upgrade_authority: authority.publicKey.toBase58(),
      }),
    );
    return;
  }
  // The loader reuses the funded buffer's lamports for ProgramData.
  const bufferAccount = await c.getAccountInfo(
    new PublicKey(manifest.roles["deployment-buffer"].public_key),
    "finalized",
  );
  if (bufferAccount)
    assert(
      bufferAccount.owner.equals(loader) &&
        bufferAccount.data.readUInt32LE(0) === 1 &&
        bufferAccount.data[4] === 1 &&
        new PublicKey(bufferAccount.data.subarray(5, 37)).equals(authority.publicKey),
      "deployment_buffer_authority_mismatch",
    );
  const required =
    Math.max(
      0,
      (await c.getMinimumBalanceForRentExemption(data.length + 45)) -
        (bufferAccount?.lamports ?? 0),
    ) +
    (await c.getMinimumBalanceForRentExemption(36)) +
    200_000_000;
  const balance = await c.getBalance(authority.publicKey, "finalized");
  if (balance < required) {
    console.info(
      JSON.stringify({
        state: "blocked",
        code: "deployment_sol_required",
        address: authority.publicKey.toBase58(),
        balance_lamports: balance,
        target_lamports: required,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const authorityFile = process.env.OPERATOR_DEPLOYMENT_SECRET_FILE;
  assert(authorityFile, "deployment_authority_file_required");
  const binary = process.env.SOLANA_CLI ?? resolve(".cache/solana-release/bin/solana");
  const args = [
    "--url",
    process.env.SOLANA_RPC_URL!,
    "--keypair",
    authorityFile,
    "--commitment",
    "finalized",
    "program",
    "deploy",
    artifact,
    "--program-id",
    manifest.roles.program.file,
    "--upgrade-authority",
    authorityFile,
    "--fee-payer",
    authorityFile,
    "--buffer",
    manifest.roles["deployment-buffer"].file,
    "--max-len",
    String(data.length),
    "--use-rpc",
    "--output",
    "json",
  ];
  // Capture output: a failed CLI must never print a recovery phrase to diagnostics.
  let deployed: { programId: string; signature?: string };
  if (process.argv.includes("--paced")) {
    async function role(name: string) {
      const entry = manifest.roles[name];
      assert(((await stat(entry.file)).mode & 0o077) === 0, "insecure_deployment_key_file");
      const key = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(await readFile(entry.file, "utf8"))),
      );
      assert(key.publicKey.toBase58() === entry.public_key, "deployment_key_mismatch");
      return key;
    }
    deployed = await pacedDeploy(
      c,
      await role("program"),
      await role("deployment-buffer"),
      authority,
      data,
    );
  } else {
    const result = await new Promise<{ code: number | null; output: string }>((resolveResult) => {
      let output = "";
      const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", () => {});
      child.on("error", () => resolveResult({ code: 1, output: "" }));
      child.on("close", (code) => resolveResult({ code, output }));
    });
    assert(result.code === 0, "deployment_cli_failed_reconcile_buffer");
    deployed = JSON.parse(result.output);
  }
  assert(deployed.programId === program.toBase58(), "deployed_program_id_mismatch");
  const after = await c.getAccountInfo(program, "finalized");
  assert(after?.executable && after.owner.equals(loader), "deployment_not_verified");
  const programData = new PublicKey(after.data.subarray(4, 36)),
    state = await c.getAccountInfo(programData, "finalized");
  assert(
    state &&
      state.data[12] === 1 &&
      new PublicKey(state.data.subarray(13, 45)).equals(authority.publicKey) &&
      state.data.subarray(45, 45 + data.length).equals(data),
    "deployed_bytes_or_authority_mismatch",
  );
  const signatures = await c.getSignaturesForAddress(programData, { limit: 10 }, "finalized");
  const signature = deployed.signature ?? signatures.find((s) => !s.err)?.signature;
  assert(signature, "deployment_signature_not_found");
  const record = {
    network: "devnet",
    state: "deployed_verified",
    program_id: program.toBase58(),
    signature,
    upgrade_authority: authority.publicKey.toBase58(),
    artifact_sha256: fileHash(artifact),
    verified_at: new Date().toISOString(),
  };
  await mkdir("evidence/devnet", { recursive: true });
  await writeFile("evidence/devnet/deployment.json", JSON.stringify(record, null, 2) + "\n");
  console.info(JSON.stringify(record));
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  const code =
    error instanceof AppError
      ? error.code
      : /429|Too Many|rate.limit/i.test(message)
        ? "rpc_rate_limit"
        : /simulation failed/i.test(message)
          ? "transaction_simulation_failed"
          : /too large/i.test(message)
            ? "transaction_size_limit"
            : /fetch|timeout|abort/i.test(message)
              ? "rpc_transport_failure"
              : "deployment_rpc_or_cli_failure";
  console.error(
    JSON.stringify({
      state: "blocked_or_uncertain",
      code,
      error_name: error instanceof Error ? error.name : "unknown",
      rpc_code:
        typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : undefined,
    }),
  );
  console.error(
    "Devnet deployment blocked or uncertain; reconcile program/buffer before retry. No secret output retained.",
  );
  process.exitCode = 1;
});
