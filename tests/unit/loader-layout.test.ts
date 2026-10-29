import { describe, expect, it } from "vitest";
import { PublicKey, Keypair, Transaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { writeBuffer, deployInstruction } from "../../scripts/paced-deployment";
describe("loader ABI independently cross-checked by the Rust SDK", () => {
  it("matches the shared wire/account fixture", () => {
    const program = new PublicKey(new Uint8Array(32).fill(1)),
      buffer = new PublicKey(new Uint8Array(32).fill(2)),
      authority = new PublicKey(new Uint8Array(32).fill(3));
    const write = writeBuffer(buffer, authority, 42, Buffer.from([7, 8, 9])),
      deploy = deployInstruction(program, buffer, authority, 1234);
    const accounts = (ix: typeof write) =>
      ix.keys
        .map((k) => `${k.pubkey.toBase58()}:${Number(k.isSigner)}:${Number(k.isWritable)}`)
        .join(",");
    expect(
      [
        `write_data=${write.data.toString("hex")}`,
        `write_accounts=${accounts(write)}`,
        `deploy_data=${deploy.data.toString("hex")}`,
        `deploy_accounts=${accounts(deploy)}`,
      ].join("\n") + "\n",
    ).toBe(readFileSync("tests/fixtures/loader-v3.txt", "utf8"));
  });
  it("fits a fully signed 1000-byte chunk within Solana's packet limit", () => {
    const authority = Keypair.generate(),
      tx = new Transaction({
        feePayer: authority.publicKey,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
      }).add(writeBuffer(Keypair.generate().publicKey, authority.publicKey, 0, Buffer.alloc(1000)));
    tx.sign(authority);
    expect(tx.serialize().length).toBeLessThanOrEqual(1232);
  });
});
