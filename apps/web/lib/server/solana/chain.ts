import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
  type TransactionInstruction,
  Keypair,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getMint,
  getAccount,
  getExtensionTypes,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createMintToCheckedInstruction,
} from "@solana/spl-token";
import { chainConfig, runtimeKeys, keypair, historicalKey } from "../config";
import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import { assert } from "../errors";
import { bytes16, decodeLink, decodeConfig, ix, meta, u64, type ChainLink } from "./codec";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const ata = (
  owner: string | PublicKey,
  mint: string | PublicKey,
  token: string | PublicKey,
) =>
  getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(owner),
    true,
    new PublicKey(token),
  );
export function linkPda(sender: string, id: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("link"), new PublicKey(sender).toBuffer(), bytes16(id)],
    new PublicKey(chainConfig().MUUVE_PROGRAM_ID),
  )[0];
}
export function assertExtensions(types: ExtensionType[], account = false) {
  assert(
    types.every((x) => account && x === ExtensionType.ImmutableOwner),
    "unsupported_token_extension",
    503,
  );
}
export class Chain {
  readonly c = chainConfig();
  readonly program = new PublicKey(this.c.MUUVE_PROGRAM_ID);
  readonly keys = runtimeKeys();
  readonly connections = [
    this.c.SOLANA_RPC_URL,
    ...(this.c.SOLANA_RPC_URL_FALLBACK ? [this.c.SOLANA_RPC_URL_FALLBACK] : []),
  ].map(
    (url) =>
      new Connection(url, {
        commitment: "finalized",
        confirmTransactionInitialTimeout: 15000,
        disableRetryOnRateLimit: true,
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }),
      }),
  );
  async rpc<T>(fn: (c: Connection) => Promise<T>): Promise<T> {
    let last: unknown;
    for (const c of this.connections) {
      try {
        assert((await c.getGenesisHash()) === DEVNET_GENESIS, "devnet_required", 503);
        return await fn(c);
      } catch (error) {
        last = error;
      }
    }
    throw last;
  }
  async readiness() {
    return this.rpc(async (c) => {
      const program = await c.getAccountInfo(this.program, "finalized");
      assert(program?.executable, "program_not_deployed", 503);
      const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], this.program)[0];
      const account = await c.getAccountInfo(configPda, "finalized");
      assert(account && account.owner.equals(this.program), "config_not_initialized", 503);
      const state = decodeConfig(account.data);
      assert(
        state.mint === this.c.USDT_MINT &&
          state.tokenProgram === this.c.TOKEN_PROGRAM_ID &&
          state.treasury === this.c.TREASURY_TOKEN_ACCOUNT &&
          state.claimWindow === 172800,
        "config_mismatch",
        503,
      );
      assert(
        state.feePayer === this.keys.payer.publicKey.toBase58() &&
          state.attestor === this.keys.attestor.publicKey.toBase58() &&
          state.treasuryOwner === this.keys.treasury.publicKey.toBase58(),
        "key_role_mismatch",
        503,
      );
      const mint = await getMint(
        c,
        new PublicKey(state.mint),
        "finalized",
        new PublicKey(state.tokenProgram),
      );
      assert(mint.decimals === 6 && !mint.freezeAuthority, "unsupported_mint", 503);
      assertExtensions(getExtensionTypes(mint.tlvData));
      const treasury = await getAccount(
        c,
        new PublicKey(state.treasury),
        "finalized",
        new PublicKey(state.tokenProgram),
      );
      assert(
        treasury.owner.toBase58() === state.treasuryOwner &&
          treasury.mint.toBase58() === state.mint &&
          !treasury.delegate &&
          !treasury.closeAuthority,
        "treasury_mismatch",
        503,
      );
      assertExtensions(getExtensionTypes(treasury.tlvData), true);
      return state;
    });
  }
  async link(address: string): Promise<ChainLink | undefined> {
    await this.readiness();
    return this.rpc(async (c) => {
      const a = await c.getAccountInfo(new PublicKey(address), "finalized");
      if (!a) return;
      assert(a.owner.equals(this.program), "wrong_program_owner", 503);
      const state = decodeLink(a.data);
      assert(
        state.mint === this.c.USDT_MINT && state.tokenProgram === this.c.TOKEN_PROGRAM_ID,
        "link_mint_mismatch",
        503,
      );
      return state;
    });
  }
  async balance(owner: string) {
    await this.readiness();
    return this.rpc(async (c) => {
      const address = ata(owner, this.c.USDT_MINT, this.c.TOKEN_PROGRAM_ID);
      const a = await c.getAccountInfo(address, "finalized");
      if (!a) return "0";
      const token = await getAccount(
        c,
        address,
        "finalized",
        new PublicKey(this.c.TOKEN_PROGRAM_ID),
      );
      assert(
        token.owner.toBase58() === owner && token.mint.toBase58() === this.c.USDT_MINT,
        "token_account_mismatch",
        503,
      );
      assertExtensions(getExtensionTypes(token.tlvData), true);
      return token.amount.toString();
    });
  }
  async prepare(
    instructions: TransactionInstruction[],
    clientSigners: PublicKey[] = [],
    attest: boolean | Keypair = false,
    extra: Keypair[] = [],
  ) {
    const life = await this.rpc((c) => c.getLatestBlockhash("finalized"));
    const bounded = instructions.some((i) => i.programId.equals(ComputeBudgetProgram.programId))
      ? instructions
      : [ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }), ...instructions];
    const tx = new Transaction({ feePayer: this.keys.payer.publicKey, ...life }).add(
      ...bounded,
      ix(
        new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        "memo",
        [],
        Buffer.from(randomUUID()),
      ),
    );
    // Memo is public operation entropy, never recipient data. Memo program takes raw UTF-8.
    tx.instructions[tx.instructions.length - 1]!.data = Buffer.from(randomUUID());
    tx.partialSign(
      this.keys.payer,
      ...(attest ? [attest === true ? this.keys.attestor : attest] : []),
      ...extra,
    );
    return {
      tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
      message: tx.serializeMessage().toString("base64"),
      blockhash: life.blockhash,
      lastValidBlockHeight: life.lastValidBlockHeight,
      signature: bs58.encode(tx.signatures[0]!.signature!),
      expectedSigners: clientSigners.map((x) => x.toBase58()),
    };
  }
  create(sender: string, id: string, claim: string, amounts: string[]) {
    const owner = new PublicKey(sender),
      mint = new PublicKey(this.c.USDT_MINT),
      token = new PublicKey(this.c.TOKEN_PROGRAM_ID),
      link = linkPda(sender, id);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(amounts.length);
    return this.prepare(
      [
        ix(
          this.program,
          "create_link",
          [
            meta(owner, false, true),
            meta(this.keys.payer.publicKey, true, true),
            meta(PublicKey.findProgramAddressSync([Buffer.from("config")], this.program)[0]),
            meta(link, true),
            meta(mint),
            meta(token),
            meta(ata(owner, mint, token), true),
            meta(ata(link, mint, token), true),
            meta(ASSOCIATED_TOKEN_PROGRAM_ID),
            meta(SystemProgram.programId),
          ],
          bytes16(id),
          new PublicKey(claim).toBuffer(),
          len,
          ...amounts.map((a) => u64(a)),
        ),
      ],
      [owner],
    );
  }
  intent(
    address: string,
    link: ChainLink,
    index: number,
    id: string,
    mode: "keep" | "cashout",
    owner?: string,
  ) {
    const signingAttestor = historicalKey("attestor", link.attestor);
    const destination =
      mode === "cashout" ? new PublicKey(link.treasury) : ata(owner!, link.mint, link.tokenProgram);
    return this.prepare(
      [
        ix(
          this.program,
          "start_claim",
          [
            meta(new PublicKey(address), true),
            meta(new PublicKey(link.claimPubkey), false, true),
            meta(signingAttestor.publicKey, false, true),
          ],
          Buffer.from([index]),
          bytes16(id),
          u64(link.slots[index]!.version),
          destination.toBuffer(),
          Buffer.from([mode === "cashout" ? 1 : 0]),
        ),
      ],
      [new PublicKey(link.claimPubkey)],
      signingAttestor,
    );
  }
  settle(
    address: string,
    link: ChainLink,
    kind: "claim_keep" | "claim_cashout" | "recall" | "expire",
    index?: number,
    destinationOwner?: string,
  ) {
    const claim = kind.startsWith("claim_"),
      owner = new PublicKey(destinationOwner ?? link.sender),
      mint = new PublicKey(link.mint),
      token = new PublicKey(link.tokenProgram);
    const destination =
      kind === "claim_cashout" ? new PublicKey(link.treasury) : ata(owner, mint, token);
    const keys = [
      meta(this.keys.payer.publicKey, true, true),
      meta(new PublicKey(address), true),
      meta(new PublicKey(link.sender), false, kind === "recall"),
      meta(mint),
      meta(token),
      meta(ata(address, mint, token), true),
      meta(ata(link.sender, mint, token), true),
      meta(owner),
      meta(destination, true),
      meta(new PublicKey(link.rentPayer), true),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ];
    const signingAttestor = claim ? historicalKey("attestor", link.attestor) : undefined;
    if (claim) {
      keys.push(
        meta(new PublicKey(link.claimPubkey), false, true),
        meta(signingAttestor!.publicKey, false, true),
      );
    }
    const name =
      kind === "recall"
        ? index === undefined
          ? "recall_all"
          : "recall_slot"
        : kind === "expire"
          ? "expire"
          : kind === "claim_keep"
            ? "claim_to_wallet"
            : "claim_to_treasury";
    const args: Buffer[] = [];
    if (claim) {
      const s = link.slots[index!]!;
      args.push(Buffer.from([index!]), bytes16(s.intentId), u64(s.version));
    } else if (index !== undefined) args.push(Buffer.from([index]));
    return this.prepare(
      [ix(this.program, name, keys, ...args)],
      claim
        ? [new PublicKey(link.claimPubkey)]
        : kind === "recall"
          ? [new PublicKey(link.sender)]
          : [],
      signingAttestor ?? false,
    );
  }
  async tokenTransfer(
    source: "wallet" | "treasury",
    owner: string,
    destinationOwner: string,
    amount: string,
    operationId: string,
  ) {
    const mint = new PublicKey(this.c.USDT_MINT),
      token = new PublicKey(this.c.TOKEN_PROGRAM_ID),
      from = new PublicKey(owner),
      to = new PublicKey(destinationOwner);
    const signingTreasury = source === "treasury" ? historicalKey("treasury", owner) : undefined;
    const receipt = PublicKey.findProgramAddressSync(
      [Buffer.from("operation"), from.toBuffer(), bytes16(operationId)],
      this.program,
    )[0];
    return this.prepare(
      [
        ix(
          this.program,
          "transfer_once",
          [
            meta(this.keys.payer.publicKey, true, true),
            meta(from, false, true),
            meta(PublicKey.findProgramAddressSync([Buffer.from("config")], this.program)[0]),
            meta(receipt, true),
            meta(mint),
            meta(token),
            meta(ata(from, mint, token), true),
            meta(to),
            meta(ata(to, mint, token), true),
            meta(ASSOCIATED_TOKEN_PROGRAM_ID),
            meta(SystemProgram.programId),
          ],
          bytes16(operationId),
          u64(amount),
        ),
      ],
      source === "wallet" ? [from] : [],
      false,
      signingTreasury ? [signingTreasury] : [],
    );
  }
  async fund(owner: string, amount: string, operationId: string) {
    const authority = keypair("TEST_MINT_AUTHORITY_SECRET"),
      state = await this.readiness();
    assert(state.mintAuthority === authority.publicKey.toBase58(), "mint_authority_mismatch", 503);
    assert(
      ![this.keys.payer, this.keys.attestor, this.keys.treasury].some((k) =>
        k.publicKey.equals(authority.publicKey),
      ),
      "role_collision",
      503,
    );
    const mint = new PublicKey(state.mint),
      token = new PublicKey(state.tokenProgram),
      to = new PublicKey(owner);
    const receipt = PublicKey.findProgramAddressSync(
      [Buffer.from("operation"), authority.publicKey.toBuffer(), bytes16(operationId)],
      this.program,
    )[0];
    return this.prepare(
      [
        ix(
          this.program,
          "mint_test_once",
          [
            meta(this.keys.payer.publicKey, true, true),
            meta(authority.publicKey, false, true),
            meta(PublicKey.findProgramAddressSync([Buffer.from("config")], this.program)[0]),
            meta(receipt, true),
            meta(mint, true),
            meta(token),
            meta(to),
            meta(ata(to, mint, token), true),
            meta(ASSOCIATED_TOKEN_PROGRAM_ID),
            meta(SystemProgram.programId),
          ],
          bytes16(operationId),
          u64(amount),
        ),
      ],
      [],
      false,
      [authority],
    );
  }
  async status(signature: string) {
    return this.rpc(
      async (c) =>
        (await c.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0],
    );
  }
  async height() {
    return this.rpc((c) => c.getBlockHeight("finalized"));
  }
  async effectExists(op: Record<string, any>): Promise<boolean> {
    if (op.link_id) {
      const { one } = await import("../db");
      const db = await one("SELECT pda FROM links WHERE id=$1", [op.link_id]);
      const state = db ? await this.link(db.pda) : undefined;
      if (op.kind === "create") return !!state;
      if (state && op.slot_id) {
        const slot = await one("SELECT slot_index FROM link_slots WHERE id=$1", [op.slot_id]);
        const s = slot ? state.slots[slot.slot_index] : undefined;
        if (s && ["intent", "claim_keep", "claim_cashout"].includes(op.kind)) {
          const attempt = await one(
            "SELECT tx_base64 FROM transaction_attempts WHERE operation_id=$1 ORDER BY created_at LIMIT 1",
            [op.id],
          );
          assert(attempt, "missing_prepared_message", 503);
          const instruction = Transaction.from(
            Buffer.from(attempt.tx_base64, "base64"),
          ).instructions.find((i) => i.programId.equals(this.program));
          assert(instruction && instruction.data.length >= 33, "invalid_prepared_instruction", 503);
          const id = instruction.data.subarray(9, 25).toString("hex");
          if (op.kind === "intent")
            return s.intentId === id && BigInt(s.version) > instruction.data.readBigUInt64LE(25);
          return (
            s.status === 2 && s.intentId === id && s.toTreasury === (op.kind === "claim_cashout")
          );
        }
      }
      if (state && op.kind === "recall")
        return op.request.slot_index === undefined
          ? state.slots.some((s) => s.status === 3)
          : state.slots[op.request.slot_index]?.status === 3;
      if (state && op.kind === "expire") return state.slots.some((s) => s.status === 4);
    }
    if (["wallet_payout", "treasury_keep", "treasury_refund", "fund"].includes(op.kind)) {
      const authority =
        op.kind === "fund"
          ? keypair("TEST_MINT_AUTHORITY_SECRET").publicKey
          : op.kind === "wallet_payout"
            ? new PublicKey(
                (await (
                  await import("../db")
                ).one("SELECT sender_wallet FROM principals WHERE id=$1", [op.principal_id]))!
                  .sender_wallet,
              )
            : new PublicKey(
                (await (
                  await import("../db")
                ).one("SELECT treasury_owner FROM principals WHERE id=$1", [op.principal_id]))!
                  .treasury_owner,
              );
      const receipt = PublicKey.findProgramAddressSync(
        [Buffer.from("operation"), authority.toBuffer(), bytes16(op.id)],
        this.program,
      )[0];
      return this.rpc(async (c) => {
        const info = await c.getAccountInfo(receipt, "finalized");
        if (!info) return false;
        assert(info.owner.equals(this.program), "wrong_receipt_owner", 503);
        return true;
      });
    }
    return false;
  }
  async send(tx: Buffer) {
    return this.rpc((c) =>
      c.sendRawTransaction(tx, {
        skipPreflight: false,
        maxRetries: 0,
        preflightCommitment: "finalized",
      }),
    );
  }
}
export type Prepared = Awaited<ReturnType<Chain["prepare"]>>;
