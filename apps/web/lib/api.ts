// Same-origin client for /api/*. Cookies are httpOnly; the browser sends them, we never read them.
export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    public requestId?: string,
  ) {
    super(code);
  }
}

type Options = { headers?: Record<string, string>; signal?: AbortSignal };

export async function api<T>(path: string, body?: unknown, options: Options = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      cache: "no-store",
      signal: options.signal,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("network_error", 0);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      typeof json.error === "string" ? json.error : "unknown_error",
      res.status,
      typeof json.request_id === "string" ? json.request_id : undefined,
    );
  }
  return json as T;
}

export const newIdempotencyKey = () => crypto.randomUUID();

// ---------- Response shapes (from apps/web/lib/server/*) ----------

export type User = {
  id: string;
  display_name: string;
  auth_origin: "muuve" | "cleva_preview" | "wallet";
  wallet_address: string | null;
};

export type Balance = {
  amount_base_units: string;
  estimated_ngn_kobo: string;
  rate_ngn_per_usd: string;
  mock_rate: true;
};

export type LinkStatus = "pending" | "open" | "settled" | "cancelled";

export type LinkSummary = {
  id: string;
  kind: "single" | "batch";
  total_base_units: string;
  status: LinkStatus;
  expires_at: string | null;
  created_at: string;
  claimed_slots: number;
  slot_count: number;
};

export type Slot = {
  slot_index: number;
  recipient_phone_e164: string;
  label: string | null;
  amount_base_units: string;
  status: import("@muuve/shared").SlotStatus;
};

export type TimelineEvent = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type LinkDetail = {
  id: string;
  link_id_hex: string;
  kind: "single" | "batch";
  note: string | null;
  total_base_units: string;
  slot_count: number;
  status: LinkStatus;
  expires_at: string | null;
  created_at: string;
  slots: Slot[];
  timeline: TimelineEvent[];
  reminder_due: boolean;
};

export type PreparedOperation = {
  operation_id: string;
  tx: string;
  signature: string;
  blockhash: string;
  last_valid_block_height: number;
  state?: string;
};

export type OperationState =
  | "prepared"
  | "processing"
  | "submitted"
  | "confirmed"
  | "unknown"
  | "held"
  | "awaiting_rpc"
  | "pending"
  | "finalized"
  | "failed";

export type PublicPreview = {
  kind: "single" | "batch";
  sender_first_name: string;
  note: string | null;
  status: LinkStatus;
  expires_at: string | null;
  amount_base_units?: string;
};

export type PayoutSummary = {
  id: string;
  status: import("@muuve/shared").PayoutStatus;
  resolution: string | null;
  amount_ngn_kobo?: string;
};

export type Share = {
  slot_index: number;
  amount_base_units: string;
  status: import("@muuve/shared").SlotStatus;
  payout: PayoutSummary | null;
  priority_until: string | null;
};

export type Quote = {
  quote_id: string;
  rate_ngn_per_usd: string;
  amount_ngn_kobo: string;
  expires_at: string;
  mock?: true;
};

export type Payout = {
  id: string;
  status: import("@muuve/shared").PayoutStatus;
  resolution: string | null;
  amount_ngn_kobo: string;
  rate_ngn_per_usd: string;
  provider_ref: string | null;
  account_name: string | null;
  account_last4: string;
  mock: true;
};

export type Bank = { code: string; name: string };
