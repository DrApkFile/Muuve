import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { one, transaction } from "./db";
import type { Session } from "./auth";
import { assert } from "./errors";
import { Chain } from "./solana/chain";
import { existingOperation, insertOperation } from "./operations";
import { userFor } from "./links";
import type { ChainLink } from "./solana/codec";

export async function assertCanAttestClaim(
  actor: Session,
  id: string,
  options: {
    account?: Session;
    allowFailedPayout?: boolean;
    allowTerminal?: boolean;
    onchain?: ChainLink;
  } = {},
  c?: PoolClient,
) {
  assert(
    actor.purpose === "claim" && actor.link_id === id && actor.expires_at.getTime() > Date.now(),
    "invalid_claim_session",
    403,
  );
  const rows = await (c ?? (await import("./db")).database()).query(
    `SELECT s.*,l.pda,l.sender_wallet,l.claim_pubkey,l.expires_at,l.status AS link_status
 FROM link_slots s JOIN links l ON l.id=s.link_id WHERE l.id=$1 AND s.recipient_phone_e164=$2`,
    [id, actor.phone_e164],
  );
  assert(rows.rows.length === 1, "not_on_payment", 404);
  const slot = rows.rows[0]!;
  if (options.onchain) {
    const state = options.onchain,
      s = state.slots[slot.slot_index];
    assert(
      s &&
        state.sender === slot.sender_wallet &&
        state.claimPubkey === slot.claim_pubkey &&
        s.amount === slot.amount_base_units &&
        s.status === 1,
      "chain_database_mismatch",
      409,
    );
  }
  if (options.account)
    assert(
      options.account.phone_e164 === actor.phone_e164 && options.account.purpose === "account",
      "account_phone_mismatch",
      403,
    );
  if (options.allowTerminal) return slot;
  const failed =
    options.allowFailedPayout &&
    slot.status === "cashing_out" &&
    (await one(
      "SELECT p.id FROM payouts p JOIN principals r ON r.id=p.principal_id WHERE r.link_slot_id=$1 AND p.id=r.active_payout_id AND p.status='failed' AND r.state='treasury'",
      [slot.id],
      c,
    ));
  assert(slot.status === "funded" || failed, "slot_not_funded", 409);
  if (!failed)
    assert(
      slot.expires_at && new Date(slot.expires_at).getTime() > Date.now(),
      "link_expired",
      409,
    );
  return slot;
}
export async function share(actor: Session, id: string) {
  const s = await assertCanAttestClaim(actor, id, { allowTerminal: true });
  const payout = await one(
    `SELECT p.id,p.status,p.resolution,q.amount_ngn_kobo FROM payouts p JOIN principals r ON r.id=p.principal_id
 JOIN quotes q ON q.id=p.quote_id WHERE r.link_slot_id=$1 AND p.id=r.active_payout_id`,
    [s.id],
  );
  return {
    slot_index: s.slot_index,
    amount_base_units: s.amount_base_units,
    status: s.status,
    payout: payout ?? null,
    priority_until: s.priority_until,
  };
}
export async function startIntent(
  actor: Session,
  id: string,
  path: "keep" | "cashout",
  account?: Session,
) {
  const slot = await assertCanAttestClaim(actor, id, { ...(path === "keep" ? { account } : {}) });
  if (path === "keep") assert(account, "account_required", 401);
  const user = path === "keep" ? await userFor(account!) : undefined;
  if (user) assert(user.wallet_address, "wallet_required", 409);
  const chain = new Chain(),
    state = await chain.link(slot.pda);
  assert(state, "not_funded", 409);
  await assertCanAttestClaim(actor, id, {
    ...(path === "keep" ? { account } : {}),
    onchain: state,
  });
  const intentId = randomUUID(),
    prepared = await chain.intent(
      slot.pda,
      state,
      slot.slot_index,
      intentId,
      path,
      user?.wallet_address,
    );
  const context = { kind: "intent", linkId: id, slotId: slot.id, request: { path } };
  return transaction(async (c) => {
    await c.query("SELECT id FROM link_slots WHERE id=$1 FOR UPDATE", [slot.id]);
    await assertCanAttestClaim(actor, id, { ...(path === "keep" ? { account } : {}) }, c);
    const existing = await existingOperation(c, actor, context);
    if (existing) return existing;
    return { ...(await insertOperation(c, actor, context, prepared)), intent_id: intentId };
  });
}
export async function keep(actor: Session, account: Session, id: string) {
  const slot = await assertCanAttestClaim(actor, id, { account, allowTerminal: true });
  if (slot.status === "kept")
    return { done: true, slot: { status: "kept", amount_base_units: slot.amount_base_units } };
  await assertCanAttestClaim(actor, id, { account, allowFailedPayout: true });
  if (slot.status === "cashing_out")
    return (await import("./payouts")).resolvePrincipal(actor, id, "keep", account);
  const user = await userFor(account);
  assert(user.wallet_address, "wallet_required", 409);
  const chain = new Chain(),
    state = await chain.link(slot.pda);
  assert(state, "not_funded", 409);
  await assertCanAttestClaim(actor, id, { account, onchain: state });
  const s = state.slots[slot.slot_index]!;
  assert(s.version !== "0" && !s.toTreasury, "claim_intent_required", 409);
  const { ata } = await import("./solana/chain");
  assert(
    s.destination === ata(user.wallet_address, state.mint, state.tokenProgram).toBase58(),
    "intent_destination_mismatch",
    409,
  );
  const prepared = await chain.settle(
    slot.pda,
    state,
    "claim_keep",
    slot.slot_index,
    user.wallet_address,
  );
  const context = {
    kind: "claim_keep",
    linkId: id,
    slotId: slot.id,
    request: { destination: user.wallet_address, intent_id: s.intentId },
  };
  return transaction(async (c) => {
    await c.query("SELECT id FROM link_slots WHERE id=$1 FOR UPDATE", [slot.id]);
    await assertCanAttestClaim(actor, id, { account }, c);
    const owner = { ...actor, user_id: account.user_id };
    const existing = await existingOperation(c, owner, context);
    return existing ?? insertOperation(c, owner, context, prepared);
  });
}
