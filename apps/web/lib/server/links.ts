import type { z } from "zod";
import { LIMITS, schemas, totalAllocations } from "@muuve/shared";
import type { Session } from "./auth";
import { database, transaction, one, audit } from "./db";
import { assert } from "./errors";
import { Chain, linkPda } from "./solana/chain";
import { existingOperation, insertOperation, storedOperation, canonical } from "./operations";

export async function userFor(session: Session) {
  assert(session.user_id, "account_required", 401);
  const user = await one("SELECT * FROM users WHERE id=$1", [session.user_id]);
  assert(user, "unauthorized", 401);
  return user;
}
export async function senderLink(session: Session, id: string) {
  const link = await one("SELECT * FROM links WHERE id=$1 AND sender_user_id=$2", [
    id,
    session.user_id,
  ]);
  assert(link, "not_found", 404);
  return link;
}
export async function createLink(actor: Session, body: z.infer<typeof schemas.create>) {
  const user = await userFor(actor);
  assert(user.wallet_address, "wallet_required", 409);
  const total = totalAllocations(body.recipients.map((r) => r.amount_base_units));
  assert(
    new Set(body.recipients.map((r) => r.phone_e164)).size === body.recipients.length,
    "duplicate_recipient",
  );
  assert(!body.recipients.some((r) => r.phone_e164 === user.phone_e164), "self_payment");
  const chain = new Chain();
  const chainConfig = await chain.readiness();
  assert(
    total <= BigInt(chainConfig.maxLink) &&
      body.recipients.every((r) => BigInt(r.amount_base_units) <= BigInt(chainConfig.maxSlot)),
    "configured_amount_limit",
  );
  const balance = BigInt(await chain.balance(user.wallet_address));
  const pda = linkPda(user.wallet_address, body.link_id_hex).toBase58();
  const prepared = await chain.create(
    user.wallet_address,
    body.link_id_hex,
    body.claim_pubkey,
    body.recipients.map((r) => r.amount_base_units),
  );
  return transaction(async (c) => {
    await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
    const existing = await one(
      "SELECT * FROM links WHERE sender_user_id=$1 AND link_id_hex=$2",
      [user.id, body.link_id_hex],
      c,
    );
    if (existing) {
      const op = await one(
        "SELECT * FROM operations WHERE link_id=$1 AND kind='create' ORDER BY created_at DESC LIMIT 1",
        [existing.id],
        c,
      );
      assert(op && canonical(op.request) === canonical(body), "link_id_conflict", 409);
      return { link: await linkView(existing.id, c), ...(await storedOperation(c, op.id)) };
    }
    const outstanding = await one(
      `SELECT COALESCE(sum(CASE WHEN l.capacity_state='reserved' THEN l.total_base_units
    ELSE (SELECT COALESCE(sum(amount_base_units),0) FROM link_slots s WHERE s.link_id=l.id AND (s.status IN ('funded','cashing_out')
    OR EXISTS(SELECT 1 FROM principals p WHERE p.link_slot_id=s.id AND p.state NOT IN ('paid','kept','refunded')))) END),0)::text AS amount,
    COALESCE(sum(l.total_base_units) FILTER(WHERE l.capacity_state='reserved'),0)::text AS pending
    FROM links l WHERE l.sender_user_id=$1 AND l.capacity_state!='released'`,
      [user.id],
      c,
    );
    assert(BigInt(outstanding!.amount) + total <= LIMITS.maxOutstanding, "outstanding_limit", 409);
    const walletOps = await one(
      "SELECT COALESCE(sum((request->>'amount')::numeric),0)::text AS amount FROM operations WHERE actor_user_id=$1 AND kind='wallet_payout' AND state IN ('prepared','submitted','confirmed','unknown','held')",
      [user.id],
      c,
    );
    assert(
      total + BigInt(outstanding!.pending) + BigInt(walletOps!.amount) <= balance,
      "insufficient_balance",
      409,
    );
    const link = await one(
      `INSERT INTO links(sender_user_id,sender_wallet,link_id_hex,pda,claim_pubkey,note,kind,total_base_units,slot_count)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        user.id,
        user.wallet_address,
        body.link_id_hex,
        pda,
        body.claim_pubkey,
        body.note ?? null,
        body.recipients.length === 1 ? "single" : "batch",
        total.toString(),
        body.recipients.length,
      ],
      c,
    );
    for (const [index, recipient] of body.recipients.entries())
      await c.query(
        "INSERT INTO link_slots(link_id,slot_index,recipient_phone_e164,label,amount_base_units) VALUES($1,$2,$3,$4,$5)",
        [
          link!.id,
          index,
          recipient.phone_e164,
          recipient.label ?? null,
          recipient.amount_base_units,
        ],
      );
    const op = await insertOperation(
      c,
      actor,
      { kind: "create", linkId: link!.id, request: body },
      prepared,
    );
    await audit(c, "link", link!.id, "link.prepared");
    return { link: await linkView(link!.id, c), ...op };
  });
}
export async function linkView(
  id: string,
  c: import("pg").PoolClient | import("pg").Pool = database(),
) {
  const l = await one(
    "SELECT id,link_id_hex,kind,note,total_base_units,slot_count,status,expires_at,created_at FROM links WHERE id=$1",
    [id],
    c,
  );
  const slots = (
    await c.query(
      "SELECT slot_index,recipient_phone_e164,label,amount_base_units,status FROM link_slots WHERE link_id=$1 ORDER BY slot_index",
      [id],
    )
  ).rows;
  const timeline = (
    await c.query(
      `SELECT id,type,payload,created_at FROM events WHERE entity_id=$1 OR entity_id IN (
   SELECT id FROM link_slots WHERE link_id=$1 UNION SELECT id FROM operations WHERE link_id=$1
   UNION SELECT p.id FROM principals p JOIN link_slots s ON s.id=p.link_slot_id WHERE s.link_id=$1
   UNION SELECT pay.id FROM payouts pay JOIN principals p ON p.id=pay.principal_id JOIN link_slots s ON s.id=p.link_slot_id WHERE s.link_id=$1)
   ORDER BY id DESC LIMIT 100`,
      [id],
    )
  ).rows;
  return {
    ...l,
    slots,
    timeline,
    reminder_due:
      !!l &&
      Date.now() - new Date(l.created_at).getTime() >= 86400000 &&
      slots.some((s) => s.status === "funded"),
  };
}
export async function listLinks(actor: Session) {
  return (
    await database().query(
      `SELECT l.id,l.kind,l.total_base_units,l.status,l.expires_at,l.created_at,
 (SELECT count(*) FROM link_slots s WHERE s.link_id=l.id AND s.status IN ('kept','cashed_out'))::int AS claimed_slots,l.slot_count
 FROM links l WHERE sender_user_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [actor.user_id],
    )
  ).rows;
}
export async function preview(id: string) {
  const row = await one(
    `SELECT l.kind,l.note,l.status,l.expires_at,l.total_base_units,split_part(u.display_name,' ',1) AS sender_first_name
 FROM links l JOIN users u ON u.id=l.sender_user_id WHERE l.id=$1 AND l.status NOT IN ('pending','cancelled')`,
    [id],
  );
  assert(row, "not_found", 404);
  return {
    kind: row.kind,
    sender_first_name: row.sender_first_name,
    note: row.note,
    status: row.status,
    expires_at: row.expires_at,
    ...(row.kind === "single" ? { amount_base_units: row.total_base_units } : {}),
  };
}
export async function recall(actor: Session, id: string, index?: number) {
  const link = await senderLink(actor, id),
    chain = new Chain();
  const state = await chain.link(link.pda);
  assert(state, "not_funded", 409);
  assert(Date.now() < state.expiresAt * 1000, "link_expired", 409);
  if (index !== undefined) assert(index < state.slotCount, "invalid_slot_index");
  const request = index === undefined ? {} : { slot_index: index };
  const context = { kind: "recall", linkId: id, request };
  const prepared = await chain.settle(link.pda, state, "recall", index);
  return transaction(async (c) => {
    await c.query("SELECT id FROM links WHERE id=$1 FOR UPDATE", [id]);
    const existing = await existingOperation(c, actor, context);
    return existing ?? insertOperation(c, actor, context, prepared);
  });
}
