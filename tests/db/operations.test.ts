import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupEnv, reset, seed, makeSession, prepared, signPrepared } from "../helpers";
import { transaction, one, closeDatabase } from "../../apps/web/lib/server/db";
import { insertOperation, submitOperation } from "../../apps/web/lib/server/operations";
import { Chain } from "../../apps/web/lib/server/solana/chain";
setupEnv();
describe.skipIf(process.env.MUUVE_TEST_DB !== "1")(
  "durable transaction operations with fault-injected RPC",
  () => {
    beforeEach(reset);
    afterAll(closeDatabase);
    it("persists a signature before broadcast and rejects another actor", async () => {
      const f = await seed(),
        s = await makeSession("account", f.user.phone_e164, f.user.id, null),
        p = prepared();
      const op = await transaction((c) =>
        insertOperation(c, s.session, { kind: "recall", linkId: f.link.id, request: {} }, p),
      );
      expect(
        (
          await one("SELECT signature FROM transaction_attempts WHERE operation_id=$1", [
            op.operation_id,
          ])
        )?.signature,
      ).toBe(p.signature);
      const stranger = await makeSession("claim", f.slot.recipient_phone_e164, null, f.link.id);
      await expect(
        submitOperation(stranger.session, {
          operation_id: op.operation_id,
          tx: signPrepared(p),
          idempotency_key: "key-one-one",
        }),
      ).rejects.toThrow("forbidden");
    });
    it("prepares a replacement immediately after timeout and preserves the original unknown result", async () => {
      const f = await seed(),
        s = await makeSession("account", f.user.phone_e164, f.user.id, null),
        p = prepared(),
        replacement = prepared();
      const op = await transaction((c) =>
        insertOperation(c, s.session, { kind: "recall", linkId: f.link.id, request: {} }, p),
      );
      const chain = new Chain();
      vi.spyOn(chain, "send").mockRejectedValue(new Error("timeout"));
      const build = vi.spyOn(chain, "prepare").mockResolvedValue(replacement);
      const result = await submitOperation(
        s.session,
        { operation_id: op.operation_id, tx: signPrepared(p), idempotency_key: "key-two-two" },
        {},
        chain,
      );
      expect(result.state).toBe("unknown");
      expect(build).toHaveBeenCalledOnce();
      expect(
        (
          await one("SELECT count(*) FROM transaction_attempts WHERE operation_id=$1", [
            op.operation_id,
          ])
        )?.count,
      ).toBe("2");
      expect(
        (await one("SELECT state FROM operations WHERE id=$1", [op.operation_id]))?.state,
      ).toBe("unknown");
    });
  },
);
