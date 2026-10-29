import { transaction, one, database, audit } from "./db";
import { assert } from "./errors";
import { Chain } from "./solana/chain";
import { insertOperation, reconcileOperation, prepareReplacement } from "./operations";
import { dispatchPayout, receiveWebhook, resolvePrincipal } from "./payouts";
import { payoutProvider, signWebhook } from "./providers/payout";
import { randomUUID } from "node:crypto";
import { safeLog } from "./log";

export async function submitServerOperation(id: string, chain = new Chain()) {
  const a = await one(
    "SELECT a.*,o.expected_signers,o.state AS operation_state FROM transaction_attempts a JOIN operations o ON o.id=a.operation_id WHERE o.id=$1 ORDER BY a.created_at DESC LIMIT 1",
    [id],
  );
  assert(a, "not_found", 404);
  if (["finalized", "failed"].includes(a.operation_state))
    return { operation_id: id, state: a.operation_state };
  assert(a.expected_signers.length === 0, "client_signature_required", 409);
  assert(a.state !== "held", "replacement_held", 409);
  await transaction(async (c) => {
    await c.query(
      "UPDATE operations SET state='submitted' WHERE id=$1 AND state NOT IN ('finalized','failed')",
      [id],
    );
    await c.query(
      "UPDATE transaction_attempts SET state='submitted' WHERE id=$1 AND state NOT IN ('finalized','failed','superseded')",
      [a.id],
    );
  });
  try {
    await chain.send(Buffer.from(a.tx_base64, "base64"));
  } catch {
    await transaction((c) =>
      c.query("UPDATE operations SET state='unknown' WHERE id=$1 AND state!='finalized'", [id]),
    );
    await prepareReplacement(id, chain);
  }
  return reconcileOperation(id, chain);
}
export async function expireLinks(chain = new Chain(), options: { signal?: AbortSignal } = {}) {
  const links = (
    await database().query(
      "SELECT * FROM links WHERE status='open' AND expires_at<=now() AND EXISTS(SELECT 1 FROM link_slots WHERE link_id=links.id AND status='funded') LIMIT 50",
    )
  ).rows;
  let count = 0;
  for (const link of links) {
    if (options.signal?.aborted) break;
    const state = await chain.link(link.pda);
    if (!state || state.openSlots === 0) continue;
    const prepared = await chain.settle(link.pda, state, "expire");
    const op = await transaction(async (c) => {
      await c.query("SELECT id FROM links WHERE id=$1 FOR UPDATE", [link.id]);
      const previous = await one(
        "SELECT id FROM operations WHERE link_id=$1 AND kind='expire' AND state IN ('prepared','submitted','confirmed','unknown','held')",
        [link.id],
        c,
      );
      return (
        previous?.id ??
        (await insertOperation(c, null, { kind: "expire", linkId: link.id, request: {} }, prepared))
          .operation_id
      );
    });
    await submitServerOperation(op, chain);
    count++;
  }
  if (count > 0) safeLog({ event: "worker.expirations_processed", state: String(count) });
  return { processed: count };
}
export async function failedPayouts(options: { signal?: AbortSignal } = {}) {
  const rows = (
    await database()
      .query(`SELECT r.id,s.link_id FROM principals r JOIN payouts p ON p.id=r.active_payout_id
 LEFT JOIN link_slots s ON s.id=r.link_slot_id WHERE r.state='treasury' AND p.status='failed'
 AND (r.source='wallet' OR p.failed_at<=now()-interval '48 hours') LIMIT 50`)
  ).rows;
  for (const row of rows) {
    if (options.signal?.aborted) break;
    try {
      await resolvePrincipal(null, row.link_id ?? null, "refund", undefined, row.id);
    } catch (error) {
      if ((error as { status?: number }).status !== 409) throw error;
    }
  }
  return { processed: rows.length };
}
export async function reconcileAll(chain = new Chain(), options: { signal?: AbortSignal } = {}) {
  const ops = (
    await database().query(
      "SELECT id,expected_signers FROM operations WHERE state IN ('prepared','submitted','confirmed','unknown','held') ORDER BY updated_at LIMIT 100",
    )
  ).rows;
  for (const op of ops) {
    if (options.signal?.aborted) break;
    try {
      const state = await reconcileOperation(op.id, chain);
      if (state.state === "prepared" && op.expected_signers.length === 0)
        await submitServerOperation(op.id, chain);
    } catch {
      await transaction((c) => audit(c, "operation", op.id, "operation.reconciliation_deferred"));
    }
  }
  await runJobs(options);
  return { processed: ops.length };
}
export async function runJobs(options: { signal?: AbortSignal; maxJobs?: number } = {}) {
  let count = 0;
  for (let i = 0; i < Math.min(options.maxJobs ?? 50, 50); i++) {
    if (options.signal?.aborted) break;
    const token = randomUUID();
    const job = await transaction(async (c) =>
      one(
        `UPDATE jobs SET state='running',lease_until=now()+interval '60 seconds',lease_token=$1,attempts=attempts+1 WHERE id=(
   SELECT id FROM jobs WHERE (state='pending' OR (state='running' AND lease_until<now())) AND run_after<=now()
   ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
        [token],
        c,
      ),
    );
    if (!job) break;
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void transaction((c) =>
        c.query(
          "UPDATE jobs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_token=$2 AND state='running'",
          [job.id, token],
        ),
      )
        .catch(() => safeLog({ event: "worker.job_lease_failed", code: "retry_required" }))
        .finally(() => {
          renewing = false;
        });
    }, 15_000);
    heartbeat.unref();
    try {
      if (job.kind === "payout") {
        const p = await one("SELECT status FROM payouts WHERE id=$1", [job.entity_id]);
        if (p?.status === "processing") await dispatchPayout(job.entity_id);
      } else if (["mock_webhook", "provider_reconcile"].includes(job.kind)) {
        const p = await one("SELECT * FROM payouts WHERE id=$1", [job.entity_id]);
        assert(p, "missing_payout", 503);
        const status = await payoutProvider().status(p.provider_key);
        assert(status && status.status !== "processing", "provider_pending", 409);
        const raw = JSON.stringify({
          event_id: `mock-${p.id}-${status.status}`,
          payout_id: p.id,
          provider_ref: status.providerRef,
          status: status.status,
        });
        const signed = signWebhook(raw);
        await receiveWebhook(raw, signed.timestamp, signed.signature);
      } else if (job.kind === "wallet_refund")
        await resolvePrincipal(null, null, "refund", undefined, job.entity_id);
      else if (job.kind === "reconcile") await reconcileOperation(job.entity_id);
      else if (job.kind === "prepare_replacement") await prepareReplacement(job.entity_id);
      else throw new Error("unknown_job");
      await transaction((c) =>
        c.query(
          "UPDATE jobs SET state='done',lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2",
          [job.id, token],
        ),
      );
      count++;
    } catch {
      await transaction((c) =>
        c.query(
          "UPDATE jobs SET state=CASE WHEN attempts>=10 THEN 'quarantined' ELSE 'pending' END,lease_until=NULL,lease_token=NULL,run_after=now()+interval '30 seconds',last_error='retry_required' WHERE id=$1 AND lease_token=$2",
          [job.id, token],
        ),
      );
    } finally {
      clearInterval(heartbeat);
    }
  }
  if (count > 0) safeLog({ event: "worker.jobs_processed", state: String(count) });
  return { processed: count };
}
