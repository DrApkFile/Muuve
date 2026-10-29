import { appendFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY,
  ComputeBudgetProgram,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { assert } from "../apps/web/lib/server/errors";
import { DEVNET_GENESIS } from "../apps/web/lib/server/solana/chain";

// Layout/accounts verified against solana-loader-v3-interface 3.0.0's bincode
// create_buffer, write and deploy_with_max_program_len builders (the pinned SDK).
export const LOADER_V3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export function writeBuffer(
  buffer: PublicKey,
  authority: PublicKey,
  offset: number,
  bytes: Buffer,
) {
  const data = Buffer.alloc(16 + bytes.length);
  data.writeUInt32LE(1, 0);
  data.writeUInt32LE(offset, 4);
  data.writeBigUInt64LE(BigInt(bytes.length), 8);
  bytes.copy(data, 16);
  return new TransactionInstruction({
    programId: LOADER_V3,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}
export function deployInstruction(
  program: PublicKey,
  buffer: PublicKey,
  authority: PublicKey,
  size: number,
) {
  const programData = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER_V3)[0],
    data = Buffer.alloc(12);
  data.writeUInt32LE(2);
  data.writeBigUInt64LE(BigInt(size), 4);
  return new TransactionInstruction({
    programId: LOADER_V3,
    data,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: program, isSigner: false, isWritable: true },
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
  });
}
export async function pacedDeploy(
  c: Connection,
  program: Keypair,
  buffer: Keypair,
  authority: Keypair,
  artifact: Buffer,
) {
  assert((await c.getGenesisHash()) === DEVNET_GENESIS, "devnet_required");
  await mkdir("evidence/render-devnet", { recursive: true });
  const journal = "evidence/render-devnet/deployment-upload.jsonl";
  const log = async (record: Record<string, unknown>) =>
    appendFile(journal, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
  await log({
    event: "resume",
    program: program.publicKey.toBase58(),
    buffer: buffer.publicKey.toBase58(),
    artifact_sha256: createHash("sha256").update(artifact).digest("hex"),
  });
  async function confirmed(signature: string, lastHeight: number, final = false) {
    for (let i = 0; i < 90; i++) {
      const status = (await c.getSignatureStatuses([signature], { searchTransactionHistory: true }))
        .value[0];
      assert(!status?.err, "deployment_transaction_failed");
      if (
        status &&
        (status.confirmationStatus === "finalized" ||
          (!final && status.confirmationStatus === "confirmed"))
      )
        return;
      assert(
        (await c.getBlockHeight("finalized")) <= lastHeight,
        "deployment_signature_expired_reconcile",
      );
      await pause(1000);
    }
    throw new Error("deployment_confirmation_unknown_reconcile_journal");
  }
  async function transaction(
    instructions: TransactionInstruction[],
    extra: Keypair[] = [],
    name = "write",
    offset?: number,
    lifetime?: Awaited<ReturnType<Connection["getLatestBlockhash"]>>,
  ) {
    const life = lifetime ?? (await c.getLatestBlockhash("finalized")),
      tx = new Transaction({ feePayer: authority.publicKey, ...life }).add(...instructions);
    tx.sign(authority, ...extra);
    const signature = bs58.encode(tx.signatures[0]!.signature!);
    await log({
      event: "prepared",
      name,
      offset,
      signature,
      blockhash: life.blockhash,
      last_valid_block_height: life.lastValidBlockHeight,
    });
    await c.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 0,
      preflightCommitment: "finalized",
    });
    return { signature, lastHeight: life.lastValidBlockHeight, tx };
  }
  let account = await c.getAccountInfo(buffer.publicKey, "finalized");
  if (!account) {
    const init = new TransactionInstruction({
      programId: LOADER_V3,
      keys: [
        { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(4),
    });
    const sent = await transaction(
      [
        SystemProgram.createAccount({
          fromPubkey: authority.publicKey,
          newAccountPubkey: buffer.publicKey,
          lamports: await c.getMinimumBalanceForRentExemption(artifact.length + 45),
          space: artifact.length + 37,
          programId: LOADER_V3,
        }),
        init,
      ],
      [buffer],
      "create_buffer",
    );
    await confirmed(sent.signature, sent.lastHeight, true);
    account = await c.getAccountInfo(buffer.publicKey, "finalized");
  }
  assert(
    account &&
      account.owner.equals(LOADER_V3) &&
      account.data.readUInt32LE(0) === 1 &&
      account.data[4] === 1 &&
      new PublicKey(account.data.subarray(5, 37)).equals(authority.publicKey) &&
      account.data.length === artifact.length + 37,
    "deployment_buffer_mismatch",
  );
  const missing: number[] = [];
  for (let offset = 0; offset < artifact.length; offset += 1000) {
    const end = Math.min(offset + 1000, artifact.length);
    if (!account.data.subarray(offset + 37, end + 37).equals(artifact.subarray(offset, end)))
      missing.push(offset);
  }
  console.info(
    JSON.stringify({
      event: "deployment.upload_resume",
      missing_chunks: missing.length,
      total_chunks: Math.ceil(artifact.length / 1000),
    }),
  );
  for (let index = 0; index < missing.length; index += 8) {
    const pending = [],
      life = await c.getLatestBlockhash("finalized");
    for (const offset of missing.slice(index, index + 8)) {
      pending.push(
        await transaction(
          [
            writeBuffer(
              buffer.publicKey,
              authority.publicKey,
              offset,
              artifact.subarray(offset, Math.min(offset + 1000, artifact.length)),
            ),
          ],
          [],
          "write",
          offset,
          life,
        ),
      );
    }
    let landed = false;
    for (let poll = 0; poll < 90; poll++) {
      const statuses = (
        await c.getSignatureStatuses(
          pending.map((sent) => sent.signature),
          { searchTransactionHistory: true },
        )
      ).value;
      assert(
        statuses.every((status) => !status?.err),
        "buffer_write_execution_failed",
      );
      if (
        statuses.every(
          (status) =>
            status &&
            (status.confirmationStatus === "confirmed" ||
              status.confirmationStatus === "finalized"),
        )
      ) {
        landed = true;
        break;
      }
      assert(
        (await c.getBlockHeight("finalized")) <= life.lastValidBlockHeight,
        "buffer_write_expired_reconcile",
      );
      await pause(1000);
    }
    assert(landed, "buffer_write_unknown_reconcile");
    const completed = Math.min(index + 8, missing.length);
    await log({ event: "batch_confirmed", completed, missing_chunks: missing.length });
    if (completed % 40 === 0 || completed === missing.length)
      console.info(
        JSON.stringify({
          event: "deployment.upload_progress",
          completed,
          missing_chunks: missing.length,
        }),
      );
  }
  let verified = false;
  for (let i = 0; i < 45; i++) {
    const current = await c.getAccountInfo(buffer.publicKey, "finalized");
    if (current?.data.subarray(37).equals(artifact)) {
      verified = true;
      break;
    }
    await pause(2000);
  }
  assert(verified, "deployment_buffer_bytes_not_finalized");
  await log({ event: "buffer_bytes_finalized" });
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }),
    SystemProgram.createAccount({
      fromPubkey: authority.publicKey,
      newAccountPubkey: program.publicKey,
      lamports: await c.getMinimumBalanceForRentExemption(36),
      space: 36,
      programId: LOADER_V3,
    }),
    deployInstruction(program.publicKey, buffer.publicKey, authority.publicKey, artifact.length),
  ];
  const life = await c.getLatestBlockhash("finalized"),
    simulationTx = new Transaction({ feePayer: authority.publicKey, ...life }).add(...instructions);
  simulationTx.sign(authority, program);
  const simulation = await c.simulateTransaction(
    VersionedTransaction.deserialize(simulationTx.serialize()),
    { sigVerify: true, commitment: "finalized" },
  );
  if (simulation.value.err) {
    console.info(
      JSON.stringify({
        event: "deployment.simulation_failed",
        error: simulation.value.err,
        logs: simulation.value.logs?.slice(-5),
      }),
    );
    throw new Error("deployment_simulation_failed");
  }
  const sent = await transaction(instructions, [program], "deploy");
  await confirmed(sent.signature, sent.lastHeight, true);
  await log({ event: "deployment_finalized", signature: sent.signature });
  return { programId: program.publicKey.toBase58(), signature: sent.signature };
}
