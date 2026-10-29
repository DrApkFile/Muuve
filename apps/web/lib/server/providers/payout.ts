import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { transaction, one } from "../db";
import { assert } from "../errors";
import { canonical } from "../operations";
import { hash } from "../solana/codec";
export type PayoutRequest = {
  payoutId: string;
  providerKey: string;
  amountKobo: string;
  bankCode: string;
  accountNumber: string;
};
export interface PayoutProvider {
  readonly safeIdempotency: boolean;
  createPayout(p: PayoutRequest): Promise<{ providerRef: string }>;
  status(
    key: string,
  ): Promise<{ providerRef: string; status: "processing" | "paid" | "failed" } | undefined>;
}
export class MockPayoutProvider implements PayoutProvider {
  readonly safeIdempotency = true;
  constructor() {
    assert(process.env.SOLANA_CLUSTER === "devnet", "devnet_required", 503);
  }
  async createPayout(p: PayoutRequest) {
    return transaction(async (c) => {
      const fingerprint = hash(canonical(p)).toString("hex");
      await c.query(
        `INSERT INTO mock_provider_transfers(provider_key,provider_ref,fingerprint,payout_id,outcome,ready_at)
   VALUES($1,$2,$3,$4,$5,now()+interval '4 seconds') ON CONFLICT(provider_key) DO NOTHING`,
        [
          p.providerKey,
          `mock-${p.providerKey}`,
          fingerprint,
          p.payoutId,
          p.accountNumber.endsWith("0000") ? "failed" : "paid",
        ],
      );
      const row = await one(
        "SELECT * FROM mock_provider_transfers WHERE provider_key=$1",
        [p.providerKey],
        c,
      );
      assert(row?.fingerprint === fingerprint, "provider_idempotency_conflict", 409);
      return { providerRef: row.provider_ref };
    });
  }
  async status(key: string) {
    const row = await one("SELECT * FROM mock_provider_transfers WHERE provider_key=$1", [key]);
    if (!row) return;
    return {
      providerRef: row.provider_ref,
      status:
        row.ready_at.getTime() <= Date.now()
          ? (row.outcome as "paid" | "failed")
          : ("processing" as const),
    };
  }
}
export function payoutProvider(): PayoutProvider {
  assert(process.env.PAYOUT_PROVIDER === "mock", "payout_provider_not_implemented", 503);
  return new MockPayoutProvider();
}
export const webhookSchema = z
  .object({
    event_id: z.string().min(1).max(128),
    payout_id: z.string().uuid(),
    provider_ref: z.string().min(1).max(128),
    status: z.enum(["paid", "failed"]),
  })
  .strict();
function webhookSecret() {
  const s = process.env.MOCK_WEBHOOK_SECRET;
  assert(s && s.length >= 32, "webhook_not_configured", 503);
  return s;
}
export function signWebhook(raw: string, timestamp = Math.floor(Date.now() / 1000).toString()) {
  return {
    timestamp,
    signature: createHmac("sha256", webhookSecret()).update(`${timestamp}.${raw}`).digest("hex"),
  };
}
export function verifyWebhook(raw: string, timestamp: string | null, signature: string | null) {
  assert(
    timestamp &&
      /^\d{10}$/.test(timestamp) &&
      Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300,
    "invalid_webhook",
    401,
  );
  assert(signature && /^[0-9a-f]{64}$/.test(signature), "invalid_webhook", 401);
  const expected = signWebhook(raw, timestamp).signature;
  assert(
    timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex")),
    "invalid_webhook",
    401,
  );
  return webhookSchema.parse(JSON.parse(raw));
}
export const banks = [
  { code: "100004", name: "OPay" },
  { code: "100033", name: "PalmPay" },
  { code: "50515", name: "Moniepoint" },
  { code: "090267", name: "Kuda" },
];
export function resolveBank(code: string, account: string) {
  assert(banks.some((b) => b.code === code) && /^\d{10}$/.test(account), "account_not_found", 404);
  return { account_name: "Demo Account — mock resolution", mock: true };
}
export function rate() {
  const text = process.env.MOCK_NGN_PER_USD ?? "1520";
  assert(/^\d+(\.\d{1,4})?$/.test(text), "invalid_mock_rate", 503);
  const [w, f = ""] = text.split(".");
  const scaled = ((BigInt(w!) * 10000n + BigInt(f.padEnd(4, "0"))) * 99n) / 100n;
  assert(scaled > 0, "invalid_mock_rate", 503);
  return `${scaled / 10000n}.${(scaled % 10000n).toString().padStart(4, "0")}`;
}
