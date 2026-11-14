// US dollar accounts: start Bridge's identity check, issue US bank details once approved,
// and record each deposit once. On devnet (Bridge sandbox) a deposit is credited by minting
// the same amount of test dollars; on mainnet Bridge delivers the USDT itself.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Session } from "./auth";
import { audit, database, one, transaction } from "./db";
import { assert } from "./errors";
import { userFor } from "./links";
import { insertOperation } from "./operations";
import { Chain } from "./solana/chain";
import { safeLog } from "./log";
import {
  bridgeApi,
  bridgeEnv,
  verifyBridgeSignature,
  type ActivityEvent,
} from "./providers/bridge";

export const usdStartSchema = z
  .object({
    full_name: z.string().trim().min(2).max(100),
    email: z.string().trim().email().max(200),
  })
  .strict();
export const usdSimulateSchema = z
  .object({ amount_usd: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/) })
  .strict();

// Sandbox credits mint test dollars; keep a single deposit within a sensible demo size.
const MAX_SANDBOX_CREDIT = 1_000_000_000n; // $1,000
const CREDIT_EVENTS = { sandbox: ["funds_received", "payment_submitted", "payment_processed"] };

type Row = {
  user_id: string;
  customer_id: string | null;
  kyc_link_id: string;
  kyc_url: string;
  tos_url: string;
  kyc_status: string;
  tos_status: string;
  virtual_account_id: string | null;
  deposit_instructions: Record<string, unknown> | null;
  synced_at: Date | null;
  wallet_address: string;
};

async function eligibleUser(actor: Session) {
  const user = await userFor(actor);
  assert(user.wallet_address, "wallet_required", 409);
  assert(user.phone_e164, "phone_required", 403);
  return user;
}
const accountRow = (userId: string) =>
  one<Row>(
    "SELECT a.*,u.wallet_address FROM usd_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1",
    [userId],
  );

/** Bridge amounts are decimal dollar strings; base units have 6 decimals. */
export function usdToBaseUnits(amount: string | undefined) {
  if (!amount || !/^\d{1,12}(\.\d{1,6})?$/.test(amount)) return null;
  const [w, f = ""] = amount.split(".");
  const units = BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0"));
  return units > 0n ? units : null;
}

export async function startUsdAccount(actor: Session, input: z.infer<typeof usdStartSchema>) {
  const user = await eligibleUser(actor);
  if (!(await accountRow(user.id))) {
    // The name and email go to Bridge only; Muuve keeps the link and its status.
    const link = await bridgeApi.createKycLink({
      fullName: input.full_name,
      email: input.email,
      key: `muuve-kyc-${user.id}`,
    });
    await transaction(async (c) => {
      await c.query(
        `INSERT INTO usd_accounts(user_id,provider,customer_id,kyc_link_id,kyc_url,tos_url,kyc_status,tos_status)
         VALUES($1,'bridge',$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO NOTHING`,
        [
          user.id,
          link.customer_id ?? null,
          link.id,
          link.kyc_link,
          link.tos_link,
          link.kyc_status,
          link.tos_status,
        ],
      );
      await audit(c, "user", user.id, "usd_account.kyc_started");
    });
  }
  return usdAccount(actor, true);
}

/** Pulls identity-check status, issues the account once approved, and records deposits. */
async function sync(row: Row, force: boolean) {
  if (!force && row.synced_at && Date.now() - row.synced_at.getTime() < 4000) return;
  if (!row.customer_id || row.kyc_status !== "approved" || row.tos_status !== "approved") {
    const link = await bridgeApi.kycLink(row.kyc_link_id);
    Object.assign(row, {
      customer_id: link.customer_id ?? row.customer_id,
      kyc_status: link.kyc_status,
      tos_status: link.tos_status,
    });
  }
  if (row.kyc_status === "approved" && row.customer_id && !row.virtual_account_id) {
    try {
      const account = await bridgeApi.createVirtualAccount(
        row.customer_id,
        row.wallet_address,
        `muuve-va-${row.user_id}`,
      );
      row.virtual_account_id = account.id;
      row.deposit_instructions = account.source_deposit_instructions as Record<string, unknown>;
    } catch {
      // Usually the terms aren't accepted yet; the next refresh tries again.
    }
  }
  await transaction((c) =>
    c.query(
      `UPDATE usd_accounts SET customer_id=$2,kyc_status=$3,tos_status=$4,virtual_account_id=$5,
       deposit_instructions=$6,synced_at=now(),updated_at=now() WHERE user_id=$1`,
      [
        row.user_id,
        row.customer_id,
        row.kyc_status,
        row.tos_status,
        row.virtual_account_id,
        row.deposit_instructions,
      ],
    ),
  );
  if (row.customer_id && row.virtual_account_id)
    for (const event of await bridgeApi.history(row.customer_id, row.virtual_account_id))
      await recordActivity(row, event);
}

