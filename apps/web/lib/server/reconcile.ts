import type { QueryResultRow, PoolClient } from "pg";
import { transaction, one, audit, enqueue } from "./db";
import { assert } from "./errors";
import { transition, settleLink } from "./state";
import { Chain } from "./solana/chain";
import type { ChainLink } from "./solana/codec";

async function syncLink(c: PoolClient, id: string, state: ChainLink, signature?: string) {
  const link = await one("SELECT * FROM links WHERE id=$1 FOR UPDATE", [id], c);
  assert(link, "not_found", 404);
  assert(
    state.sender === link.sender_wallet &&
      state.linkId === link.link_id_hex.trim() &&
      state.claimPubkey === link.claim_pubkey &&
      state.total === link.total_base_units &&
      state.slotCount === link.slot_count,
    "chain_database_mismatch",
    503,
  );
  const slots = (
    await c.query("SELECT * FROM link_slots WHERE link_id=$1 ORDER BY slot_index FOR UPDATE", [id])
  ).rows;
  if (link.status === "pending") {
    await transition(c, "links", id, "open");
    await c.query(
      "UPDATE links SET capacity_state='open',expires_at=$2,create_sig=COALESCE(create_sig,$3) WHERE id=$1",
      [id, new Date(state.expiresAt * 1000), signature ?? null],
    );
  }
  for (const slot of slots) {
    const onchain = state.slots[slot.slot_index];
    assert(onchain && onchain.amount === slot.amount_base_units, "chain_database_mismatch", 503);
    if (slot.status === "pending") await transition(c, "link_slots", slot.id, "funded");
    const actual = slot.status === "pending" ? "funded" : slot.status;
    if (onchain.status === 3 && actual === "funded")
      await transition(c, "link_slots", slot.id, "recalled");
    if (onchain.status === 4 && actual === "funded")
      await transition(c, "link_slots", slot.id, "returned");
    if ([3, 4].includes(onchain.status))
      await c.query(
        "UPDATE principals SET state='refunded' WHERE link_slot_id=$1 AND state='escrow'",
        [slot.id],
      );
    await c.query(
      "UPDATE link_slots SET intent_id=$2,intent_version=$3,intent_path=$4,priority_until=$5 WHERE id=$1",
      [
        slot.id,
        onchain.version === "0" ? null : formatUuid(onchain.intentId),
        onchain.version,
        onchain.version === "0" ? null : onchain.toTreasury ? "cashout" : "keep",
        onchain.priorityUntil ? new Date(onchain.priorityUntil * 1000) : null,
      ],
    );
  }
}
function formatUuid(hex: string) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function reconcileLink(id: string, chain = new Chain()) {
  const db = await one("SELECT * FROM links WHERE id=$1", [id]);
  assert(db, "not_found", 404);
  const state = await chain.link(db.pda);
  if (!state) return;
  await transaction(async (c) => {
    await syncLink(c, id, state);
    await settleLink(c, id);
  });
}
export async function applyFinalized(op: QueryResultRow, attempt: QueryResultRow, chain: Chain) {
  const link = op.link_id
    ? await one("SELECT pda FROM links WHERE id=$1", [op.link_id])
    : undefined;
  const state = link ? await chain.link(link.pda) : undefined;
  if (link) assert(state, "missing_finalized_link", 503);
  await transaction(async (c) => {
    const locked = await one("SELECT * FROM operations WHERE id=$1 FOR UPDATE", [op.id], c);
    if (locked?.state === "finalized") return;
    await c.query("UPDATE operations SET state='finalized',updated_at=now() WHERE id=$1", [op.id]);
    await c.query(
      "UPDATE transaction_attempts SET state=CASE WHEN id=$2 THEN 'finalized' WHEN state='failed' THEN 'failed' ELSE 'superseded' END,updated_at=now() WHERE operation_id=$1",
      [op.id, attempt.id],
    );
    if (state)
      await syncLink(c, op.link_id, state, op.kind === "create" ? attempt.signature : undefined);
    if (op.kind === "claim_keep") {
      const slot = await one("SELECT * FROM link_slots WHERE id=$1 FOR UPDATE", [op.slot_id], c);
      assert(slot && state?.slots[slot.slot_index]?.status === 2, "claim_not_finalized", 503);
      await transition(c, "link_slots", op.slot_id, "kept");
      await c.query(
        "UPDATE link_slots SET claimed_by_user_id=$2,claim_sig=$3,claimed_at=now() WHERE id=$1",
        [op.slot_id, op.actor_user_id, attempt.signature],
      );
      await c.query("UPDATE principals SET state='kept',transfer_sig=$2 WHERE link_slot_id=$1", [
        op.slot_id,
        attempt.signature,
      ]);
    }
    if (["claim_cashout", "wallet_payout"].includes(op.kind)) {
      if (op.slot_id) {
        const slot = await one("SELECT * FROM link_slots WHERE id=$1", [op.slot_id], c);
        assert(slot && state?.slots[slot.slot_index]?.status === 2, "claim_not_finalized", 503);
        await transition(c, "link_slots", op.slot_id, "cashing_out");
        await c.query("UPDATE link_slots SET claim_sig=$2,claimed_at=now() WHERE id=$1", [
          op.slot_id,
          attempt.signature,
        ]);
      }
      await c.query("UPDATE principals SET state='treasury',transfer_sig=$2 WHERE id=$1", [
        op.principal_id,
        attempt.signature,
      ]);
      const payout = await one(
        "SELECT status FROM payouts WHERE id=$1 FOR UPDATE",
        [op.payout_id],
        c,
      );
      assert(payout, "missing_payout", 503);
      if (payout.status === "quoted") await transition(c, "payouts", op.payout_id, "transferring");
      await transition(c, "payouts", op.payout_id, "processing");
      await enqueue(c, "payout", op.payout_id, `payout:${op.payout_id}`);
    }
    if (["treasury_keep", "treasury_refund"].includes(op.kind)) {
      const principal = await one(
        "SELECT * FROM principals WHERE id=$1 FOR UPDATE",
        [op.principal_id],
        c,
      );
      assert(principal, "missing_principal", 503);
      const kept = op.kind === "treasury_keep";
      await c.query("UPDATE principals SET state=$2 WHERE id=$1", [
        principal.id,
        kept ? "kept" : "refunded",
      ]);
      if (principal.link_slot_id)
        await transition(c, "link_slots", principal.link_slot_id, kept ? "kept" : "returned");
      if (kept && principal.link_slot_id)
        await c.query("UPDATE link_slots SET claimed_by_user_id=$2 WHERE id=$1", [
          principal.link_slot_id,
          op.actor_user_id,
        ]);
      if (principal.active_payout_id) {
        const resolution = kept
          ? "kept_in_dollars"
          : principal.source === "wallet"
            ? "returned_to_wallet"
            : "refunded_to_sender";
        await c.query(
          "UPDATE payouts SET status='resolved',resolution=$2,resolved_at=now() WHERE id=$1 AND status='failed'",
          [principal.active_payout_id, resolution],
        );
        await audit(c, "payout", principal.active_payout_id, `payout.${resolution}`);
      }
    }
    if (op.kind === "fund")
      await c.query("UPDATE funding_reservations SET state='minted' WHERE operation_id=$1", [
        op.id,
      ]);
    await audit(c, "operation", op.id, "operation.finalized", { signature: attempt.signature });
    if (op.link_id) await settleLink(c, op.link_id);
  });
}
export async function applyFailure(op: QueryResultRow) {
  await transaction(async (c) => {
    const current = await one("SELECT state FROM operations WHERE id=$1 FOR UPDATE", [op.id], c);
    if (current?.state === "finalized") return;
    await c.query("UPDATE operations SET state='failed',updated_at=now() WHERE id=$1", [op.id]);
    if (op.kind === "create") {
      const link = await one("SELECT status FROM links WHERE id=$1 FOR UPDATE", [op.link_id], c);
      if (link?.status === "pending") {
        await transition(c, "links", op.link_id, "cancelled");
        await c.query("UPDATE links SET capacity_state='released' WHERE id=$1", [op.link_id]);
      }
    }
    if (op.kind === "fund")
      await c.query("UPDATE funding_reservations SET state='released' WHERE operation_id=$1", [
        op.id,
      ]);
    if (["treasury_keep", "treasury_refund"].includes(op.kind))
      await c.query("UPDATE principals SET state='treasury' WHERE id=$1 AND state='resolving'", [
        op.principal_id,
      ]);
    if (["claim_cashout", "wallet_payout"].includes(op.kind) && op.payout_id) {
      await c.query(
        "UPDATE payouts SET status='failed',failed_at=now(),failure_reason='chain_not_executed' WHERE id=$1 AND status IN ('quoted','transferring')",
        [op.payout_id],
      );
    }
    await audit(c, "operation", op.id, "operation.failed");
    if (op.link_id) await settleLink(c, op.link_id);
  });
}
