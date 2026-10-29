import type { PoolClient } from "pg";
import { assert } from "./errors";
import { audit, one } from "./db";
const transitions: Record<string, Record<string, string[]>> = {
  links: { pending: ["open", "cancelled"], open: ["settled"], settled: [], cancelled: [] },
  link_slots: {
    pending: ["funded"],
    funded: ["cashing_out", "kept", "recalled", "returned"],
    cashing_out: ["cashed_out", "kept", "returned"],
    cashed_out: [],
    kept: [],
    recalled: [],
    returned: [],
  },
  payouts: {
    quoted: ["transferring", "processing", "failed", "resolved"],
    transferring: ["processing", "failed", "quarantined"],
    processing: ["paid", "failed", "quarantined"],
    failed: ["resolved", "quarantined"],
    paid: [],
    resolved: [],
    quarantined: ["paid", "failed"],
  },
};
export async function transition(
  c: PoolClient,
  table: "links" | "link_slots" | "payouts",
  id: string,
  to: string,
) {
  const row = await one(`SELECT status FROM ${table} WHERE id=$1 FOR UPDATE`, [id], c);
  assert(row, "not_found", 404);
  if (row.status === to) return;
  assert(transitions[table][row.status]?.includes(to), "invalid_transition", 409);
  await c.query(`UPDATE ${table} SET status=$2 WHERE id=$1`, [id, to]);
  // Database trigger records the transition atomically, including non-HTTP workers.
}
export async function settleLink(c: PoolClient, id: string) {
  const link = await one("SELECT status FROM links WHERE id=$1 FOR UPDATE", [id], c);
  if (link?.status !== "open") return;
  const unused = (
    await c.query(
      `SELECT pay.id,pay.status,p.state,p.source FROM payouts pay JOIN principals p ON p.id=pay.principal_id
   JOIN link_slots s ON s.id=p.link_slot_id WHERE s.link_id=$1 AND p.state IN ('kept','refunded')
   AND pay.provider_ref IS NULL AND pay.status IN ('quoted','transferring','failed')
   AND NOT EXISTS(SELECT 1 FROM provider_attempts a WHERE a.payout_id=pay.id) FOR UPDATE OF pay`,
      [id],
    )
  ).rows;
  for (const pay of unused) {
    if (pay.status !== "failed") await transition(c, "payouts", pay.id, "failed");
    await c.query(
      "UPDATE payouts SET status='resolved',resolution=$2,resolved_at=now() WHERE id=$1",
      [pay.id, pay.state === "kept" ? "kept_in_dollars" : "refunded_to_sender"],
    );
  }
  const row = await one(
    `SELECT EXISTS(SELECT 1 FROM link_slots WHERE link_id=$1 AND status IN ('pending','funded','cashing_out')) OR
 EXISTS(SELECT 1 FROM principals p JOIN link_slots s ON s.id=p.link_slot_id WHERE s.link_id=$1 AND p.state NOT IN ('paid','kept','refunded')) OR
 EXISTS(SELECT 1 FROM payouts pay JOIN principals p ON p.id=pay.principal_id JOIN link_slots s ON s.id=p.link_slot_id
 WHERE s.link_id=$1 AND pay.status NOT IN ('paid','resolved')) OR
 EXISTS(SELECT 1 FROM operations WHERE link_id=$1 AND state IN ('prepared','submitted','confirmed','unknown','held') AND kind!='intent') AS busy`,
    [id],
    c,
  );
  if (!row?.busy) {
    await transition(c, "links", id, "settled");
    await c.query("UPDATE links SET capacity_state='released' WHERE id=$1", [id]);
  }
}
