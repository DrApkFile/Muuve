import { randomUUID } from "node:crypto";
import { Keypair, PublicKey, Transaction, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { database, transaction, one } from "../apps/web/lib/server/db";
import { issue, type Session } from "../apps/web/lib/server/auth";
import { hash } from "../apps/web/lib/server/solana/codec";
export const payer = Keypair.generate(),
  sender = Keypair.generate(),
  attestor = Keypair.generate(),
  treasury = Keypair.generate(),
  mintAuthority = Keypair.generate(),
  mint = Keypair.generate().publicKey,
  program = Keypair.generate().publicKey;
export function setupEnv() {
  Object.assign(process.env, {
    APP_ENV: "local",
    APP_BASE_URL: "https://muuve.test",
    SOLANA_CLUSTER: "devnet",
    SOLANA_RPC_URL: "https://api.devnet.solana.com",
    MUUVE_PROGRAM_ID: program.toBase58(),
    USDT_MINT: mint.toBase58(),
    TOKEN_PROGRAM_ID: TOKEN_PROGRAM_ID.toBase58(),
    TREASURY_TOKEN_ACCOUNT: getAssociatedTokenAddressSync(mint, treasury.publicKey).toBase58(),
    SESSION_SECRET: "local-test-session-key-not-for-deployment-123456789",
    CRON_SECRET: "local-test-cron-key-not-for-deployment-123456789",
    MOCK_WEBHOOK_SECRET: "local-test-webhook-key-not-for-deployment-123456789",
    OTP_PROVIDER: "mock",
    PAYOUT_PROVIDER: "mock",
    RATE_PROVIDER: "mock",
    WHATSAPP_OTP_ENABLED: "false",
    CLAIM_WINDOW_SECS: "172800",
    MOCK_NGN_PER_USD: "1520",
    TRUSTED_PROXY: "true",
    FEE_PAYER_SECRET: JSON.stringify([...payer.secretKey]),
    ATTESTOR_SECRET: JSON.stringify([...attestor.secretKey]),
    TREASURY_SECRET: JSON.stringify([...treasury.secretKey]),
    TEST_MINT_AUTHORITY_SECRET: JSON.stringify([...mintAuthority.secretKey]),
  });
}
export async function reset() {
  await database().query(
    "TRUNCATE users,otp_challenges,events,jobs,webhook_inbox,mock_provider_transfers RESTART IDENTITY CASCADE",
  );
}
export async function seed(
  options: {
    amount?: string;
    phone?: string;
    senderPhone?: string;
    status?: string;
    localId?: string;
    wallet?: string;
    expired?: boolean;
  } = {},
) {
  return transaction(async (c) => {
    const user = await one(
      "INSERT INTO users(phone_e164,display_name,auth_origin,wallet_address) VALUES($1,'Test Sender','muuve',$2) RETURNING *",
      [options.senderPhone ?? "+2348030000001", options.wallet ?? sender.publicKey.toBase58()],
      c,
    );
    const id = randomUUID(),
      localId = options.localId ?? "00112233445566778899aabbccddeeff";
    const pda = PublicKey.findProgramAddressSync(
      [
        Buffer.from("link"),
        new PublicKey(user!.wallet_address).toBuffer(),
        Buffer.from(localId, "hex"),
      ],
      program,
    )[0].toBase58();
    const link = await one(
      `INSERT INTO links(id,sender_user_id,sender_wallet,link_id_hex,pda,claim_pubkey,kind,total_base_units,slot_count,status,expires_at,capacity_state)
  VALUES($1,$2,$3,$4,$5,$6,'single',$7,1,$8,$9,'open') RETURNING *`,
      [
        id,
        user!.id,
        user!.wallet_address,
        localId,
        pda,
        Keypair.generate().publicKey.toBase58(),
        options.amount ?? "1000000",
        options.status ?? "open",
        new Date(Date.now() + (options.expired ? -1000 : 172800000)),
      ],
      c,
    );
    const slot = await one(
      "INSERT INTO link_slots(link_id,slot_index,recipient_phone_e164,amount_base_units,status) VALUES($1,0,$2,$3,'funded') RETURNING *",
      [id, options.phone ?? "+2348030000002", options.amount ?? "1000000"],
      c,
    );
    return { user: user!, link: link!, slot: slot! };
  });
}
export async function makeSession(
  purpose: Session["purpose"],
  phone: string,
  user: string | null,
  link: string | null,
) {
  return transaction(async (c) => {
    const cookie = await issue(c, purpose, phone, user, link);
    const sid = await one<Session>(
      "SELECT * FROM sessions WHERE phone_e164=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1",
      [phone, purpose],
      c,
    );
    return { session: sid!, cookie: cookie.split(";")[0]! };
  });
}
export function prepared(client = sender) {
  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1000,
  }).add(
    SystemProgram.transfer({
      fromPubkey: client.publicKey,
      toPubkey: treasury.publicKey,
      lamports: 1,
    }),
  );
  tx.partialSign(payer);
  return {
    tx: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    message: tx.serializeMessage().toString("base64"),
    blockhash: tx.recentBlockhash!,
    lastValidBlockHeight: 1000,
    signature: bs58.encode(tx.signatures[0]!.signature!),
    expectedSigners: [client.publicKey.toBase58()],
  };
}
export function signPrepared(p: ReturnType<typeof prepared>, client = sender) {
  const tx = Transaction.from(Buffer.from(p.tx, "base64"));
  tx.partialSign(client);
  return tx.serialize().toString("base64");
}
export const attemptFor = (p: ReturnType<typeof prepared>) => ({
  message_hash: hash(Buffer.from(p.message, "base64")).toString("hex"),
  message_base64: p.message,
  signature: p.signature,
});
