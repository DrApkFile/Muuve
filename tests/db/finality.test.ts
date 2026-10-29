import { describe, it, expect, beforeEach, afterAll, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { setupEnv, reset, seed, makeSession, prepared } from "../helpers";
import { transaction, one, closeDatabase } from "../../apps/web/lib/server/db";
import { Chain } from "../../apps/web/lib/server/solana/chain";
import { insertOperation, reconcileOperation } from "../../apps/web/lib/server/operations";
import { assertCanAttestClaim } from "../../apps/web/lib/server/claims";
setupEnv();
describe.skipIf(process.env.MUUVE_TEST_DB !== "1")(
  "finality policy and attestor boundaries",
  () => {
    beforeEach(reset);
    afterEach(() => vi.restoreAllMocks());
    afterAll(closeDatabase);
    it("rejects wrong-account phones and expired eligibility before signing", async () => {
      const f = await seed({ expired: true }),
        claim = (await makeSession("claim", f.slot.recipient_phone_e164, null, f.link.id)).session,
        wrong = (await makeSession("account", f.user.phone_e164, f.user.id, null)).session;
      await expect(assertCanAttestClaim(claim, f.link.id, { account: wrong })).rejects.toThrow(
        "account_phone_mismatch",
      );
      await expect(assertCanAttestClaim(claim, f.link.id)).rejects.toThrow("link_expired");
    });
    it("enqueues no fiat payout at confirmed and exactly one after finalized", async () => {
      const f = await seed(),
        actor = (await makeSession("account", f.user.phone_e164, f.user.id, null)).session;
      const op = await transaction(async (c) => {
        const principal = await one(
          "INSERT INTO principals(source,user_id,owner_phone,sender_wallet,amount_base_units) VALUES('wallet',$1,$2,$3,1000000) RETURNING *",
          [f.user.id, f.user.phone_e164, f.user.wallet_address],
          c,
        );
        const q = await one(
          "INSERT INTO quotes(actor_session_id,principal_id,amount_base_units,rate,amount_ngn_kobo,expires_at) VALUES($1,$2,1000000,1500,150000,now()+interval '60 seconds') RETURNING id",
          [actor.id, principal!.id],
          c,
        );
        const payout = await one(
          "INSERT INTO payouts(principal_id,quote_id,bank_code,account_number,account_name,status,provider,provider_key) VALUES($1,$2,'100004','1234567890','Mock','transferring','mock',$3) RETURNING id",
          [principal!.id, q!.id, randomUUID()],
          c,
        );
        await c.query("UPDATE principals SET active_payout_id=$2 WHERE id=$1", [
          principal!.id,
          payout!.id,
        ]);
        return insertOperation(
          c,
          actor,
          {
            kind: "wallet_payout",
            payoutId: payout!.id,
            principalId: principal!.id,
            request: { amount: "1000000" },
          },
          prepared(),
        );
      });
      const chain = new Chain(),
        status = vi.spyOn(chain, "status").mockResolvedValue({
          slot: 1,
          confirmations: 1,
          err: null,
          confirmationStatus: "confirmed",
        });
      await reconcileOperation(op.operation_id, chain);
      expect((await one("SELECT count(*) FROM jobs WHERE kind='payout'"))?.count).toBe("0");
      status.mockResolvedValue({
        slot: 1,
        confirmations: null,
        err: null,
        confirmationStatus: "finalized",
      });
      await reconcileOperation(op.operation_id, chain);
      await reconcileOperation(op.operation_id, chain);
      expect((await one("SELECT count(*) FROM jobs WHERE kind='payout'"))?.count).toBe("1");
    });
  },
);
