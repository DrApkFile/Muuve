import { createHash } from "node:crypto";
import { PublicKey, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { assert } from "../errors";
export const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest();
export const discriminator = (namespace: string, name: string) =>
  hash(`${namespace}:${name}`).subarray(0, 8);
export const bytes16 = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");
export function u64(value: bigint | string | number) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(value));
  return b;
}
export function ix(program: PublicKey, name: string, keys: AccountMeta[], ...data: Uint8Array[]) {
  return new TransactionInstruction({
    programId: program,
    keys,
    data: Buffer.concat([discriminator("global", name), ...data]),
  });
}
export const meta = (key: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({
  pubkey: key,
  isWritable,
  isSigner,
});
class Reader {
  offset = 8;
  constructor(
    readonly b: Buffer,
    name: string,
  ) {
    assert(b.subarray(0, 8).equals(discriminator("account", name)), "invalid_chain_account", 503);
  }
  bytes(n: number) {
    assert(this.offset + n <= this.b.length, "invalid_chain_account", 503);
    const value = this.b.subarray(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }
  key() {
    return new PublicKey(this.bytes(32)).toBase58();
  }
  n64() {
    return this.bytes(8).readBigUInt64LE();
  }
  i64() {
    return this.bytes(8).readBigInt64LE();
  }
  byte() {
    return this.bytes(1)[0]!;
  }
}
export type ChainSlot = {
  amount: string;
  status: number;
  intentId: string;
  version: string;
  priorityUntil: number;
  destination: string;
  toTreasury: boolean;
};
export function decodeLink(data: Buffer) {
  const r = new Reader(data, "Link");
  const linkId = r.bytes(16).toString("hex"),
    sender = r.key(),
    rentPayer = r.key(),
    claimPubkey = r.key(),
    mint = r.key(),
    tokenProgram = r.key(),
    attestor = r.key(),
    treasury = r.key(),
    treasuryOwner = r.key();
  const createdAt = Number(r.i64()),
    expiresAt = Number(r.i64()),
    total = r.n64().toString(),
    slotCount = r.byte(),
    openSlots = r.byte();
  assert(slotCount >= 1 && slotCount <= 10 && openSlots <= slotCount, "invalid_chain_account", 503);
  const slots: ChainSlot[] = Array.from({ length: 10 }, () => ({
    amount: r.n64().toString(),
    status: r.byte(),
    intentId: r.bytes(16).toString("hex"),
    version: r.n64().toString(),
    priorityUntil: Number(r.i64()),
    destination: r.key(),
    toTreasury: r.byte() === 1,
  }));
  const bump = r.byte();
  return {
    linkId,
    sender,
    rentPayer,
    claimPubkey,
    mint,
    tokenProgram,
    attestor,
    treasury,
    treasuryOwner,
    createdAt,
    expiresAt,
    total,
    slotCount,
    openSlots,
    slots: slots.slice(0, slotCount),
    bump,
  };
}
export type ChainLink = ReturnType<typeof decodeLink>;
export function decodeConfig(data: Buffer) {
  const r = new Reader(data, "Config");
  return {
    admin: r.key(),
    attestor: r.key(),
    feePayer: r.key(),
    mint: r.key(),
    tokenProgram: r.key(),
    treasury: r.key(),
    treasuryOwner: r.key(),
    mintAuthority: r.key(),
    maxSlot: r.n64().toString(),
    maxLink: r.n64().toString(),
    claimWindow: Number(r.i64()),
    bump: r.byte(),
  };
}
