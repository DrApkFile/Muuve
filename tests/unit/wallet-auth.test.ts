import { describe, expect, it } from "vitest";
import { createPrivateKey, sign } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { validWalletSignature } from "../../apps/web/lib/server/wallet-auth";

describe("wallet challenge Ed25519 verification", () => {
  it("checks the exact UTF-8 bytes and signer", () => {
    const wallet = Keypair.generate();
    const key = createPrivateKey({
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        wallet.secretKey.slice(0, 32),
      ]),
      format: "der",
      type: "pkcs8",
    });
    const message = "Muuve sign in\n₦ — no transfer\nnonce: unique";
    const signature = bs58.encode(sign(null, Buffer.from(message, "utf8"), key));
    expect(validWalletSignature(wallet.publicKey.toBase58(), message, signature)).toBe(true);
    expect(validWalletSignature(wallet.publicKey.toBase58(), message + " ", signature)).toBe(false);
    expect(validWalletSignature(Keypair.generate().publicKey.toBase58(), message, signature)).toBe(
      false,
    );
  });
  it.each(["invalid", "", "1".repeat(63), "1".repeat(65)])(
    "rejects malformed signature %s",
    (signature) => {
      expect(validWalletSignature(Keypair.generate().publicKey.toBase58(), "test", signature)).toBe(
        false,
      );
    },
  );
  it("rejects a trivial low-order identity forgery", () => {
    const point = Buffer.alloc(32),
      signature = Buffer.alloc(64);
    point[0] = 1;
    signature[0] = 1;
    expect(validWalletSignature(bs58.encode(point), "test", bs58.encode(signature))).toBe(false);
  });
});
