// Paystack Transfers for naira cash-outs: bank list, account-name lookup and transfers.
// Test keys only while the chain is devnet: test transfers move no money. The payout key we
// already store per payout is the transfer reference, so a retried create can't pay twice.
import { assert, AppError } from "../errors";
import type { PayoutProvider, PayoutRequest } from "./payout";

const BASE = "https://api.paystack.co";

function secretKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  assert(key, "paystack_not_configured", 503);
  // Live keys would pay out real naira against devnet test dollars.
  assert(
    key.startsWith("sk_test_") && process.env.SOLANA_CLUSTER === "devnet",
    "paystack_live_key_refused",
    503,
  );
  return key;
}

type Envelope<T> = { status: boolean; message?: string; data?: T };

// Never surfaces Paystack's message: it can echo account numbers or names.
async function paystack<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${secretKey()}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const json = (await res.json().catch(() => ({}))) as Envelope<T>;
  return { ok: res.ok && json.status === true, status: res.status, data: json.data };
}

export type Bank = { code: string; name: string };
let bankCache: { at: number; banks: Bank[] } | undefined;

export async function paystackBanks(): Promise<Bank[]> {
  if (bankCache && Date.now() - bankCache.at < 3_600_000) return bankCache.banks;
  const res = await paystack<Array<{ code: string; name: string; active?: boolean }>>(
    "/bank?country=nigeria&currency=NGN&perPage=200",
  );
  assert(res.ok && Array.isArray(res.data), "bank_directory_unavailable", 503);
  const banks = res.data
    .filter((b) => b.active !== false && /^\d{3,9}$/.test(b.code))
    .map((b) => ({ code: b.code, name: b.name }));
  bankCache = { at: Date.now(), banks };
  return banks;
}

export async function paystackResolve(code: string, account: string) {
  assert(/^\d{10}$/.test(account), "account_not_found", 404);
  assert(
    (await paystackBanks()).some((b) => b.code === code),
    "account_not_found",
    404,
  );
  const res = await paystack<{ account_name: string }>(
    `/bank/resolve?account_number=${account}&bank_code=${encodeURIComponent(code)}`,
  );
  if (res.status >= 500 || res.status === 429)
    throw new AppError("bank_directory_unavailable", 503);
  assert(res.ok && typeof res.data?.account_name === "string", "account_not_found", 404);
  return { accountName: res.data.account_name };
}

const PAID = new Set(["success"]);
const FAILED = new Set(["failed", "reversed", "abandoned", "rejected"]);

export class PaystackPayoutProvider implements PayoutProvider {
  // Paystack refuses a second transfer with the same reference.
  readonly safeIdempotency = true;
  constructor() {
    secretKey();
  }
  async createPayout(p: PayoutRequest) {
    const recipient = await paystack<{ recipient_code: string }>("/transferrecipient", {
      method: "POST",
      body: {
        type: "nuban",
        name: p.accountName ?? "Muuve recipient",
        account_number: p.accountNumber,
        bank_code: p.bankCode,
        currency: "NGN",
      },
    });
    if (!recipient.ok || !recipient.data?.recipient_code) throw new Error("recipient_failed");
    const transfer = await paystack<{ transfer_code: string }>("/transfer", {
      method: "POST",
      body: {
        source: "balance",
        amount: Number(p.amountKobo),
        recipient: recipient.data.recipient_code,
        reference: p.providerKey,
        reason: "Muuve cash-out",
      },
    });
    if (transfer.ok && transfer.data?.transfer_code)
      return { providerRef: transfer.data.transfer_code };
    // A duplicate reference means an earlier attempt was accepted: use that transfer.
    const existing = await this.status(p.providerKey);
    if (existing) return { providerRef: existing.providerRef };
    throw new Error("transfer_failed");
  }
  async status(key: string) {
    const res = await paystack<{ transfer_code: string; status: string }>(
      `/transfer/verify/${encodeURIComponent(key)}`,
    );
    if (res.status === 404 || res.status === 400) return undefined;
    if (!res.ok || !res.data?.transfer_code) throw new Error("status_unavailable");
    const status = PAID.has(res.data.status)
      ? ("paid" as const)
      : FAILED.has(res.data.status)
        ? ("failed" as const)
        : ("processing" as const);
    return { providerRef: res.data.transfer_code, status };
  }
}
