import { mkdir, writeFile } from "node:fs/promises";
import { Chain, ata } from "../apps/web/lib/server/solana/chain";
import { operatorConnection, requiredPublic } from "./operator";
import { assert } from "../apps/web/lib/server/errors";
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
async function main() {
  const connection = await operatorConnection();
  assert(
    process.env.MUUVE_RUN_DEVNET_TRANSACTIONS === "1",
    "explicit_devnet_transaction_consent_required",
  );
  const chain = new Chain(),
    pda = requiredPublic("MUUVE_DEVNET_EXPIRED_LINK_PDA").toBase58();
  chain.connections.splice(0, chain.connections.length, connection);
  const before = await chain.link(pda);
  assert(before, "fixture_missing");
  assert([172800, 240].includes(before.expiresAt - before.createdAt), "invalid_claim_window");
  const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "finalized");
  assert(clock && clock.data.length >= 40, "chain_clock_unavailable");
  if (Number(clock.data.readBigInt64LE(32)) < before.expiresAt) {
    console.info(
      JSON.stringify({
        state: "waiting_for_actual_deadline",
        pda,
        expires_at: new Date(before.expiresAt * 1000).toISOString(),
        transaction_submitted: false,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const tokenProgram = new PublicKey(before.tokenProgram),
    vault = ata(pda, before.mint, before.tokenProgram),
    senderAta = ata(before.sender, before.mint, before.tokenProgram),
    vaultBefore = await getAccount(connection, vault, "finalized", tokenProgram);
  // The fixture's original sender ATA must already exist. Do not create test accounts here.
  await getAccount(connection, senderAta, "finalized", tokenProgram);
  const prepared = await chain.settle(pda, before, "expire");
  const record = {
    network: "devnet",
    pda,
    signature: prepared.signature,
    blockhash: prepared.blockhash,
    last_valid_block_height: prepared.lastValidBlockHeight,
    state: "prepared",
    expires_at: before.expiresAt,
    verification: undefined as
      | undefined
      | { sender_refund_base_units: string; vault_closed: boolean; rent_beneficiary: string },
  };
  await mkdir("evidence/devnet", { recursive: true });
  const file = `evidence/devnet/expiry-${pda}.json`;
  // Persist known signature before broadcast. Program clock enforces the exact deadline.
  await writeFile(file, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  try {
    await chain.send(Buffer.from(prepared.tx, "base64"));
    const result = await chain.rpc((c) =>
      c.confirmTransaction(
        {
          signature: prepared.signature,
          blockhash: prepared.blockhash,
          lastValidBlockHeight: prepared.lastValidBlockHeight,
        },
        "finalized",
      ),
    );
    assert(!result.value.err, "expiry_execution_failed");
    const after = await chain.link(pda);
    assert(
      after?.openSlots === 0 &&
        after.slots.every(
          (slot, i) =>
            slot.amount === before.slots[i]!.amount &&
            slot.status === (before.slots[i]!.status === 1 ? 4 : before.slots[i]!.status),
        ),
      "expiry_not_terminal",
    );
    assert(!(await connection.getAccountInfo(vault, "finalized")), "vault_not_closed");
    const tx = await connection.getTransaction(prepared.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    assert(tx?.meta && !tx.meta.err, "expiry_transaction_metadata_required");
    const accounts = tx.transaction.message.getAccountKeys().staticAccountKeys,
      senderIndex = accounts.findIndex((key) => key.equals(senderAta)),
      vaultIndex = accounts.findIndex((key) => key.equals(vault)),
      rentIndex = accounts.findIndex((key) => key.toBase58() === before.rentPayer),
      tokenBalance = (rows: typeof tx.meta.preTokenBalances, index: number) =>
        BigInt(rows?.find((row) => row.accountIndex === index)?.uiTokenAmount.amount ?? "0");
    assert(senderIndex >= 0 && vaultIndex >= 0 && rentIndex >= 0, "expiry_accounts_missing");
    assert(
      tokenBalance(tx.meta.postTokenBalances, senderIndex) -
        tokenBalance(tx.meta.preTokenBalances, senderIndex) ===
        vaultBefore.amount,
      "sender_refund_mismatch",
    );
    // Fee payer is message account zero. The stored rent beneficiary receives vault rent.
    assert(
      tx.meta.postBalances[rentIndex]! - tx.meta.preBalances[rentIndex]! ===
        tx.meta.preBalances[vaultIndex]! - (rentIndex === 0 ? tx.meta.fee : 0),
      "rent_refund_mismatch",
    );
    record.verification = {
      sender_refund_base_units: vaultBefore.amount.toString(),
      vault_closed: true,
      rent_beneficiary: before.rentPayer,
    };
    record.state = "finalized";
    await writeFile(file, JSON.stringify(record, null, 2) + "\n");
    console.info(JSON.stringify(record));
  } catch {
    record.state = "unknown_or_failed";
    await writeFile(file, JSON.stringify(record, null, 2) + "\n");
    throw new Error("Reconcile the recorded expiry signature before retrying");
  }
}
main().catch(() => {
  console.error(
    "Expiry verification blocked or uncertain. Use a genuinely aged 48-hour fixture and reconcile any recorded signature.",
  );
  process.exitCode = 1;
});
