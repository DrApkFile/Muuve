import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { PublicKey, Transaction, Keypair } from "@solana/web3.js";
import { Chain, linkPda, type Prepared } from "../apps/web/lib/server/solana/chain";
import { keypair } from "../apps/web/lib/server/config";
import { assert } from "../apps/web/lib/server/errors";
import { AppError } from "../apps/web/lib/server/errors";
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
  assert(!recipient.equals(sender.publicKey), "separate_test_recipient_required");
  const state = await chain.readiness();
  assert(
    BigInt(await chain.balance(sender.publicKey.toBase58())) >= 7_000_000n,
    "prefund_sender_with_at_least_7_test_tokens",
  );
  const file = `evidence/devnet/${new Date().toISOString().replaceAll(":", "-")}.json`;
  const evidence: {
    network: string;
    program: string;
    mint: string;
    token_program: string;
    steps: Record<string, unknown>[];
    complete: boolean;
  } = {
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
  async function execute(name: string, p: Prepared, signers: Keypair[] = [], rebroadcast = false) {
    const tx = Transaction.from(Buffer.from(p.tx, "base64"));
    if (signers.length) tx.partialSign(...signers);
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
      if (rebroadcast) await chain.send(raw);
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
      record.state = "unknown_or_failed";
      await save();
      throw new Error(
        `Reconcile recorded signature for ${name} before rerunning; evidence: ${file}`,
      );
    }
  }
  async function create(amounts: string[]) {
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
    await execute(
      "start_claim",
      await chain.intent(pda, link, index, randomUUID(), mode, recipient.toBase58()),
      [claimKey],
    );
    link = await chain.link(pda);
    assert(link, "missing_link");
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
  await claim(batch, 0, "keep");
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
  } else
    evidence.steps.push({
      name: "expiry",
      state: "not_run",
      prerequisite: "operator-provided genuinely aged MUUVE_DEVNET_EXPIRED_LINK_PDA",
    });
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
  console.error(
    error instanceof AppError
      ? error.code
      : "Operator action failed; reconcile any recorded signature before retrying. See docs/backend-runbook.md.",
  );
  process.exitCode = 1;
});