/** Records a deposit once, and on devnet credits it once by minting test dollars. */
async function recordActivity(row: Pick<Row, "user_id" | "wallet_address">, event: ActivityEvent) {
  const amount = usdToBaseUnits(event.amount);
  if (!event.deposit_id || !amount) return;
  const sandbox = bridgeEnv() === "sandbox";
  const existing = await one<{ operation_id: string | null }>(
    "SELECT operation_id FROM usd_deposits WHERE provider='bridge' AND deposit_id=$1",
    [event.deposit_id],
  );
  const credit = sandbox && CREDIT_EVENTS.sandbox.includes(event.type) && !existing?.operation_id;
  const credited = amount > MAX_SANDBOX_CREDIT ? MAX_SANDBOX_CREDIT : amount;
  const id = randomUUID();
  const prepared = credit
    ? await new Chain().fund(row.wallet_address, credited.toString(), id)
    : null;
  const operationId = await transaction(async (c) => {
    await c.query(
      `INSERT INTO usd_deposits(id,user_id,provider,deposit_id,amount_base_units,status)
       VALUES($1,$2,'bridge',$3,$4,$5)
       ON CONFLICT(provider,deposit_id) DO UPDATE SET status=EXCLUDED.status,updated_at=now()`,
      [randomUUID(), row.user_id, event.deposit_id, amount.toString(), event.type],
    );
    if (!prepared) return null;
    const locked = await one<{ operation_id: string | null }>(
      "SELECT operation_id FROM usd_deposits WHERE provider='bridge' AND deposit_id=$1 FOR UPDATE",
      [event.deposit_id],
      c,
    );
    if (locked?.operation_id) return null;
    await insertOperation(
      c,
      null,
      { kind: "fund", request: { amount: credited.toString(), key: `bridge:${event.deposit_id}` } },
      prepared,
      id,
    );
    await c.query("UPDATE operations SET actor_user_id=$2 WHERE id=$1", [id, row.user_id]);
    await c.query(
      "UPDATE usd_deposits SET operation_id=$2,updated_at=now() WHERE provider='bridge' AND deposit_id=$1",
      [event.deposit_id, id],
    );
    await audit(c, "user", row.user_id, "usd_account.deposit_credited");
    return id;
  });
  if (operationId) {
    const { submitServerOperation } = await import("./jobs");
    await submitServerOperation(operationId).catch(() =>
      safeLog({ event: "usd_deposit.submit_deferred", code: "reconcile" }),
    );
  }
}

export async function usdAccount(actor: Session, force = false) {
  const user = await userFor(actor);
  const sandbox = bridgeEnv() === "sandbox";
  const row = await accountRow(user.id);
  if (!row) return { status: "none" as const, sandbox };
  let syncError = false;
  try {
    await sync(row, force);
  } catch {
    syncError = true;
  }
  const deposits = (
    await database().query(
      `SELECT d.id,d.amount_base_units::text,d.status,d.created_at,o.state AS credit_state
         FROM usd_deposits d LEFT JOIN operations o ON o.id=d.operation_id
         WHERE d.user_id=$1 ORDER BY d.created_at DESC LIMIT 10`,
      [user.id],
    )
  ).rows;
  const i = (row.deposit_instructions ?? {}) as Record<string, unknown>;
  return {
    status: row.virtual_account_id
      ? ("active" as const)
      : row.kyc_status === "rejected" || row.kyc_status === "offboarded"
        ? ("rejected" as const)
        : ("pending" as const),
    sandbox,
    sync_error: syncError,
    kyc_status: row.kyc_status,
    tos_status: row.tos_status,
    kyc_url: row.virtual_account_id ? null : row.kyc_url,
    tos_url: row.tos_status === "approved" ? null : row.tos_url,
    account: row.virtual_account_id
      ? {
          bank_name: i.bank_name ?? null,
          bank_address: i.bank_address ?? null,
          routing_number: i.bank_routing_number ?? null,
          account_number: i.bank_account_number ?? null,
          beneficiary_name: i.bank_beneficiary_name ?? null,
          rails: i.payment_rails ?? [],
        }
      : null,
    deposits: deposits.map((d) => ({
      id: d.id,
      amount_base_units: d.amount_base_units,
      status: d.status,
      created_at: d.created_at,
      credited: !sandbox || d.credit_state === "finalized",
    })),
  };
}

async function sandboxRow(actor: Session) {
  assert(bridgeEnv() === "sandbox", "sandbox_only", 403);
  const user = await eligibleUser(actor);
  const row = await accountRow(user.id);
  assert(row, "usd_account_not_started", 409);
  return row;
}
export async function sandboxApprove(actor: Session) {
  const row = await sandboxRow(actor);
  if (!row.customer_id) row.customer_id = (await bridgeApi.kycLink(row.kyc_link_id)).customer_id;
  assert(row.customer_id, "usd_account_pending", 409);
  await bridgeApi.simulateKycApproval(row.customer_id);
  return usdAccount(actor, true);
}
export async function sandboxDeposit(actor: Session, input: z.infer<typeof usdSimulateSchema>) {
  const row = await sandboxRow(actor);
  assert(row.customer_id && row.virtual_account_id, "usd_account_pending", 409);
  const units = usdToBaseUnits(input.amount_usd);
  assert(units && units <= MAX_SANDBOX_CREDIT, "funding_limit");
  await bridgeApi.simulateDeposit(row.customer_id, row.virtual_account_id, input.amount_usd);
  return usdAccount(actor, true);
}

/** Bridge webhook: deposits arrive as virtual_account.activity events. */
export async function bridgeWebhook(raw: string, signature: string | null) {
  verifyBridgeSignature(raw, signature);
  const event = JSON.parse(raw) as {
    event_category?: string;
    event_object?: ActivityEvent;
  };
  const object = event.event_object;
  if (event.event_category?.startsWith("virtual_account") && object?.virtual_account_id) {
    const row = await one<Row>(
      "SELECT a.*,u.wallet_address FROM usd_accounts a JOIN users u ON u.id=a.user_id WHERE a.virtual_account_id=$1",
      [object.virtual_account_id],
    );
    if (row) await recordActivity(row, object);
  }
  return { received: true };
}
