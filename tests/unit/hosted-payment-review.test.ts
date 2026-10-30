import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, Transaction, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { setupEnv, payer, sender, mint, program } from "../helpers";
import { Chain } from "../../apps/web/lib/server/solana/chain";
import { reviewCreateTransaction } from "../../scripts/hosted-payment-review";
setupEnv();
async function fixture() {
  const chain = new Chain();
  const blockhash = Keypair.generate().publicKey.toBase58();
  vi.spyOn(chain, "rpc").mockResolvedValue({ blockhash, lastValidBlockHeight: 999 });
  const expected = {
    program: program.toBase58(),
    payer: payer.publicKey.toBase58(),
    sender: sender.publicKey.toBase58(),
    mint: mint.toBase58(),
    tokenProgram: process.env.TOKEN_PROGRAM_ID!,
    linkIdHex: "aabbccddeeff00112233445566778899",
    claimPublicKey: Keypair.generate().publicKey.toBase58(),
    amounts: ["500000", "1000000"],
    blockhash,
  };
  const prepared = await chain.create(
    expected.sender,
    expected.linkIdHex,
    expected.claimPublicKey,
    expected.amounts,
  );
  return { prepared, expected };
}
const encode = (tx: Transaction) =>
  tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
describe("hosted funding transaction review before operator approval", () => {
  afterEach(() => vi.restoreAllMocks());
  it("accepts the real backend builder without adding a sender signature", async () => {
    const { prepared, expected } = await fixture();
    expect(reviewCreateTransaction(prepared.tx, expected)).toMatchObject({
      sender_signature_present: false,
      total_base_units: "1500000",
      allocations: ["500000", "1000000"],
      instruction_count: 3,
    });
    expect(
      Transaction.from(Buffer.from(prepared.tx, "base64")).signatures[1]!.signature,
    ).toBeNull();
  });
  it("rejects changed fixed allocations and claim authority", async () => {
    const { prepared, expected } = await fixture();
    expect(() =>
      reviewCreateTransaction(prepared.tx, { ...expected, amounts: ["1000000", "500000"] }),
    ).toThrow("unexpected_create_data");
    expect(() =>
      reviewCreateTransaction(prepared.tx, {
        ...expected,
        claimPublicKey: Keypair.generate().publicKey.toBase58(),
      }),
    ).toThrow("unexpected_create_data");
  });
  it("rejects a substituted token account", async () => {
    const { prepared, expected } = await fixture();
    const tx = Transaction.from(Buffer.from(prepared.tx, "base64"));
    tx.instructions[1]!.keys[7]!.pubkey = Keypair.generate().publicKey;
    expect(() => reviewCreateTransaction(encode(tx), expected)).toThrow(
      "unexpected_create_accounts",
    );
  });
  it("rejects an additional native token transfer", async () => {
    const { prepared, expected } = await fixture();
    const tx = Transaction.from(Buffer.from(prepared.tx, "base64"));
    tx.add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: payer.publicKey,
        lamports: 1,
      }),
    );
    expect(() => reviewCreateTransaction(encode(tx), expected)).toThrow(
      "unexpected_instruction_count",
    );
  });
  it("rejects an altered compute budget or arbitrary memo", async () => {
    const { prepared, expected } = await fixture();
    const tx = Transaction.from(Buffer.from(prepared.tx, "base64"));
    tx.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
    expect(() => reviewCreateTransaction(encode(tx), expected)).toThrow(
      "unexpected_compute_budget",
    );
    const memo = Transaction.from(Buffer.from(prepared.tx, "base64"));
    memo.instructions[2]!.data = Buffer.from("unreviewed data");
    expect(() => reviewCreateTransaction(encode(memo), expected)).toThrow("unexpected_memo");
  });
  it("rejects a stale or mutated blockhash", async () => {
    const { prepared, expected } = await fixture();
    expect(() =>
      reviewCreateTransaction(prepared.tx, {
        ...expected,
        blockhash: Keypair.generate().publicKey.toBase58(),
      }),
    ).toThrow("unexpected_blockhash");
  });
  it("rejects a transaction already signed by the sender", async () => {
    const { prepared, expected } = await fixture();
    const tx = Transaction.from(Buffer.from(prepared.tx, "base64"));
    tx.partialSign(sender);
    expect(() => reviewCreateTransaction(encode(tx), expected)).toThrow("unexpected_signatures");
  });
  it("rejects an invalid existing server signature", async () => {
    const { prepared, expected } = await fixture();
    const tx = Transaction.from(Buffer.from(prepared.tx, "base64"));
    tx.signatures[0]!.signature!.fill(0);
    expect(() => reviewCreateTransaction(encode(tx), expected)).toThrow("unexpected_signatures");
  });
});
