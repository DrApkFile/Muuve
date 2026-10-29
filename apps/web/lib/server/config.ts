import { z } from "zod";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "./errors";
const envSchema = z.object({
  APP_ENV: z.enum(["local", "preview", "production"]),
  APP_BASE_URL: z.string().url(),
  SOLANA_CLUSTER: z.literal("devnet"),
  SOLANA_RPC_URL: z.string().url(),
  SOLANA_RPC_URL_FALLBACK: z.string().url().optional(),
  MUUVE_PROGRAM_ID: z.string().min(32),
  USDT_MINT: z.string().min(32),
  TOKEN_PROGRAM_ID: z.string().min(32),
  TREASURY_TOKEN_ACCOUNT: z.string().min(32),
  SESSION_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(32),
  MOCK_WEBHOOK_SECRET: z.string().min(32),
  OTP_PROVIDER: z.enum(["mock", "twilio"]),
  PAYOUT_PROVIDER: z.literal("mock"),
  RATE_PROVIDER: z.literal("mock"),
  WHATSAPP_OTP_ENABLED: z.enum(["true", "false"]).default("false"),
  CLAIM_WINDOW_SECS: z.literal("172800"),
  MOCK_NGN_PER_USD: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/)
    .default("1520"),
});
export type Config = z.infer<typeof envSchema>;
export function config(input: NodeJS.ProcessEnv = process.env): Config {
  const c = envSchema.parse(input);
  assert(c.OTP_PROVIDER !== "mock" || c.APP_ENV === "local", "mock_otp_local_only");
  const token = new PublicKey(c.TOKEN_PROGRAM_ID);
  assert(
    token.equals(TOKEN_PROGRAM_ID) || token.equals(TOKEN_2022_PROGRAM_ID),
    "unsupported_token_program",
  );
  for (const key of [c.MUUVE_PROGRAM_ID, c.USDT_MINT, c.TREASURY_TOKEN_ACCOUNT])
    assert(!new PublicKey(key).equals(PublicKey.default), "invalid_chain_address");
  return c;
}
export function keypair(name: string): Keypair {
  const raw = process.env[name];
  assert(raw, `missing_${name}`, 503);
  let secret: unknown;
  try {
    secret = JSON.parse(raw);
  } catch {
    throw new Error(`invalid_${name}`);
  }
  assert(
    Array.isArray(secret) &&
      secret.length === 64 &&
      secret.every((x) => Number.isInteger(x) && x >= 0 && x <= 255),
    `invalid_${name}`,
    503,
  );
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
export function runtimeKeys() {
  const keys = {
    payer: keypair("FEE_PAYER_SECRET"),
    attestor: keypair("ATTESTOR_SECRET"),
    treasury: keypair("TREASURY_SECRET"),
  };
  assert(
    new Set(Object.values(keys).map((k) => k.publicKey.toBase58())).size === 3,
    "role_collision",
    503,
  );
  return keys;
}
export function historicalKey(role: "attestor" | "treasury", publicKey: string): Keypair {
  const current = keypair(role === "attestor" ? "ATTESTOR_SECRET" : "TREASURY_SECRET");
  if (current.publicKey.toBase58() === publicKey) return current;
  const raw = process.env[role === "attestor" ? "ATTESTOR_KEYRING" : "TREASURY_KEYRING"];
  let entries: unknown = [];
  try {
    entries = raw ? JSON.parse(raw) : [];
  } catch {
    throw new Error("invalid_historical_keyring");
  }
  assert(Array.isArray(entries), "invalid_historical_keyring", 503);
  for (const entry of entries) {
    assert(
      Array.isArray(entry) &&
        entry.length === 64 &&
        entry.every((x) => Number.isInteger(x) && x >= 0 && x <= 255),
      "invalid_historical_keyring",
      503,
    );
    const candidate = Keypair.fromSecretKey(Uint8Array.from(entry));
    if (candidate.publicKey.toBase58() === publicKey) return candidate;
  }
  throw new Error(`historical_${role}_key_required`);
}
