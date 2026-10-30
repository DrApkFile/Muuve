import { PublicKey, SystemProgram, ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { createHash } from "node:crypto";
import { bytes16, ix, meta, u64 } from "../apps/web/lib/server/solana/codec";

export type CreateReview = {
  program: string;
  payer: string;
  sender: string;
  mint: string;
  tokenProgram: string;
  linkIdHex: string;
  claimPublicKey: string;
  amounts: string[];
  blockhash: string;
};
function requireThat(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
/** Review only. Never adds a sender signature or broadcasts a transaction. */
export function reviewCreateTransaction(encoded: string, expected: CreateReview) {
  const tx = Transaction.from(Buffer.from(encoded, "base64"));
  const program = new PublicKey(expected.program),
    sender = new PublicKey(expected.sender),
    payer = new PublicKey(expected.payer),
    mint = new PublicKey(expected.mint),
    token = new PublicKey(expected.tokenProgram);
  requireThat(/^[0-9a-f]{32}$/.test(expected.linkIdHex), "invalid_review_link_id");
  const link = PublicKey.findProgramAddressSync(
    [Buffer.from("link"), sender.toBuffer(), bytes16(expected.linkIdHex)],
    program,
  )[0];
  const vault = getAssociatedTokenAddressSync(mint, link, true, token);
  const senderAta = getAssociatedTokenAddressSync(mint, sender, false, token);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(expected.amounts.length);
  const instruction = ix(
    program,
    "create_link",
    [
      meta(sender, false, true),
      meta(payer, true, true),
      meta(PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0]),
      meta(link, true),
      meta(mint),
      meta(token),
      meta(senderAta, true),
      meta(vault, true),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    bytes16(expected.linkIdHex),
    new PublicKey(expected.claimPublicKey).toBuffer(),
    len,
    ...expected.amounts.map((amount) => u64(amount)),
  );
  requireThat(tx.feePayer?.equals(payer), "unexpected_fee_payer");
  requireThat(tx.recentBlockhash === expected.blockhash, "unexpected_blockhash");
  requireThat(tx.instructions.length === 3, "unexpected_instruction_count");
  const [budget, create, memo] = tx.instructions;
  const expectedBudget = ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 });
  requireThat(
    budget!.programId.equals(expectedBudget.programId) &&
      budget!.keys.length === 0 &&
      budget!.data.equals(expectedBudget.data),
    "unexpected_compute_budget",
  );
  requireThat(
    create!.programId.equals(program) && create!.data.equals(instruction.data),
    "unexpected_create_data",
  );
  requireThat(
    create!.keys.length === instruction.keys.length &&
      create!.keys.every((key, index) => {
        const wanted = instruction.keys[index]!;
        return (
          key.pubkey.equals(wanted.pubkey) &&
          key.isSigner === wanted.isSigner &&
          key.isWritable === wanted.isWritable
        );
      }),
    "unexpected_create_accounts",
  );
  requireThat(
    memo!.programId.toBase58() === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" &&
      memo!.keys.length === 0 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        memo!.data.toString("utf8"),
      ),
    "unexpected_memo",
  );
  requireThat(
    tx.signatures.length === 2 &&
      tx.signatures[0]!.publicKey.equals(payer) &&
      tx.signatures[0]!.signature !== null &&
      tx.signatures[1]!.publicKey.equals(sender) &&
      tx.signatures[1]!.signature === null &&
      tx.verifySignatures(false),
    "unexpected_signatures",
  );
  return {
    link_pda: link.toBase58(),
    vault: vault.toBase58(),
    sender_token_account: senderAta.toBase58(),
    message_sha256: createHash("sha256").update(tx.serializeMessage()).digest("hex"),
    instruction_count: 3,
    sender_signature_present: false,
    allocations: expected.amounts,
    total_base_units: expected.amounts
      .reduce((total, amount) => total + BigInt(amount), 0n)
      .toString(),
  };
}
