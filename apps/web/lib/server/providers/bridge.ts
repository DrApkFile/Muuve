// Bridge (bridge.xyz): US dollar virtual accounts. A customer passes Bridge's hosted identity
// check, then gets US bank details; dollars paid in are converted and delivered as USDT on
// Solana to their Muuve address. Sandbox only while the chain is devnet.
import { createHash, createVerify, randomUUID } from "node:crypto";
import { assert, AppError } from "../errors";

export type BridgeEnv = "sandbox" | "production";

export function bridgeEnv(): BridgeEnv {
  const env = process.env.BRIDGE_ENV;
  assert(env === "sandbox" || env === "production", "usd_accounts_not_configured", 503);
  // Production would deliver real dollars to devnet-era accounts; never mix them.
  assert(
    (env === "sandbox") === (process.env.SOLANA_CLUSTER === "devnet"),
    "bridge_env_mismatch",
    503,
  );
  return env;
}

function apiKey() {
  const key = process.env.BRIDGE_API_KEY;
  assert(key, "usd_accounts_not_configured", 503);
  assert(bridgeEnv() === "production" || key.startsWith("sk-test"), "bridge_live_key_refused", 503);
  return key;
}

const base = () =>
  bridgeEnv() === "sandbox" ? "https://api.sandbox.bridge.xyz/v0" : "https://api.bridge.xyz/v0";

// Never surfaces Bridge's response text: it can echo names, emails or account numbers.
async function bridge<T>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: {
      "api-key": apiKey(),
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "POST" ? { "idempotency-key": init.idempotencyKey ?? randomUUID() } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!res.ok) {
    const code =
      res.status === 404
        ? "usd_account_not_found"
        : res.status >= 500 || res.status === 429
          ? "usd_provider_unavailable"
          : "usd_provider_rejected";
    throw new AppError(
      code,
      res.status === 404 ? 404 : res.status >= 500 || res.status === 429 ? 503 : 409,
    );
  }
  return (await res.json()) as T;
}

export type KycLink = {
  id: string;
  customer_id: string | null;
  kyc_link: string;
  tos_link: string;
  kyc_status: string;
  tos_status: string;
};
export type DepositInstructions = {
  bank_name?: string;
  bank_address?: string;
  bank_routing_number?: string;
  bank_account_number?: string;
  bank_beneficiary_name?: string;
  bank_beneficiary_address?: string;
  payment_rails?: string[];
};
export type VirtualAccount = {
  id: string;
  status: string;
  customer_id: string;
  source_deposit_instructions: DepositInstructions;
};
export type ActivityEvent = {
  id: string;
  type: string;
  amount?: string;
  currency?: string;
  deposit_id?: string;
  customer_id?: string;
  virtual_account_id?: string;
};

export const bridgeApi = {
  createKycLink(input: { fullName: string; email: string; key: string }) {
    return bridge<KycLink>("/kyc_links", {
      method: "POST",
      idempotencyKey: input.key,
      body: { full_name: input.fullName, email: input.email, type: "individual" },
    });
  },
  kycLink(id: string) {
    return bridge<KycLink>(`/kyc_links/${encodeURIComponent(id)}`);
  },
  createVirtualAccount(customerId: string, address: string, key: string) {
    return bridge<VirtualAccount>(`/customers/${encodeURIComponent(customerId)}/virtual_accounts`, {
      method: "POST",
      idempotencyKey: key,
      body: {
        source: { currency: "usd" },
        destination: { currency: "usdt", payment_rail: "solana", address },
      },
    });
  },
  async history(customerId: string, accountId: string) {
    const res = await bridge<{ data?: ActivityEvent[] }>(
      `/customers/${encodeURIComponent(customerId)}/virtual_accounts/${encodeURIComponent(accountId)}/history`,
    );
    return res.data ?? [];
  },
  // Sandbox only: approve an identity check, or create a representative incoming deposit.
  simulateKycApproval(customerId: string) {
    assert(bridgeEnv() === "sandbox", "sandbox_only", 403);
    return bridge(`/customers/${encodeURIComponent(customerId)}/simulate_kyc_approval`, {
      method: "POST",
    });
  },
  simulateDeposit(customerId: string, accountId: string, amountUsd: string) {
    assert(bridgeEnv() === "sandbox", "sandbox_only", 403);
    return bridge(
      `/customers/${encodeURIComponent(customerId)}/virtual_accounts/${encodeURIComponent(accountId)}/simulate_deposit`,
      { method: "POST", body: { currency: "usd", amount: amountUsd } },
    );
  },
};

/**
 * Bridge signs SHA256("<t>.<raw body>") with the endpoint's RSA key and sends
 * X-Webhook-Signature: t=<ms>,v0=<base64>. Rejects stale events (10 minutes).
 */
export function verifyBridgeSignature(raw: string, header: string | null, now = Date.now()) {
  const pem = process.env.BRIDGE_WEBHOOK_PUBLIC_KEY?.replace(/\\n/g, "\n");
  assert(pem, "webhook_not_configured", 503);
  const parts = Object.fromEntries(
    (header ?? "").split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = parts.t,
    sig = parts.v0;
  assert(t && /^\d{13}$/.test(t) && sig, "invalid_webhook", 401);
  assert(Math.abs(now - Number(t)) <= 600_000, "invalid_webhook", 401);
  const digest = createHash("sha256").update(`${t}.${raw}`).digest();
  let ok = false;
  try {
    ok = createVerify("SHA256").update(digest).end().verify(pem, sig, "base64");
  } catch {
    ok = false;
  }
  assert(ok, "invalid_webhook", 401);
}
