import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Transaction } from "@solana/web3.js";
import { operatorConnection, requiredPublic } from "./operator";
import { Chain } from "../apps/web/lib/server/solana/chain";
import { keypair } from "../apps/web/lib/server/config";
import { assert } from "../apps/web/lib/server/errors";
async function main() {
  await operatorConnection();
  const chain = new Chain(),
    sender = keypair("DEVNET_TEST_SENDER_SECRET").publicKey.toBase58();
  await chain.readiness();
  const path = "keys/devnet/test-funding-operation.json";
  let record: any;
  try {
    record = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
  if (!record) {
    const id = randomUUID(),
      prepared = await chain.fund(sender, "7000000", id);
    record = {
      id,
      sender,
      amount: "7000000",
      program: chain.program.toBase58(),
      mint: requiredPublic("USDT_MINT").toBase58(),
      prepared,
    };
    await writeFile(path, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
  }
  assert(((await stat(path)).mode & 0o077) === 0, "insecure_funding_record");
  assert(
    record.sender === sender &&
      record.mint === process.env.USDT_MINT &&
      record.program === chain.program.toBase58() &&
      record.amount === "7000000",
    "funding_record_mismatch",
  );
  const p = record.prepared,
    prior = await chain.status(p.signature);
  if (prior?.err)
    throw new Error("Test funding failed; review original operation before creating a replacement");
  if (prior?.confirmationStatus !== "finalized") {
    assert(
      (await chain.height()) <= p.lastValidBlockHeight,
      "funding_expired_reconcile_receipt_before_replacement",
    );
    await chain.send(Transaction.from(Buffer.from(p.tx, "base64")).serialize());
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
    assert(!result.value.err, "funding_execution_failed");
  }
  const evidence = {
    network: "devnet",
    state: "finalized",
    operation_id: record.id,
    signature: p.signature,
    sender,
    amount_base_units: record.amount,
    balance_base_units: await chain.balance(sender),
    verified_at: new Date().toISOString(),
  };
  await mkdir("evidence/devnet", { recursive: true });
  await writeFile("evidence/devnet/test-funding.json", JSON.stringify(evidence, null, 2) + "\n");
  console.info(JSON.stringify(evidence));
}
main().catch(() => {
  console.error(
    "Test funding blocked or uncertain; reconcile the durable local operation before retrying. No secret or signed transaction logged.",
  );
  process.exitCode = 1;
});
