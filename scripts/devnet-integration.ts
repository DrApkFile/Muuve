import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { PublicKey, Transaction, Keypair, VersionedTransaction } from "@solana/web3.js";
import { Chain, linkPda, ata, type Prepared } from "../apps/web/lib/server/solana/chain";
import { keypair } from "../apps/web/lib/server/config";
import { assert } from "../apps/web/lib/server/errors";
import { AppError } from "../apps/web/lib/server/errors";
import { operatorConnection } from "./operator";
async function main() {
  // Explicit operator-run contract integration, separate from offline API tests.
  // Never creates wallets, requests funds, deploys, initializes Config or contacts fiat/OTP providers.
  assert(
    process.env.MUUVE_RUN_DEVNET_TRANSACTIONS === "1",
    "explicit_devnet_transaction_consent_required",
  );
  assert(process.env.OPERATOR_APPROVED_DEVNET === "1", "operator_approval_required");
  const sender = keypair("DEVNET_TEST_SENDER_SECRET"),
    claimKey = keypair("DEVNET_TEST_CLAIM_SECRET");
  assert(process.env.DEVNET_TEST_RECIPIENT, "explicit_test_recipient_required");
  const recipient = new PublicKey(process.env.DEVNET_TEST_RECIPIENT!),
    chain = new Chain();
  // The public devnet endpoint needs paced reads as well as paced writes.
  // Keep the actual Chain implementation while using the operator's bounded transport.
  chain.connections.splice(0, chain.connections.length, await operatorConnection());
  assert(!recipient.equals(sender.publicKey), "separate_test_recipient_required");
  const state = await chain.readiness();
  const resumeFile = process.env.MUUVE_DEVNET_RESUME_EVIDENCE;
  if (!resumeFile)
    assert(
      BigInt(await chain.balance(sender.publicKey.toBase58())) >= 7_000_000n,
      "prefund_sender_with_at_least_7_test_tokens",
    );
  const file =
    resumeFile ?? `evidence/devnet/${new Date().toISOString().replaceAll(":", "-")}.json`;
  const evidence: {
    network: string;
    program: string;
    mint: string;
    token_program: string;
    steps: Record<string, unknown>[];
    complete: boolean;
  } = resumeFile
    ? JSON.parse(await readFile(resumeFile, "utf8"))
    : {
        network: "devnet",
        program: chain.program.toBase58(),
        mint: state.mint,
        token_program: state.tokenProgram,
        steps: [],
        complete: false,
      };
  await mkdir("evidence/devnet", { recursive: true });
  async function save() {
    await writeFile(file + ".tmp", JSON.stringify(evidence, null, 2) + "\n");
    await rename(file + ".tmp", file);
  }
  assert(
    evidence.network === "devnet" &&
      evidence.program === chain.program.toBase58() &&
      evidence.mint === state.mint &&
      evidence.token_program === state.tokenProgram,
    "resume_configuration_mismatch",
  );
  for (const record of evidence.steps.filter((step) => typeof step.signature === "string")) {
    const status = await chain.status(record.signature as string);
    assert(
      status?.confirmationStatus === "finalized" && !status.err,
      "resume_requires_finalized_recorded_signatures",
    );
    record.state = "finalized";
  }
  if (resumeFile) await save();
  let fixtureIndex = 0;
  async function execute(name: string, p: Prepared, signers: Keypair[] = [], rebroadcast = false) {
    const tx = Transaction.from(Buffer.from(p.tx, "base64"));
    if (signers.length) tx.partialSign(...signers);
    assert(tx.verifySignatures(), `prepared_case_invalid_signatures:${name}`);
    const record: Record<string, unknown> = {
      name,
      signature: p.signature,
      blockhash: p.blockhash,
      last_valid_block_height: p.lastValidBlockHeight,
      state: "prepared",
    };
    evidence.steps.push(record);
    await save();
    try {
      const raw = tx.serialize();
      await chain.send(raw);
      if (rebroadcast) {
        try {
          await chain.send(raw);
          record.rebroadcast = "accepted_same_signature";
        } catch {
          const known = await chain.status(p.signature);
          assert(known && !known.err, "rebroadcast_outcome_unknown");
          record.rebroadcast = "already_seen_on_chain";
        }
      }
      const result = await chain.rpc((c) =>
        c.confirmTransaction(
          {
            signature: p.signature,
            blockhash: p.blockhash,
            lastValidBlockHeight: p.lastValidBlockHeight,
          },
          "finalized",
        ),
      );
      assert(!result.value.err, "devnet_execution_failed");
      record.state = "finalized";
      await save();
    } catch {
      const known = await chain.status(p.signature).catch(() => undefined);
      if (known?.confirmationStatus === "finalized" && !known.err) {
        record.state = "finalized";
        record.reconciled_after_error = true;
        await save();
        return;
      }
      record.state = "unknown_or_failed";
      await save();
      throw new Error(
        `Reconcile recorded signature for ${name} before rerunning; evidence: ${file}`,
      );
    }
  }
  async function rejected(name: string, p: Prepared, signers: Keypair[]) {
    const tx = Transaction.from(Buffer.from(p.tx, "base64"));
    if (signers.length) tx.partialSign(...signers);
    assert(tx.verifySignatures(), `negative_case_invalid_signatures:${name}`);
    const result = await chain.rpc((c) =>
      c.simulateTransaction(VersionedTransaction.deserialize(tx.serialize()), {
        sigVerify: true,
        commitment: "finalized",
      }),
    );
    assert(
      result.value.err &&
        result.value.logs?.some((l) => l.startsWith(`Program ${chain.program.toBase58()} invoke`)),
      `negative_case_not_rejected_by_program:${name}`,
    );
    evidence.steps.push({ name, state: "rejected_in_devnet_simulation", error: result.value.err });
    await save();
  }
  async function changed(
    p: Prepared,
    change: (instruction: ReturnType<typeof Transaction.from>["instructions"][number]) => void,
    clients: Keypair[],
    server: Keypair[] = [chain.keys.attestor],
  ) {
    const instructions = Transaction.from(Buffer.from(p.tx, "base64")).instructions.slice(0, -1);
    const instruction = instructions.find((i) => i.programId.equals(chain.program));
    assert(instruction, "missing_test_instruction");
    change(instruction);
    return chain.prepare(
      instructions,
      clients.map((k) => k.publicKey),
      false,
      server,
    );
  }
  async function create(amounts: string[]) {
    const prior = evidence.steps.filter((step) => step.name === "link_fixture")[fixtureIndex++];
    if (prior) {
      assert(typeof prior.pda === "string", "invalid_resume_fixture");
      const existing = await chain.link(prior.pda);
      assert(
        existing &&
          existing.sender === sender.publicKey.toBase58() &&
          existing.claimPubkey === claimKey.publicKey.toBase58() &&
          JSON.stringify(existing.slots.map((slot) => slot.amount)) === JSON.stringify(amounts),
        "resume_fixture_mismatch",
      );
      return prior.pda;
    }
    const id = randomBytes(16).toString("hex"),
      pda = linkPda(sender.publicKey.toBase58(), id).toBase58();
    evidence.steps.push({
      name: "link_fixture",
      sender: sender.publicKey.toBase58(),
      local_id: id,
      pda,
    });
    await save();
    await execute(
      "create_link",
      await chain.create(sender.publicKey.toBase58(), id, claimKey.publicKey.toBase58(), amounts),
      [sender],
      true,
    );
    const link = await chain.link(pda);
    assert(
      link &&
        link.expiresAt - link.createdAt === 172800 &&
        link.total === amounts.reduce((s, x) => s + BigInt(x), 0n).toString(),
      "incorrect_created_link",
    );
    return pda;
  }
  async function claim(pda: string, index: number, mode: "keep" | "cashout") {
    let link = await chain.link(pda);
    assert(link, "missing_link");
    if (link.slots[index]?.status === 2) {
      assert(
        link.slots[index]!.toTreasury === (mode === "cashout") &&
          link.slots[index]!.destination ===
            (mode === "cashout"
              ? link.treasury
              : ata(recipient, link.mint, link.tokenProgram).toBase58()),
        "resume_claim_destination_mismatch",
      );
      return;
    }
    await execute(
      "start_claim",
      await chain.intent(pda, link, index, randomUUID(), mode, recipient.toBase58()),
      [claimKey],
    );
    link = await chain.link(pda);
    assert(link, "missing_link");
    await rejected(
      "recall_rejected_during_claim_priority",
      await chain.settle(pda, link, "recall", index),
      [sender],
    );
    if (mode === "keep")
      await rejected(
        "wrong_wallet_destination",
        await chain.settle(pda, link, "claim_keep", index, sender.publicKey.toBase58()),
        [claimKey],
      );
    else {
      const p = await chain.settle(pda, link, "claim_cashout", index, link.treasuryOwner);
      const wrong = await changed(
        p,
        (i) => {
          i.keys[7]!.pubkey = sender.publicKey;
          i.keys[8]!.pubkey = ata(sender.publicKey, link!.mint, link!.tokenProgram);
        },
        [claimKey],
      );
      await rejected("unauthorized_treasury_destination", wrong, [claimKey]);
    }
    await execute(
      mode === "keep" ? "claim_to_wallet" : "claim_to_treasury",
      await chain.settle(
        pda,
        link,
        mode === "keep" ? "claim_keep" : "claim_cashout",
        index,
        mode === "keep" ? recipient.toBase58() : link.treasuryOwner,
      ),
      [claimKey],
    );
    const after = await chain.link(pda);
    assert(after?.slots[index]?.status === 2, "claim_not_observed");
  }
  const single = await create(["1000000"]);
  await claim(single, 0, "keep");
  assert((await chain.link(single))?.openSlots === 0, "single_not_terminal");
  const batch = await create(["1000000", "2000000", "3000000"]);
  const before = await chain.link(batch);
  assert(before, "missing_batch");
  await rejected(
    "expiry_rejected_before_deadline",
    await chain.settle(batch, before, "expire"),
    [],
  );
  const intended = await chain.intent(batch, before, 0, randomUUID(), "keep", recipient.toBase58());
  await rejected(
    "invalid_claim_key",
    await changed(
      intended,
      (i) => {
        i.keys[1]!.pubkey = sender.publicKey;
      },
      [sender],
    ),
    [sender],
  );
  await rejected(
    "invalid_attestor",
    await changed(
      intended,
      (i) => {
        i.keys[2]!.pubkey = chain.keys.treasury.publicKey;
      },
      [claimKey],
      [chain.keys.treasury],
    ),
    [claimKey],
  );
  await rejected(
    "invalid_slot_index",
    await changed(
      intended,
      (i) => {
        i.data[8] = 10;
      },
      [claimKey],
    ),
    [claimKey],
  );
  const recall = await chain.settle(batch, before, "recall", 2);
  await rejected(
    "sender_only_recall",
    await changed(
      recall,
      (i) => {
        // Decompilation propagates a signer's flag to every duplicate account
        // occurrence. The legitimate sender remains only a readonly destination.
        for (const key of i.keys) if (key.pubkey.equals(sender.publicKey)) key.isSigner = false;
      },
      [],
      [],
    ),
    [],
  );
  await claim(batch, 0, "keep");
  const afterFirst = await chain.link(batch);
  assert(afterFirst, "missing_batch");
  await rejected(
    "duplicate_claim",
    await chain.settle(batch, afterFirst, "claim_keep", 0, recipient.toBase58()),
    [claimKey],
  );
  await claim(batch, 1, "cashout");
  let link = await chain.link(batch);
  assert(link?.slots[2]?.status === 1 && link.slots[2].amount === "3000000", "other_slot_changed");
  await execute("recall_slot", await chain.settle(batch, link, "recall", 2), [sender]);
  link = await chain.link(batch);
  assert(link?.openSlots === 0 && link.slots[2]?.status === 3, "batch_not_terminal");
  const aged = process.env.MUUVE_DEVNET_EXPIRED_LINK_PDA;
  if (aged) {
    const expired = await chain.link(aged);
    assert(
      expired &&
        expired.sender === sender.publicKey.toBase58() &&
        expired.expiresAt * 1000 <= Date.now() &&
        expired.openSlots > 0,
      "invalid_aged_fixture",
    );
    await execute("expire", await chain.settle(aged, expired, "expire"));
    assert((await chain.link(aged))?.openSlots === 0, "expiry_not_terminal");
  } else {
    const expiryFixture = await create(["1000000"]);
    const waiting = await chain.link(expiryFixture);
    assert(waiting, "missing_expiry_fixture");
    evidence.steps.push({
      name: "expiry_fixture",
      pda: expiryFixture,
      created_at: waiting.createdAt,
      expires_at: waiting.expiresAt,
      state: "waiting_48_hours",
    });
    evidence.steps.push({
      name: "expiry",
      state: "not_run",
      prerequisite: "operator-provided genuinely aged MUUVE_DEVNET_EXPIRED_LINK_PDA",
    });
  }
  evidence.complete = !!aged;
  await save();
  console.info(
    JSON.stringify({
      evidence: file,
      completed_transactions: evidence.steps.filter((s) => s.state === "finalized").length,
      expiry_verified: !!aged,
      provider: "none; contract integration only",
    }),
  );
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  console.error(
    JSON.stringify({
      state: "blocked_or_uncertain",
      code:
        error instanceof AppError
          ? error.code
          : /429|Too Many/i.test(message)
            ? "rpc_rate_limit"
            : /fetch|timeout|abort/i.test(message)
              ? "rpc_transport_failure"
              : "integration_or_rpc_failure",
      error_name: error instanceof Error ? error.name : "unknown",
    }),
  );
  console.error(
    error instanceof AppError
      ? error.code
      : "Operator action failed; reconcile any recorded signature before retrying. See docs/backend-runbook.md.",
  );
  process.exitCode = 1;
});
