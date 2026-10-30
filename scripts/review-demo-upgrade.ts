import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { operatorConnection, requiredPublic } from "./operator";
import { sourceFingerprint, fileHash } from "./sbf-fingerprint.mjs";
import { assert } from "../apps/web/lib/server/errors";

// Read-only upgrade review: no key loading, signatures, buffers or transactions.
const evidence: Record<string, unknown> = {
  checked_at: new Date().toISOString(),
  network: "devnet",
  transactions_submitted: 0,
};
try {
  const artifact = "target/sbf-check/sbpf-solana-solana/release/muuve_escrow.so",
    build = JSON.parse(await readFile("target/sbf-check/build-info.json", "utf8")),
    manifest = JSON.parse(await readFile("config/devnet-public.json", "utf8")),
    program = requiredPublic("MUUVE_PROGRAM_ID");
  assert(
    !build.fixture &&
      build.program_id === program.toBase58() &&
      manifest.program_id === program.toBase58() &&
      build.source_sha256 === sourceFingerprint() &&
      build.artifact_sha256 === fileHash(artifact),
    "review_artifact_identity_mismatch",
  );
  const bytes = await readFile(artifact),
    connection = await operatorConnection(),
    loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    existing = await connection.getAccountInfo(program, "finalized");
  assert(
    existing?.executable && existing.owner.equals(loader) && existing.data.readUInt32LE(0) === 2,
    "unexpected_program_account",
  );
  const programData = new PublicKey(existing.data.subarray(4, 36)),
    data = await connection.getAccountInfo(programData, "finalized");
  assert(
    data && data.owner.equals(loader) && data.data.readUInt32LE(0) === 3 && data.data[12] === 1,
    "upgradeable_program_data_required",
  );
  const authority = new PublicKey(data.data.subarray(13, 45));
  assert(
    authority.toBase58() === manifest.roles["deployment-authority"].public_key,
    "unexpected_upgrade_authority",
  );
  const buffer = new PublicKey(manifest.roles["deployment-buffer"].public_key),
    bufferAccount = await connection.getAccountInfo(buffer, "finalized");
  if (bufferAccount)
    assert(
      bufferAccount.owner.equals(loader) &&
        bufferAccount.data.readUInt32LE(0) === 1 &&
        bufferAccount.data[4] === 1 &&
        new PublicKey(bufferAccount.data.subarray(5, 37)).equals(authority),
      "existing_buffer_authority_mismatch",
    );
  const bufferRent = await connection.getMinimumBalanceForRentExemption(bytes.length + 37),
    requiredProgramRent = await connection.getMinimumBalanceForRentExemption(
      Math.max(data.data.length, bytes.length + 45),
    ),
    extensionRent = Math.max(0, requiredProgramRent - data.lamports),
    authorityBalance = await connection.getBalance(authority, "finalized"),
    upfront = Math.max(0, bufferRent - (bufferAccount?.lamports ?? 0)) + extensionRent + 50_000_000;
  Object.assign(evidence, {
    state: "review_only_no_upgrade_authorized_by_this_script",
    program_id: program.toBase58(),
    upgrade_authority: authority.toBase58(),
    program_data: programData.toBase58(),
    source_sha256: build.source_sha256,
    artifact_sha256: build.artifact_sha256,
    artifact_bytes: bytes.length,
    current_program_capacity_bytes: data.data.length - 45,
    program_extension_required: bytes.length > data.data.length - 45,
    existing_binary_matches: data.data.subarray(45, 45 + bytes.length).equals(bytes),
    buffer_rent_lamports: bufferRent,
    additional_program_rent_lamports: extensionRent,
    authority_balance_lamports: authorityBalance,
    conservative_upfront_lamports_including_fee_margin: upfront,
    upfront_balance_sufficient: authorityBalance >= upfront,
    note: "Buffer rent is generally returned on successful upgrade; upfront balance is distinct from final cost. No faucet or funding request performed.",
  });
} catch (error) {
  evidence.state = "blocked";
  evidence.code =
    error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "upgrade_review_rpc_or_configuration_failure";
  process.exitCode = 1;
}
await mkdir("evidence/demo-expiry", { recursive: true });
const path = `evidence/demo-expiry/upgrade-review-${randomUUID()}.json`;
await writeFile(path, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
console.info(JSON.stringify({ ...evidence, evidence: path }));
