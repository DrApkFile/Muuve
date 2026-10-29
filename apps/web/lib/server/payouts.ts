import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { ngnKobo, schemas, U64_MAX } from "@muuve/shared";
import type { Session } from "./auth";
import { database, transaction, one, audit, enqueue } from "./db";
import { assert } from "./errors";
import { assertCanAttestClaim } from "./claims";
import { userFor } from "./links";
import { Chain } from "./solana/chain";
import { existingOperation, insertOperation, submitOperation } from "./operations";
import { payoutProvider, verifyWebhook, type PayoutProvider } from "./providers/payout";
import { mockRateProvider, mockBankDirectory } from "./providers/finance";
import { transition, settleLink } from "./state";
import { hash } from "./solana/codec";

export async function quote(actor: Session, body: z.infer<typeof schemas.quote>, linkId?: string) {
  const slot = linkId
    ? await assertCanAttestClaim(actor, linkId, { allowFailedPayout: true })
    : undefined;
  const user = linkId ? undefined : await userFor(actor);
  if (!slot) assert(body.amount_base_units && user?.wallet_address, "wallet_and_amount_required");
  const currentRate = await mockRateProvider.getRate();
  return transaction(async (c) => {
    if (slot) await c.query("SELECT id FROM link_slots WHERE id=$1 FOR UPDATE", [slot.id]);
    let principal = slot
      ? await one("SELECT * FROM principals WHERE link_slot_id=$1 FOR UPDATE", [slot.id], c)
      : undefined;
    if (body.retry_of) {
      const old = await one(
        "SELECT * FROM payouts WHERE id=$1 AND status='failed' FOR UPDATE",
        [body.retry_of],
        c,
      );
      assert(
        principal &&
          old &&
          old.principal_id === principal.id &&
          principal.active_payout_id === old.id &&
          principal.state === "treasury",
        "invalid_retry",
        409,
      );
    } else if (principal?.state === "treasury") assert(false, "retry_reference_required", 409);
    if (!principal) {
      principal = await one(
        `INSERT INTO principals(source,link_slot_id,user_id,owner_phone,sender_wallet,amount_base_units)
   VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          slot ? "escrow_claim" : "wallet",
          slot?.id ?? null,
          user?.id ?? actor.user_id ?? null,
          actor.phone_e164,
          slot?.sender_wallet ?? user!.wallet_address,
          slot?.amount_base_units ?? body.amount_base_units,
        ],
        c,
      );
    }
    assert(
      principal &&
        !["paid", "kept", "refunded", "resolving", "quarantined"].includes(principal.state),
      "principal_not_available",
      409,
    );
    const fx = currentRate.ngnPerUsd,
      amount = principal.amount_base_units,
      kobo = ngnKobo(amount, fx);
    assert(BigInt(kobo) > 0n, "amount_too_small");
    assert(BigInt(kobo) <= U64_MAX, "amount_too_large");
    const q = await one(
      `INSERT INTO quotes(actor_session_id,principal_id,amount_base_units,rate,amount_ngn_kobo,expires_at)
   VALUES($1,$2,$3,$4,$5,now()+interval '60 seconds') RETURNING *`,
      [actor.id, principal.id, amount, fx, kobo],
      c,
    );
    return {
      quote_id: q!.id,
      rate_ngn_per_usd: fx,
      amount_ngn_kobo: kobo,
      expires_at: q!.expires_at,
      mock: true,
    };
  });
}
async function ownedPrincipal(actor: Session, id: string) {
  const p = await one(
    "SELECT p.*,s.link_id FROM principals p LEFT JOIN link_slots s ON s.id=p.link_slot_id WHERE p.id=$1",
    [id],
  );
  assert(p, "not_found", 404);
  if (p.source === "wallet")
    assert(actor.purpose === "account" && p.user_id === actor.user_id, "forbidden", 403);
  else {
    if (
      actor.purpose === "account" &&
      actor.user_id === p.user_id &&
      actor.phone_e164 === p.owner_phone
    )
      return p;
    assert(
      actor.purpose === "claim" &&
        actor.link_id === p.link_id &&
        actor.phone_e164 === p.owner_phone,
      "forbidden",
      403,
    );
    await assertCanAttestClaim(actor, p.link_id, { allowTerminal: true });
  }
  return p;
}
export async function preparePayout(
  actor: Session,
  body: z.infer<typeof schemas.cashout>,
  linkId?: string,
) {
  const q = await one("SELECT * FROM quotes WHERE id=$1", [body.quote_id]);
  assert(q && q.actor_session_id === actor.id, "invalid_quote", 403);
  const principal = await ownedPrincipal(actor, q.principal_id);
  assert(
    !!linkId === (principal.source === "escrow_claim") && (!linkId || principal.link_id === linkId),
    "wrong_payout_source",
    403,
  );
  const replay = await one(
    "SELECT p.*,o.id AS operation_id FROM payouts p JOIN operations o ON o.payout_id=p.id WHERE p.quote_id=$1",
    [q.id],
  );
  if (replay) {
    assert(
      replay.bank_code === body.bank_code && replay.account_number === body.account_number,
      "idempotency_conflict",
      409,
    );
    const { storedOperation } = await import("./operations");
    return transaction(async (c) => ({
      payout: await payoutView(actor, replay.id),
      ...(await storedOperation(c, replay.operation_id)),
    }));
  }
  const resolved = await mockBankDirectory.resolveAccount(body.bank_code, body.account_number),
    chain = new Chain();
  await chain.readiness();
  let treasuryOwner = chain.keys.treasury.publicKey.toBase58(),
    treasuryAccount = chain.c.TREASURY_TOKEN_ACCOUNT;
  let prepared,
    slot,
    operationId = randomUUID();
  if (linkId) {
    slot = await assertCanAttestClaim(actor, linkId);
    const state = await chain.link(slot.pda);
    assert(state, "not_funded", 409);
    await assertCanAttestClaim(actor, linkId, { onchain: state });
    assert(
      state.slots[slot.slot_index]?.toTreasury && state.slots[slot.slot_index]?.version !== "0",
      "claim_intent_required",
      409,
    );
    treasuryOwner = state.treasuryOwner;
    treasuryAccount = state.treasury;
    prepared = await chain.settle(
      slot.pda,
      state,
      "claim_cashout",
      slot.slot_index,
      state.treasuryOwner,
    );
  } else {
    const user = await userFor(actor);
    assert(user.wallet_address, "wallet_required", 409);
    prepared = await chain.tokenTransfer(
      "wallet",
      user.wallet_address,
      chain.keys.treasury.publicKey.toBase58(),
      q.amount_base_units,
      operationId,
    );
  }
  const balance = linkId ? undefined : BigInt(await chain.balance(principal.sender_wallet));
  return transaction(async (c) => {
    if (linkId) {
      await c.query("SELECT id FROM link_slots WHERE id=$1 FOR UPDATE", [slot!.id]);
      await assertCanAttestClaim(actor, linkId, {}, c);
    } else await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [actor.user_id]);
    const current = await one("SELECT * FROM quotes WHERE id=$1 FOR UPDATE", [q.id], c);
    const old = await one(
      "SELECT p.id,o.id AS operation_id FROM payouts p JOIN operations o ON o.payout_id=p.id WHERE p.quote_id=$1",
      [q.id],
      c,
    );
    if (old) {
      const { storedOperation } = await import("./operations");
      return {
        payout: await payoutView(actor, old.id),
        ...(await storedOperation(c, old.operation_id)),
      };
    }
    assert(
      current && !current.consumed_at && current.expires_at.getTime() > Date.now(),
      "quote_expired",
      409,
    );
    const p = await one("SELECT * FROM principals WHERE id=$1 FOR UPDATE", [principal.id], c);
    assert(p?.state === "escrow", "principal_not_available", 409);
    if (balance !== undefined) {
      const reservations = await one(
        `SELECT COALESCE(sum((request->>'amount')::numeric),0)::text AS amount FROM operations
    WHERE actor_user_id=$1 AND kind='wallet_payout' AND state IN ('prepared','submitted','confirmed','unknown','held')`,
        [actor.user_id],
        c,
      );
      const links = await one(
        "SELECT COALESCE(sum(total_base_units),0)::text AS amount FROM links WHERE sender_user_id=$1 AND capacity_state='reserved'",
        [actor.user_id],
        c,
      );
      assert(
        BigInt(q.amount_base_units) + BigInt(reservations!.amount) + BigInt(links!.amount) <=
          balance,
        "insufficient_balance",
        409,
      );
    }
    const payout = await one(
      `INSERT INTO payouts(principal_id,quote_id,bank_code,account_number,account_name,provider,provider_key)
   VALUES($1,$2,$3,$4,$5,'mock',$6) RETURNING id`,
      [principal.id, q.id, body.bank_code, body.account_number, resolved.accountName, randomUUID()],
      c,
    );
    await c.query(
      "UPDATE principals SET active_payout_id=$2,treasury_owner=$3,treasury_account=$4 WHERE id=$1",
      [principal.id, payout!.id, treasuryOwner, treasuryAccount],
    );
    await c.query("UPDATE quotes SET consumed_at=now() WHERE id=$1", [q.id]);
    const result = await insertOperation(
      c,
      actor,
      {
        kind: linkId ? "claim_cashout" : "wallet_payout",
        linkId,
        slotId: slot?.id,
        payoutId: payout!.id,
        principalId: principal.id,
        request: { amount: q.amount_base_units, quote_id: q.id },
      },
      prepared,
      operationId,
    );
    await transition(c, "payouts", payout!.id, "transferring");
    return { payout: { id: payout!.id, status: "transferring" }, ...result };
  });
}
export async function payoutView(actor: Session, id: string) {
  const row = await one(
    `SELECT p.*,q.amount_ngn_kobo,q.rate,q.expires_at AS quote_expires_at FROM payouts p JOIN quotes q ON q.id=p.quote_id WHERE p.id=$1`,
    [id],
  );
  assert(row, "not_found", 404);
  await ownedPrincipal(actor, row.principal_id);
  return {
    id: row.id,
    status: row.status,
    resolution: row.resolution,
    amount_ngn_kobo: row.amount_ngn_kobo,
    rate_ngn_per_usd: row.rate,
    provider_ref: row.provider_ref,
    account_name: row.account_name,
    account_last4: row.account_number.slice(-4),
    mock: true,
  };
}
export async function dispatchPayout(id: string, provider: PayoutProvider = payoutProvider()) {
  const p = await one(
    `SELECT p.*,q.amount_ngn_kobo,r.state AS principal_state FROM payouts p JOIN quotes q ON q.id=p.quote_id JOIN principals r ON r.id=p.principal_id WHERE p.id=$1`,
    [id],
  );
  assert(
    p && p.status === "processing" && p.principal_state === "treasury",
    "payout_not_dispatchable",
    409,
  );
  const request = {
    payoutId: id,
    providerKey: p.provider_key,
    amountKobo: p.amount_ngn_kobo,
    bankCode: p.bank_code,
    accountNumber: p.account_number,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await provider.createPayout(request);
      await transaction(async (c) => {
        await c.query("UPDATE payouts SET provider_ref=$2 WHERE id=$1", [id, result.providerRef]);
        await c.query(
          "INSERT INTO provider_attempts(payout_id,provider_key,outcome) VALUES($1,$2,'accepted')",
          [id, p.provider_key],
        );
        await enqueue(c, "mock_webhook", id, `mock-event:${id}`, 4);
      });
      return;
    } catch {
      await transaction((c) =>
        c.query(
          "INSERT INTO provider_attempts(payout_id,provider_key,outcome) VALUES($1,$2,'unknown')",
          [id, p.provider_key],
        ),
      );
      if (!provider.safeIdempotency) {
        await quarantine(id);
        return;
      }
    }
  }
  const status = await provider.status(p.provider_key).catch(() => undefined);
  if (!status) await quarantine(id);
  else
    await transaction(async (c) => {
      await c.query("UPDATE payouts SET provider_ref=$2 WHERE id=$1", [id, status.providerRef]);
      await enqueue(c, "provider_reconcile", id, `provider-reconcile:${id}`, 5);
    });
}
async function quarantine(id: string) {
  await transaction(async (c) => {
    const p = await one("SELECT * FROM payouts WHERE id=$1 FOR UPDATE", [id], c);
    if (!p || ["paid", "resolved"].includes(p.status)) return;
    await transition(c, "payouts", id, "quarantined");
    await c.query(
      "UPDATE principals SET state='quarantined',quarantine_reason=CASE WHEN quarantine_reason='provider_conflict' THEN quarantine_reason ELSE 'provider_unknown' END WHERE id=$1",
      [p.principal_id],
    );
  });
}
export async function receiveWebhook(
  raw: string,
  timestamp: string | null,
  signature: string | null,
) {
  const event = verifyWebhook(raw, timestamp, signature),
    digest = hash(raw).toString("hex");
  await transaction(async (c) => {
    const initial = await one("SELECT * FROM payouts WHERE id=$1", [event.payout_id], c);
    assert(initial, "unknown_provider_reference", 409);
    const p = await one(
      "SELECT * FROM principals WHERE id=$1 FOR UPDATE",
      [initial.principal_id],
      c,
    );
    assert(p, "missing_principal", 503);
    const payout = await one("SELECT * FROM payouts WHERE id=$1 FOR UPDATE", [event.payout_id], c);
    assert(
      payout && payout.provider === "mock" && payout.provider_ref === event.provider_ref,
      "unknown_provider_reference",
      409,
    );
    await c.query(
      "INSERT INTO webhook_inbox(provider,event_id,body_hash,payout_id,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      ["mock", event.event_id, digest, payout.id, event.status],
    );
    const inbox = await one(
      "SELECT * FROM webhook_inbox WHERE provider=$1 AND event_id=$2 FOR UPDATE",
      ["mock", event.event_id],
      c,
    );
    assert(inbox?.body_hash === digest, "webhook_event_conflict", 409);
    if (inbox.processed_at) return;
    if (
      payout.status === event.status ||
      (payout.status === "resolved" && event.status === "failed" && payout.failed_at)
    ) {
      await c.query(
        "UPDATE webhook_inbox SET processed_at=now() WHERE provider='mock' AND event_id=$1",
        [event.event_id],
      );
      return;
    }
    if (p.quarantine_reason === "provider_conflict") {
      await audit(c, "payout", payout.id, "payout.conflict_observation_recorded");
    } else if (
      !["processing", "quarantined"].includes(payout.status) ||
      !["treasury", "quarantined"].includes(p.state)
    ) {
      await c.query(
        "UPDATE principals SET state='quarantined',quarantine_reason='provider_conflict' WHERE id=$1",
        [p.id],
      );
      if (p.active_payout_id) {
        const active = await one(
          "SELECT status FROM payouts WHERE id=$1 FOR UPDATE",
          [p.active_payout_id],
          c,
        );
        if (active?.status === "processing")
          await transition(c, "payouts", p.active_payout_id, "quarantined");
      }
      await audit(c, "payout", payout.id, "payout.contradictory_provider_event");
      // Do not reverse terminal transfers or dispatch another resolution.
    } else {
      await transition(c, "payouts", payout.id, event.status);
      if (event.status === "paid") {
        await c.query("UPDATE principals SET state='paid',quarantine_reason=NULL WHERE id=$1", [
          p.id,
        ]);
        if (p.link_slot_id) await transition(c, "link_slots", p.link_slot_id, "cashed_out");
      } else {
        await c.query("UPDATE principals SET state='treasury',quarantine_reason=NULL WHERE id=$1", [
          p.id,
        ]);
        await c.query(
          "UPDATE payouts SET failed_at=now(),failure_reason='provider_failed' WHERE id=$1",
          [payout.id],
        );
        if (p.source === "wallet") await enqueue(c, "wallet_refund", p.id, `wallet-refund:${p.id}`);
      }
    }
    await c.query(
      "UPDATE webhook_inbox SET processed_at=now() WHERE provider='mock' AND event_id=$1",
      [event.event_id],
    );
    if (p.link_slot_id) {
      const s = await one("SELECT link_id FROM link_slots WHERE id=$1", [p.link_slot_id], c);
      const principal = await one("SELECT state FROM principals WHERE id=$1", [p.id], c);
      if (principal?.state === "quarantined")
        await c.query(
          "UPDATE links SET status='open',capacity_state='open' WHERE id=$1 AND status='settled'",
          [s!.link_id],
        );
      await settleLink(c, s!.link_id);
    }
  });
  return { received: true };
}
export async function retryPayout(
  actor: Session,
  id: string,
  body: z.infer<typeof schemas.cashout>,
) {
  assert(body.idempotency_key, "idempotency_key_required");
  const slot = await assertCanAttestClaim(actor, id, { allowTerminal: true });
  assert(slot.status === "cashing_out", "retry_not_available", 409);
  const resolved = await mockBankDirectory.resolveAccount(body.bank_code, body.account_number);
  return transaction(async (c) => {
    const p = await one("SELECT * FROM principals WHERE link_slot_id=$1 FOR UPDATE", [slot.id], c);
    assert(p, "principal_not_available", 409);
    const keyed = await one(
      "SELECT id,status,quote_id,bank_code,account_number FROM payouts WHERE principal_id=$1 AND client_idempotency_key=$2",
      [p.id, body.idempotency_key],
      c,
    );
    if (keyed) {
      assert(
        keyed.quote_id === body.quote_id &&
          keyed.bank_code === body.bank_code &&
          keyed.account_number === body.account_number,
        "idempotency_conflict",
        409,
      );
      return { payout: { id: keyed.id, status: keyed.status } };
    }
    const retried = await one(
      "SELECT id,status,bank_code,account_number FROM payouts WHERE quote_id=$1 AND principal_id=$2",
      [body.quote_id, p.id],
      c,
    );
    if (retried) {
      assert(
        retried.bank_code === body.bank_code && retried.account_number === body.account_number,
        "idempotency_conflict",
        409,
      );
      return { payout: { id: retried.id, status: retried.status } };
    }
    assert(p.state === "treasury", "principal_not_available", 409);
    const previous = await one(
      "SELECT * FROM payouts WHERE id=$1 AND status='failed' FOR UPDATE",
      [p.active_payout_id],
      c,
    );
    assert(previous, "retry_not_available", 409);
    const q = await one("SELECT * FROM quotes WHERE id=$1 FOR UPDATE", [body.quote_id], c);
    assert(q && q.principal_id === p.id && q.actor_session_id === actor.id, "invalid_quote", 403);
    const duplicate = await one("SELECT id,status FROM payouts WHERE quote_id=$1", [q.id], c);
    if (duplicate) return { payout: duplicate };
    assert(!q.consumed_at && q.expires_at.getTime() > Date.now(), "quote_expired", 409);
    await c.query(
      "UPDATE payouts SET status='resolved',resolution='retried',resolved_at=now() WHERE id=$1",
      [previous.id],
    );
    const next = await one(
      `INSERT INTO payouts(principal_id,quote_id,retry_of,bank_code,account_number,account_name,status,provider,provider_key,client_idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,'processing','mock',$7,$8) RETURNING id,status`,
      [
        p.id,
        q.id,
        previous.id,
        body.bank_code,
        body.account_number,
        resolved.accountName,
        randomUUID(),
        body.idempotency_key,
      ],
      c,
    );
    await c.query("UPDATE principals SET active_payout_id=$2 WHERE id=$1", [p.id, next!.id]);
    await c.query("UPDATE quotes SET consumed_at=now() WHERE id=$1", [q.id]);
    await audit(c, "payout", previous.id, "payout.retried", { replacement_id: next!.id });
    await enqueue(c, "payout", next!.id, `payout:${next!.id}`);
    return { payout: next };
  });
}
export async function resolvePrincipal(
  actor: Session | null,
  linkId: string | null,
  mode: "keep" | "refund",
  account?: Session,
  principalId?: string,
) {
  const slot =
    actor && linkId
      ? await assertCanAttestClaim(actor, linkId, { account, allowTerminal: true })
      : undefined;
  const p = await one("SELECT * FROM principals WHERE " + (slot ? "link_slot_id=$1" : "id=$1"), [
    slot?.id ?? principalId,
  ]);
  assert(p, "not_found", 404);
  if (mode === "keep")
    assert(account && account.phone_e164 === p.owner_phone, "account_phone_mismatch", 403);
  const user = mode === "keep" ? await userFor(account!) : undefined;
  const destination = user?.wallet_address ?? p.sender_wallet;
  assert(destination, "wallet_required", 409);
  if ((mode === "keep" && p.state === "kept") || (mode === "refund" && p.state === "refunded"))
    return { done: true, state: p.state };
  const active = await one(
    "SELECT * FROM operations WHERE principal_id=$1 AND kind=$2 AND state IN ('prepared','submitted','confirmed','unknown','held') ORDER BY created_at DESC LIMIT 1",
    [p.id, mode === "keep" ? "treasury_keep" : "treasury_refund"],
  );
  if (active) {
    assert(active.request.destination === destination, "resolution_conflict", 409);
    return { operation_id: active.id, state: active.state };
  }
  const chain = new Chain();
  await chain.readiness();
  assert(p.treasury_owner, "treasury_origin_not_recorded", 503);
  const opId = randomUUID();
  const prepared = await chain.tokenTransfer(
    "treasury",
    p.treasury_owner,
    destination,
    p.amount_base_units,
    opId,
  );
  const result = await transaction(async (c) => {
    const principal = await one("SELECT * FROM principals WHERE id=$1 FOR UPDATE", [p.id], c);
    assert(principal, "not_found", 404);
    const old = await one(
      "SELECT * FROM payouts WHERE id=$1 FOR UPDATE",
      [principal.active_payout_id],
      c,
    );
    assert(
      principal.state === "treasury" && old?.status === "failed",
      "resolution_not_available",
      409,
    );
    if (mode === "refund" && principal.source === "escrow_claim")
      assert(
        old.failed_at && Date.now() - old.failed_at.getTime() >= 172800000,
        "refund_not_due",
        409,
      );
    await c.query("UPDATE principals SET state='resolving' WHERE id=$1", [p.id]);
    return insertOperation(
      c,
      actor ? { ...actor, user_id: account?.user_id ?? actor.user_id } : null,
      {
        kind: mode === "keep" ? "treasury_keep" : "treasury_refund",
        linkId: linkId ?? undefined,
        slotId: slot?.id,
        principalId: p.id,
        request: { destination, amount: p.amount_base_units },
      },
      prepared,
      opId,
    );
  });
  // Server-only signatures; still use the same durable submission/reconciliation path.
  const { submitServerOperation } = await import("./jobs");
  await submitServerOperation(result.operation_id);
  return { operation_id: result.operation_id, state: "processing" };
}
