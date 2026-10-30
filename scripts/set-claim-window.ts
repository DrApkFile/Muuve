import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile, unlink, stat } from "node:fs/promises";
import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { operatorConnection, requiredPublic } from "./operator";
import { keypair } from "../apps/web/lib/server/config";
import { decodeConfig, ix, meta } from "../apps/web/lib/server/solana/codec";
import { assert } from "../apps/web/lib/server/errors";

// Default review is read-only and needs no private keys. Execution is a separate,
// explicitly approved admin action, never an API/worker capability.
const execute = process.argv.includes("--execute"),
  target = Number(process.argv.find((arg) => arg.startsWith("--seconds="))?.slice(10)),
  evidence: Record<string, unknown> = {
    started_at: new Date().toISOString(),
    network: "devnet",
    target_window_seconds: target,
    transaction_submitted: false,
  };
const journal = "keys/claim-window-change.json",
  lockPath = journal + ".lock";
let lock: Awaited<ReturnType<typeof open>> | undefined;
try {
  assert([240, 172800].includes(target), "explicit_supported_window_required");
  assert(
    target !== 240 || ["local", "preview"].includes(process.env.APP_ENV ?? ""),
    "demo_expiry_preview_only",
  );
  const connection = await operatorConnection(),
    program = requiredPublic("MUUVE_PROGRAM_ID"),
    config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0];
  const account = await connection.getAccountInfo(config, "finalized");
  assert(account && account.owner.equals(program), "config_owner_mismatch");
  const before = decodeConfig(account.data);
  const manifest = JSON.parse(await readFile("config/devnet-public.json", "utf8"));
  assert(
    manifest.program_id === program.toBase58() &&
      manifest.roles.admin.public_key === before.admin &&
      manifest.roles["fee-payer"].public_key === before.feePayer,
    "operator_identity_mismatch",
  );
  Object.assign(evidence, {
    program_id: program.toBase58(),
    config: config.toBase58(),
    current_window_seconds: before.claimWindow,
    existing_link_deadlines_modified: false,
  });
  const encoded = Buffer.alloc(8);
  encoded.writeBigInt64LE(BigInt(target));
  const instruction = ix(
    program,
    "set_claim_window",
    [meta(new PublicKey(before.admin), false, true), meta(config, true)],
    encoded,
  );
  if (!execute) {
    const life = await connection.getLatestBlockhash("finalized");
    const tx = new Transaction({ feePayer: new PublicKey(before.feePayer), ...life }).add(
      instruction,
    );
    // Unsigned simulation is review only, never evidence of an authorized change.
    const simulation = await connection.simulateTransaction(tx);
    evidence.simulation_error = simulation.value.err;
    evidence.state = simulation.value.err
      ? "blocked_review_program_upgrade_or_simulation_failure"
      : "review_ready_no_change_applied";
    if (simulation.value.err) process.exitCode = 1;
  } else {
    assert(
      process.env.MUUVE_ALLOW_CONFIG_CHANGE === "1" &&
        process.argv.includes("--operator-approved-window-change"),
      "explicit_config_change_approval_required",
    );
    lock = await open(lockPath, "wx", 0o600);
    const admin = keypair("OPERATOR_ADMIN_SECRET"),
      payer = keypair("FEE_PAYER_SECRET");
    assert(
      admin.publicKey.toBase58() === before.admin && payer.publicKey.toBase58() === before.feePayer,
      "config_signer_mismatch",
    );
    let record;
    try {
      assert(((await stat(journal)).mode & 0o077) === 0, "private_change_journal_required");
      record = JSON.parse(await readFile(journal, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!record) {
      assert(before.claimWindow !== target, "already_configured_no_transaction_needed");
      const life = await connection.getLatestBlockhash("finalized"),
        tx = new Transaction({ feePayer: payer.publicKey, ...life }).add(instruction);
      tx.sign(payer, admin);
      record = {
        program: program.toBase58(),
        target,
        before: before.claimWindow,
        signature: bs58.encode(tx.signature!),
        ...life,
        transaction: tx.serialize().toString("base64"),
      };
      await writeFile(journal, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
    }
    assert(
      record.program === program.toBase58() && record.target === target,
      "existing_change_journal_requires_reconciliation",
    );
    const stored = Transaction.from(Buffer.from(record.transaction, "base64"));
    assert(
      stored.verifySignatures() &&
        stored.signature &&
        bs58.encode(stored.signature) === record.signature &&
        stored.feePayer?.equals(payer.publicKey) &&
        stored.recentBlockhash === record.blockhash &&
        stored.instructions.length === 1 &&
        stored.instructions[0]!.programId.equals(program) &&
        stored.instructions[0]!.data.equals(instruction.data) &&
        JSON.stringify(stored.instructions[0]!.keys) === JSON.stringify(instruction.keys),
      "configuration_message_integrity_failed",
    );
    evidence.signature = record.signature;
    const status = (
      await connection.getSignatureStatuses([record.signature], { searchTransactionHistory: true })
    ).value[0];
    assert(!status?.err, "configuration_transaction_failed");
    if (status?.confirmationStatus !== "finalized") {
      assert(
        before.claimWindow === record.before,
        "configuration_changed_reconcile_existing_operation",
      );
      assert(
        (await connection.isBlockhashValid(record.blockhash, { commitment: "finalized" })).value,
        "expired_configuration_transaction_reconcile_before_replacement",
      );
      evidence.transaction_submitted = true;
      const signature = await connection.sendRawTransaction(
        Buffer.from(record.transaction, "base64"),
        { maxRetries: 0 },
      );
      assert(signature === record.signature, "configuration_signature_mismatch");
      const result = await connection.confirmTransaction(
        {
          signature,
          ...{ blockhash: record.blockhash, lastValidBlockHeight: record.lastValidBlockHeight },
        },
        "finalized",
      );
      assert(!result.value.err, "configuration_transaction_failed");
    }
    const afterAccount = await connection.getAccountInfo(config, "finalized");
    assert(afterAccount && afterAccount.owner.equals(program), "config_owner_mismatch");
    const after = decodeConfig(afterAccount.data);
    assert(after.claimWindow === target, "configuration_window_not_verified");
    const { claimWindow: _before, ...oldTerms } = before,
      { claimWindow: _after, ...newTerms } = after;
    assert(
      JSON.stringify(oldTerms) === JSON.stringify(newTerms),
      "unrelated_configuration_changed",
    );
    evidence.state = "finalized_configuration_change_verified";
  }
} catch (error) {
  evidence.state = "blocked_or_failed_reconcile_before_retry";
  evidence.code =
    error instanceof Error && /^[a-z_]+$/.test(error.message)
      ? error.message
      : "configuration_or_rpc_failure";
  process.exitCode = 1;
} finally {
  if (lock) {
    await lock.close();
    await unlink(lockPath);
  }
  await mkdir("evidence/demo-expiry", { recursive: true });
  const path = `evidence/demo-expiry/window-${randomUUID()}.json`;
  await writeFile(path, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  console.info(JSON.stringify({ ...evidence, evidence: path }));
}
