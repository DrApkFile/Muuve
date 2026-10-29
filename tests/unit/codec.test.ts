import { describe, it, expect, vi, afterEach } from "vitest";
import { BorshAccountsCoder, BorshInstructionCoder, BN, type Idl } from "@coral-xyz/anchor";
import { IdlCoder } from "@coral-xyz/anchor/dist/cjs/coder/borsh/idl";
import { PublicKey, Transaction } from "@solana/web3.js";
import idl from "../../packages/shared/idl/muuve_escrow.json";
import { Chain } from "../../apps/web/lib/server/solana/chain";
import { decodeLink } from "../../apps/web/lib/server/solana/codec";
import { setupEnv, sender, payer, attestor, treasury, mint, program } from "../helpers";
setupEnv();
afterEach(() => vi.restoreAllMocks());
describe("generated Anchor IDL compatibility", () => {
  it("matches server create instruction bytes to the Anchor-generated ABI", async () => {
    const chain = new Chain(),
      local = "00112233445566778899aabbccddeeff";
    vi.spyOn(chain, "rpc").mockImplementation(async (fn) =>
      fn({
        getLatestBlockhash: async () => ({
          blockhash: program.toBase58(),
          lastValidBlockHeight: 1000,
        }),
      } as never),
    );
    const p = await chain.create(
      sender.publicKey.toBase58(),
      local,
      attestor.publicKey.toBase58(),
      ["1", "2"],
    );
    const tx = Transaction.from(Buffer.from(p.tx, "base64"));
    const encoded = new BorshInstructionCoder(idl as Idl).encode("create_link", {
      link_id: [...Buffer.from(local, "hex")],
      claim_pubkey: attestor.publicKey,
      amounts: [new BN(1), new BN(2)],
    });
    expect(
      tx.instructions.find((i) => i.programId.equals(chain.program))!.data.equals(encoded),
    ).toBe(true);
  });
  it("decodes the exact account layout emitted by Anchor", async () => {
    const coder = new BorshAccountsCoder(idl as Idl);
    const key = PublicKey.default;
    const slot = {
      amount: new BN(10),
      status: { Funded: {} },
      intent_id: Array(16).fill(0),
      version: new BN(0),
      priority_until: new BN(0),
      destination: key,
      to_treasury: false,
    };
    const value = {
      link_id: Array(16).fill(7),
      sender: sender.publicKey,
      rent_payer: payer.publicKey,
      claim_pubkey: attestor.publicKey,
      mint,
      token_program: key,
      attestor: attestor.publicKey,
      treasury: treasury.publicKey,
      treasury_owner: treasury.publicKey,
      created_at: new BN(100),
      expires_at: new BN(172900),
      total: new BN(10),
      slot_count: 1,
      open_slots: 1,
      slots: Array.from({ length: 10 }, () => ({ ...slot })),
      bump: 255,
    };
    // Anchor 0.31's convenience account encoder allocates only 1000 bytes.
    // The actual fixed Link is larger; use its generated layout with enough space.
    const spec = idl as Idl,
      definition = spec.types!.find((t) => t.name === "muuve_escrow::Link")!;
    const layout = IdlCoder.typeDefLayout({ typeDef: definition, types: spec.types! });
    const body = Buffer.alloc(4096),
      length = layout.encode(value, body);
    const encoded = Buffer.concat([
      Buffer.from(spec.accounts!.find((a) => a.name === definition.name)!.discriminator),
      body.subarray(0, length),
    ]);
    const decoded = decodeLink(encoded);
    expect(coder.decode("muuve_escrow::Link", encoded).total.toString()).toBe("10");
    expect(decoded.sender).toBe(sender.publicKey.toBase58());
    expect(decoded.expiresAt - decoded.createdAt).toBe(172800);
    expect(decoded.slots[0]?.amount).toBe("10");
    expect(decoded.slots[0]?.status).toBe(1);
  });
});
