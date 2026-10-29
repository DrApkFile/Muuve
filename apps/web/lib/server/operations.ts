import { randomUUID } from "node:crypto";
import { Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { PoolClient, QueryResultRow } from "pg";
import type { Session } from "./auth";
import { one, transaction, audit, enqueue } from "./db";
import { assert, AppError } from "./errors";
import { hash } from "./solana/codec";
import { Chain, type Prepared } from "./solana/chain";
import { applyFinalized, applyFailure, reconcileLink } from "./reconcile";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export type OperationContext = {
  kind: string;
  request: Record<string, unknown>;
  linkId?: string;
  slotId?: string;
  payoutId?: string;
  principalId?: string;
};
export async function canAccessOperation(c: PoolClient, op: QueryResultRow, actor: Session) {
  if (op.actor_session_id === actor.id || (!!actor.user_id && op.actor_user_id === actor.user_id))
    return true;
  if (
    ["intent", "claim_keep", "claim_cashout", "treasury_keep"].includes(op.kind) &&
    (actor.purpose === "account" || (actor.purpose === "claim" && actor.link_id === op.link_id))
  ) {
    return !!(await one(
      "SELECT id FROM link_slots WHERE id=$1 AND link_id=$2 AND recipient_phone_e164=$3",
      [op.slot_id, op.link_id, actor.phone_e164],
      c,
    ));
  }
  return false;
}
export async function insertOperation(
  c: PoolClient,
  actor: Session | null,
  context: OperationContext,
  prepared: Prepared,
  id = randomUUID(),
) {
  const fingerprint = hash(canonical(context)).toString("hex");
  await c.query(
    `INSERT INTO operations(id,actor_session_id,actor_user_id,kind,link_id,slot_id,payout_id,principal_id,fingerprint,request,expected_signers)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id,
      actor?.id ?? null,
      actor?.user_id ?? null,
      context.kind,
      context.linkId ?? null,
      context.slotId ?? null,
      context.payoutId ?? null,
      context.principalId ?? null,
      fingerprint,
      context.request,
      JSON.stringify(prepared.expectedSigners),
    ],
  );
  await insertAttempt(c, id, prepared);
  await audit(c, "operation", id, "operation.prepared", { kind: context.kind });
  return operationResult(id, prepared);
}
function operationResult(id: string, p: Prepared) {
  return {
    operation_id: id,
    tx: p.tx,
    signature: p.signature,
    last_valid_block_height: p.lastValidBlockHeight,
    blockhash: p.blockhash,
  };
}
export async function existingOperation(c: PoolClient, actor: Session, context: OperationContext) {
  const op = await one(
    `SELECT * FROM operations WHERE kind=$1 AND slot_id IS NOT DISTINCT FROM $2::uuid AND link_id IS NOT DISTINCT FROM $3::uuid
 AND state IN ('prepared','submitted','confirmed','unknown','held') ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [context.kind, context.slotId ?? null, context.linkId ?? null],
    c,
  );
  if (!op) return;
  assert(await canAccessOperation(c, op, actor), "operation_owned_by_other_session", 409);
  assert(op.fingerprint === hash(canonical(context)).toString("hex"), "operation_conflict", 409);
  return storedOperation(c, op.id);
}
export async function storedOperation(c: PoolClient, id: string) {
  const a = await one(
    "SELECT * FROM transaction_attempts WHERE operation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
    [id],
    c,
  );
  assert(a, "operation_not_ready", 409);
  return {
    operation_id: id,
    tx: a.tx_base64,
    signature: a.signature,
    last_valid_block_height: Number(a.last_valid_block_height),
    blockhash: a.blockhash,
    state: a.state,
  };
}
async function insertAttempt(
  c: PoolClient,
  id: string,
  p: Prepared,
  replacement?: string,
  held = false,
) {
  const attempt = randomUUID();
  await c.query(
    `INSERT INTO transaction_attempts(id,operation_id,replacement_of,message_hash,message_base64,tx_base64,blockhash,last_valid_block_height,signature,state)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      attempt,
      id,
      replacement ?? null,
      hash(Buffer.from(p.message, "base64")).toString("hex"),
      p.message,
      p.tx,
      p.blockhash,
      p.lastValidBlockHeight,
      p.signature,
      held ? "held" : "prepared",
    ],
  );
  return attempt;
}
export function verifyMessage(
  encoded: string,
  a: { message_hash: string; message_base64: string; signature: string },
) {
  let tx: Transaction;
  try {
    assert(Buffer.from(encoded, "base64").length <= 1232, "invalid_transaction");
    tx = Transaction.from(Buffer.from(encoded, "base64"));
  } catch {
    throw new AppError("invalid_transaction");
  }
  const message = tx.serializeMessage();
  assert(
    hash(message).toString("hex") === a.message_hash &&
      message.equals(Buffer.from(a.message_base64, "base64")),
    "transaction_message_mismatch",
    409,
  );
  assert(tx.verifySignatures(true), "invalid_transaction_signatures", 403);
  assert(
    tx.signatures[0]?.signature && bs58.encode(tx.signatures[0].signature) === a.signature,
    "transaction_signature_mismatch",
    403,
  );
  return tx.serialize();
}
export async function submitOperation(
  actor: Session,
  body: { operation_id: string; tx: string; idempotency_key: string },
  expected: { kind?: string; linkId?: string; payoutId?: string } = {},
  chainOverride?: Chain,
) {
  const saved = await transaction(async (c) => {
    const op = await one("SELECT * FROM operations WHERE id=$1 FOR UPDATE", [body.operation_id], c);
    assert(op, "not_found", 404);
    assert(await canAccessOperation(c, op, actor), "forbidden", 403);
    assert(!expected.kind || op.kind === expected.kind, "operation_kind_mismatch", 409);
    assert(!expected.linkId || op.link_id === expected.linkId, "wrong_link", 403);
    assert(!expected.payoutId || op.payout_id === expected.payoutId, "wrong_payout", 403);
    assert(
      !op.idempotency_key || op.idempotency_key === body.idempotency_key,
      "idempotency_conflict",
      409,
    );
    let message: Buffer;
    try {
      message = Transaction.from(Buffer.from(body.tx, "base64")).serializeMessage();
    } catch {
      throw new AppError("invalid_transaction");
    }
    const a = await one<{
      message_hash: string;
      message_base64: string;
      signature: string;
      state: string;
      id: string;
    }>(
      "SELECT * FROM transaction_attempts WHERE operation_id=$1 AND message_hash=$2 FOR UPDATE",
      [op.id, hash(message).toString("hex")],
      c,
    );
    assert(a, "transaction_message_mismatch", 409);
    const raw = verifyMessage(body.tx, a);
    assert(a.state !== "held", "replacement_held_for_reconciliation", 409);
    if (op.state !== "finalized" && op.state !== "failed")
      assert(!["failed", "superseded"].includes(a.state), "attempt_no_longer_submittable", 409);
    await c.query("UPDATE operations SET idempotency_key=$2 WHERE id=$1", [
      op.id,
      body.idempotency_key,
    ]);
    if (op.state === "finalized" || op.state === "failed") return { op, a, raw, terminal: true };
    await c.query(
      "UPDATE transaction_attempts SET tx_base64=$2,state='submitted',updated_at=now() WHERE id=$1",
      [a.id, body.tx],
    );
    await c.query("UPDATE operations SET state='submitted',updated_at=now() WHERE id=$1", [op.id]);
    return { op, a, raw, terminal: false };
  });
  if (saved.terminal)
    return { operation_id: saved.op.id, state: saved.op.state, signature: saved.a.signature };
  const chain = chainOverride ?? new Chain();
  try {
    const signature = await chain.send(saved.raw);
    assert(signature === saved.a.signature, "rpc_signature_mismatch", 503);
  } catch {
    await transaction(async (c) => {
      await c.query("UPDATE operations SET state='unknown' WHERE id=$1", [saved.op.id]);
      await c.query("UPDATE transaction_attempts SET state='unknown' WHERE id=$1", [saved.a.id]);
      await enqueue(c, "reconcile", saved.op.id, `reconcile:${saved.a.id}`);
    });
    const replacement = await prepareReplacement(saved.op.id, chain).catch(async () => {
      await transaction((c) =>
        enqueue(c, "prepare_replacement", saved.op.id, `replace:${saved.a.id}`),
      );
      return { operation_id: saved.op.id, state: "awaiting_rpc" };
    });
    return {
      operation_id: saved.op.id,
      state: "unknown",
      signature: saved.a.signature,
      replacement,
    };
  }
  return reconcileOperation(saved.op.id, chain);
}
export async function prepareReplacement(id: string, chain = new Chain()) {
  const op = await one("SELECT * FROM operations WHERE id=$1", [id]);
  assert(op, "not_found", 404);
  const a = await one(
    "SELECT * FROM transaction_attempts WHERE operation_id=$1 ORDER BY created_at DESC LIMIT 1",
    [id],
  );
  assert(a, "not_found", 404);
  if (a.state === "held" || (a.replacement_of && a.state === "prepared"))
    return { operation_id: id, state: a.state, tx: a.tx_base64 };
  const old = Transaction.from(Buffer.from(a.tx_base64, "base64"));
  // Reconstruct from persisted server-approved instructions, never request-supplied instructions.
  const required = old
    .compileMessage()
    .accountKeys.slice(0, old.compileMessage().header.numRequiredSignatures);
  const all = [chain.keys.payer, chain.keys.attestor, chain.keys.treasury];
  const { historicalKey } = await import("./config");
  for (const requiredKey of required) {
    if (
      all.some((k) => k.publicKey.equals(requiredKey)) ||
      op.expected_signers.includes(requiredKey.toBase58())
    )
      continue;
    for (const role of ["attestor", "treasury"] as const) {
      try {
        all.push(historicalKey(role, requiredKey.toBase58()));
        break;
      } catch {
        /* fail closed if neither keyring has the key */
      }
    }
  }
  if (op.kind === "fund") {
    const { keypair } = await import("./config");
    all.push(keypair("TEST_MINT_AUTHORITY_SECRET"));
  }
  const signers = all.filter(
    (k) =>
      required.some((p) => p.equals(k.publicKey)) &&
      !k.publicKey.equals(chain.keys.payer.publicKey),
  );
  const clientKeys = required.filter((k) => op.expected_signers.includes(k.toBase58()));
  const p = await chain.prepare(old.instructions.slice(0, -1), clientKeys, false, signers);
  // Every emitted transfer/mint is protected by a canonical program receipt.
  // Legacy/unrecognized operations stay held until an operator establishes the outcome.
  const guarded = old.instructions.some((i) => i.programId.equals(chain.program));
  const held = !guarded;
  await transaction(async (c) => {
    await c.query("SELECT id FROM operations WHERE id=$1 FOR UPDATE", [id]);
    const duplicate = await one(
      "SELECT id FROM transaction_attempts WHERE replacement_of=$1",
      [a.id],
      c,
    );
    if (duplicate) return;
    await insertAttempt(c, id, p, a.id, held);
    await audit(c, "operation", id, "operation.replacement_prepared", { held });
  });
  return {
    operation_id: id,
    tx: p.tx,
    state: held ? "held" : "prepared",
    last_valid_block_height: p.lastValidBlockHeight,
  };
}
export async function reconcileOperation(id: string, chain = new Chain()) {
  const op = await one("SELECT * FROM operations WHERE id=$1", [id]);
  assert(op, "not_found", 404);
  if (["finalized", "failed"].includes(op.state)) return { operation_id: id, state: op.state };
  const attempts = (
    await (
      await import("./db")
    )
      .database()
      .query("SELECT * FROM transaction_attempts WHERE operation_id=$1 ORDER BY created_at", [id])
  ).rows;
  let pending = false;
  for (const a of attempts) {
    const status = await chain.status(a.signature);
    if (status?.confirmationStatus === "finalized" && !status.err) {
      await applyFinalized(op, a, chain);
      return { operation_id: id, state: "finalized", signature: a.signature };
    }
    if (status?.err && status.confirmationStatus === "finalized") {
      await transaction((c) =>
        c.query(
          "UPDATE transaction_attempts SET state='failed',error_code='chain_error' WHERE id=$1",
          [a.id],
        ),
      );
      continue;
    }
    if (status?.confirmationStatus === "confirmed") {
      await transaction((c) =>
        c.query("UPDATE operations SET state='confirmed',updated_at=now() WHERE id=$1", [id]),
      );
      pending = true;
      continue;
    }
    const height = await chain.height();
    if (height <= Number(a.last_valid_block_height)) {
      if (a.state !== "held") pending = true;
      continue;
    }
    // A null status after expiry is still reconciled against escrow state before releasing principal.
    await transaction((c) =>
      c.query(
        "UPDATE transaction_attempts SET state='failed',error_code='blockhash_expired' WHERE id=$1",
        [a.id],
      ),
    );
  }
  if (op.link_id) await reconcileLink(op.link_id, chain);
  if (!pending) {
    const held = attempts.find((a) => a.state === "held");
    if (held && (await chain.height()) <= Number(held.last_valid_block_height)) {
      // An unrecognized legacy transfer has no on-chain idempotency receipt.
      // Operator reconciliation is required; absence from an RPC is insufficient.
      return { operation_id: id, state: "held" };
    }
    if (await chain.effectExists(op)) {
      await transaction(async (c) => {
        await c.query("UPDATE operations SET state='unknown' WHERE id=$1", [id]);
        await audit(c, "operation", id, "operation.effect_requires_signature_reconciliation");
      });
      return { operation_id: id, state: "unknown" };
    }
    await applyFailure(op);
    return { operation_id: id, state: "failed" };
  }
  return { operation_id: id, state: "pending" };
}
