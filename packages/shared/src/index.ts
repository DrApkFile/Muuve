import { z } from "zod";
import { isValidPhoneNumber } from "libphonenumber-js";

export const LIMITS = {
  maxSlots: 10,
  maxSlot: 500_000_000n,
  maxLink: 1_000_000_000n,
  maxOutstanding: 1_000_000_000n,
  dailyFunding: 200_000_000n,
  claimWindow: 172800,
  priorityWindow: 120,
} as const;
export const U64_MAX = 18_446_744_073_709_551_615n;
export const baseUnits = z
  .string()
  .regex(/^[1-9]\d*$/)
  .refine((x) => /^[1-9]\d*$/.test(x) && BigInt(x) <= U64_MAX, "Amount exceeds u64");
export const phone = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/)
  .refine((x) => isValidPhoneNumber(x), "Invalid phone");
export const uuid = z.string().uuid();
export const linkIdHex = z.string().regex(/^[0-9a-f]{32}$/);
export const publicKey = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const slotStatuses = [
  "pending",
  "funded",
  "cashing_out",
  "cashed_out",
  "kept",
  "recalled",
  "returned",
] as const;
export type SlotStatus = (typeof slotStatuses)[number];
export const payoutStatuses = [
  "quoted",
  "transferring",
  "processing",
  "paid",
  "failed",
  "resolved",
  "quarantined",
] as const;
export type PayoutStatus = (typeof payoutStatuses)[number];
export const schemas = {
  otpSend: z
    .object({
      phone_e164: phone,
      channel: z.enum(["sms", "whatsapp"]),
      purpose: z.enum(["account", "claim"]),
      link_id: uuid.optional(),
    })
    .strict(),
  otpVerify: z.object({ challenge_id: uuid, code: z.string().regex(/^\d{6}$/) }).strict(),
  signup: z
    .object({
      display_name: z.string().trim().min(1).max(60),
      origin: z.enum(["muuve", "cleva_preview"]).default("muuve"),
    })
    .strict(),
  wallet: z.object({ wallet_address: publicKey }).strict(),
  walletChallenge: z.object({ wallet_address: publicKey }).strict(),
  walletLogin: z
    .object({ challenge_id: uuid, signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/) })
    .strict(),
  create: z
    .object({
      link_id_hex: linkIdHex,
      claim_pubkey: publicKey,
      note: z.string().max(120).optional(),
      recipients: z
        .array(
          z
            .object({
              phone_e164: phone,
              amount_base_units: baseUnits,
              label: z.string().max(40).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(LIMITS.maxSlots),
    })
    .strict(),
  submit: z
    .object({
      operation_id: uuid,
      tx: z.string().min(1).max(1800),
      idempotency_key: z.string().min(8).max(128),
    })
    .strict(),
  recall: z.object({ slot_index: z.number().int().min(0).max(9).optional() }).strict(),
  intent: z.object({ path: z.enum(["keep", "cashout"]) }).strict(),
  quote: z.object({ retry_of: uuid.optional(), amount_base_units: baseUnits.optional() }).strict(),
  cashout: z
    .object({
      quote_id: uuid,
      bank_code: z.string().regex(/^\d{3,10}$/),
      account_number: z.string().regex(/^\d{10}$/),
      idempotency_key: z.string().min(8).max(128).optional(),
    })
    .strict(),
  bank: z
    .object({
      bank_code: z.string().regex(/^\d{3,10}$/),
      account_number: z.string().regex(/^\d{10}$/),
    })
    .strict(),
  fund: z.object({ amount_base_units: baseUnits }).strict(),
};
export function totalAllocations(amounts: string[]): bigint {
  if (!amounts.length || amounts.length > LIMITS.maxSlots) throw new Error("invalid_slot_count");
  let total = 0n;
  for (const a of amounts) {
    const value = BigInt(baseUnits.parse(a));
    if (value > LIMITS.maxSlot) throw new Error("invalid_amount");
    total += value;
  }
  if (total > LIMITS.maxLink) throw new Error("link_too_large");
  return total;
}
// Quote rates are four-place decimal strings; flooring is explicit and deterministic.
export function ngnKobo(amount: string, rate: string): string {
  if (!/^\d+(\.\d{1,4})?$/.test(rate)) throw new Error("invalid_rate");
  const [whole, fractional = ""] = rate.split(".");
  const scaled = BigInt(whole) * 10000n + BigInt(fractional.padEnd(4, "0"));
  return ((BigInt(baseUnits.parse(amount)) * scaled * 100n) / (1_000_000n * 10000n)).toString();
}
