import { readFile, writeFile } from "node:fs/promises";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { getAccount, getMint } from "@solana/spl-token";
import { Chain, ata } from "../apps/web/lib/server/solana/chain";
import { operatorConnection } from "./operator";
import { keypair } from "../apps/web/lib/server/config";
import { assert } from "../apps/web/lib/server/errors";

async function main() {
  const file = process.env.MUUVE_DEVNET_RESUME_EVIDENCE;
  assert(file, "integration_evidence_required");
  const evidence = JSON.parse(await readFile(file, "utf8")),
    c = await operatorConnection(),
    chain = new Chain();
  chain.connections.splice(0, chain.connections.length, c);
  const config = await chain.readiness(),
    sender = keypair("DEVNET_TEST_SENDER_SECRET").publicKey,
    recipient = process.env.DEVNET_TEST_RECIPIENT!;
  assert(
    evidence.network === "devnet" &&
      evidence.program === chain.program.toBase58() &&
      evidence.mint === config.mint,
    "evidence_configuration_mismatch",
  );
  const signatures = evidence.steps.filter((s: any) => s.signature).map((s: any) => s.signature);
  const statuses = (await c.getSignatureStatuses(signatures, { searchTransactionHistory: true }))
    .value;
  assert(
    statuses.length === 10 &&
      statuses.every((s) => s?.confirmationStatus === "finalized" && !s.err),
    "integration_signatures_not_finalized",
  );
  const expectedCodes: Record<string, number[]> = {
    recall_rejected_during_claim_priority: [6021],
    wrong_wallet_destination: [6018],
    expiry_rejected_before_deadline: [6007],
    invalid_claim_key: [6009],
    invalid_attestor: [6010],
    invalid_slot_index: [6004],
    sender_only_recall: [2015, 6011],
    duplicate_claim: [6005],
    unauthorized_treasury_destination: [6012, 6018],
    sender_signature_required: [6011],
  };
  for (const step of evidence.steps.filter((s: any) => s.state === "rejected_in_devnet_simulation"))
    assert(
      expectedCodes[step.name]?.includes(step.error?.InstructionError?.[1]?.Custom),
      `unexpected_negative_rejection:${step.name}`,
    );
  const fixtures = evidence.steps.filter((s: any) => s.name === "link_fixture");
  assert(fixtures.length === 3, "missing_lifecycle_fixtures");
  const amounts = [["1000000"], ["1000000", "2000000", "3000000"], ["1000000"]],
    states = [[2], [2, 2, 3], [1]];
  const links = [];
  for (let i = 0; i < fixtures.length; i++) {
    const link = await chain.link(fixtures[i].pda);
    assert(
      link &&
        link.sender === sender.toBase58() &&
        [172800, 240].includes(link.expiresAt - link.createdAt),
      "fixture_terms_mismatch",
    );
    assert(
      JSON.stringify(link.slots.map((s) => s.amount)) === JSON.stringify(amounts[i]) &&
        JSON.stringify(link.slots.map((s) => s.status)) === JSON.stringify(states[i]),
      "fixture_allocations_or_states_mismatch",
    );
    const vault = await c.getAccountInfo(
      ata(fixtures[i].pda, config.mint, config.tokenProgram),
      "finalized",
    );
    assert(i === 2 ? !!vault : !vault, "vault_lifecycle_mismatch");
    links.push({
      pda: fixtures[i].pda,
      open_slots: link.openSlots,
      allocations: amounts[i],
      statuses: states[i],
      vault_closed: !vault,
      expires_at: new Date(link.expiresAt * 1000).toISOString(),
    });
  }
  // Precisely test the original sender's signature, keeping every destination valid.
  const waiting = await chain.link(fixtures[2].pda);
  assert(waiting, "expiry_fixture_missing");
  const p = await chain.settle(fixtures[2].pda, waiting, "recall", 0),
    instructions = Transaction.from(Buffer.from(p.tx, "base64")).instructions.slice(0, -1);
  for (const ix of instructions)
    for (const key of ix.keys) if (key.pubkey.equals(sender)) key.isSigner = false;
  const unsignedSender = await chain.prepare(instructions, [], false),
    tx = Transaction.from(Buffer.from(unsignedSender.tx, "base64"));
  assert(tx.verifySignatures(), "invalid_simulation_signatures");
  const simulation = await c.simulateTransaction(VersionedTransaction.deserialize(tx.serialize()), {
    sigVerify: true,
    commitment: "finalized",
  });
  const error = simulation.value.err as { InstructionError?: [number, { Custom?: number }] } | null;
  assert(error?.InstructionError?.[1]?.Custom === 6011, "sender_signature_guard_not_verified");
  if (!evidence.steps.some((s: any) => s.name === "sender_signature_required")) {
    evidence.steps.push({
      name: "sender_signature_required",
      state: "rejected_in_devnet_simulation",
      error: simulation.value.err,
    });
    await writeFile(file, JSON.stringify(evidence, null, 2) + "\n");
  }
  const holders: Record<string, string> = {
    sender: sender.toBase58(),
    recipient,
    treasury: config.treasuryOwner,
    expiry_vault: fixtures[2].pda,
  };
  const balances: Record<string, string> = {};
  for (const [name, owner] of Object.entries(holders)) {
    const account = await getAccount(
      c,
      ata(owner, config.mint, config.tokenProgram),
      "finalized",
      new PublicKey(config.tokenProgram),
    );
    assert(
      account.owner.toBase58() === owner && account.mint.toBase58() === config.mint,
      "test_token_account_mismatch",
    );
    balances[name] = account.amount.toString();
  }
  assert(
    JSON.stringify(Object.values(balances)) ===
      JSON.stringify(["2000000", "2000000", "2000000", "1000000"]),
    "test_distribution_mismatch",
  );
  const mint = await getMint(
    c,
    new PublicKey(config.mint),
    "finalized",
    new PublicKey(config.tokenProgram),
  );
  assert(
    mint.supply === 7000000n && mint.decimals === 6 && !mint.freezeAuthority,
    "test_mint_supply_mismatch",
  );
  const record = {
    network: "devnet",
    state: "basic_contract_lifecycle_verified",
    checked_at: new Date().toISOString(),
    program: chain.program.toBase58(),
    finalized_transactions: signatures.length,
    negative_rejection_observations: evidence.steps.filter(
      (s: any) => s.state === "rejected_in_devnet_simulation",
    ).length,
    links,
    balances_base_units: balances,
    mint_supply_base_units: mint.supply.toString(),
    expiry_refund_verified: false,
    expiry_due: new Date(waiting.expiresAt * 1000).toISOString(),
    expiry_pda: fixtures[2].pda,
    scope: "deployed contract only; no fiat payout or live Privy wallet linking",
  };
  await writeFile(
    "evidence/devnet/lifecycle-verification.json",
    JSON.stringify(record, null, 2) + "\n",
  );
  console.info(JSON.stringify(record));
}
main().catch(() => {
  console.error(
    "Deployed lifecycle evidence verification failed; reconcile recorded signatures and account states.",
  );
  process.exitCode = 1;
});
