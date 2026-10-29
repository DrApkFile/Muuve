import { randomUUID } from "node:crypto";
import { LIMITS } from "@muuve/shared";
import type { Session } from "./auth";
import { transaction, one } from "./db";
import { assert } from "./errors";
import { userFor } from "./links";
import { Chain } from "./solana/chain";
import { insertOperation, storedOperation } from "./operations";
export async function fund(actor: Session, amount: string, key: string, cleva = false) {
  assert(process.env.SOLANA_CLUSTER === "devnet", "devnet_required", 503);
  const user = await userFor(actor);
  assert(user.wallet_address, "wallet_required", 409);
  if (cleva) assert(user.auth_origin === "cleva_preview", "preview_account_required", 403);
  assert(BigInt(amount) > 0n && BigInt(amount) <= LIMITS.dailyFunding, "funding_limit");
  const id = randomUUID(),
    chain = new Chain(),
    prepared = await chain.fund(user.wallet_address, amount, id);
  const result = await transaction(async (c) => {
    await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [user.id]);
    const previous = await one(
      "SELECT * FROM operations WHERE actor_user_id=$1 AND kind='fund' AND request->>'key'=$2",
      [user.id, key],
      c,
    );
    if (previous) {
      assert(previous.request.amount === amount, "idempotency_conflict", 409);
      return storedOperation(c, previous.id);
    }
    const total = await one(
      "SELECT COALESCE(sum(amount_base_units),0)::text AS total FROM funding_reservations WHERE user_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date AND state!='released'",
      [user.id],
      c,
    );
    assert(BigInt(total!.total) + BigInt(amount) <= LIMITS.dailyFunding, "funding_limit", 429);
    const op = await insertOperation(
      c,
      actor,
      { kind: "fund", request: { amount, key } },
      prepared,
      id,
    );
    await c.query(
      "INSERT INTO funding_reservations(operation_id,user_id,amount_base_units) VALUES($1,$2,$3)",
      [id, user.id, amount],
    );
    return op;
  });
  const { submitServerOperation } = await import("./jobs");
  await submitServerOperation(result.operation_id);
  return {
    operation_id: result.operation_id,
    state: "processing",
    source: cleva ? "cleva_preview" : "demo",
    test_token: true,
  };
}
