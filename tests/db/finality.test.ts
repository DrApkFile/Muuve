import { describe, it, expect, beforeEach, afterAll, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { setupEnv, reset, seed, makeSession, prepared } from "../helpers";
import { transaction, one, closeDatabase } from "../../apps/web/lib/server/db";
import { Chain } from "../../apps/web/lib/server/solana/chain";
import { insertOperation, reconcileOperation } from "../../apps/web/lib/server/operations";
import { assertCanAttestClaim } from "../../apps/web/lib/server/claims";
import { reconcileLink } from "../../apps/web/lib/server/reconcile";
import { PublicKey } from "@solana/web3.js";
setupEnv();
describe.skipIf(process.env.MUUVE_TEST_DB !== "1")(
  "finality policy and attestor boundaries",
  () => {
    beforeEach(reset);
    afterEach(() => vi.restoreAllMocks());
    afterAll(closeDatabase);
    it.each([false, true])(
      "retains the funding signature when link state opens before receipt reconciliation (operation already finalized=%s)",
      async (alreadyFinalized) => {
        const f = await seed();
        const actor = (await makeSession("account", f.user.phone_e164, f.user.id, null)).session;
        const funding = prepared();
        const op = await transaction((c) =>
          insertOperation(c, actor, { kind: "create", linkId: f.link.id, request: {} }, funding),
        );
        const chain = new Chain();
        vi.spyOn(chain, "link").mockResolvedValue({
          linkId: f.link.link_id_hex,
          sender: f.link.sender_wallet,
          claimPubkey: f.link.claim_pubkey,
          total: f.link.total_base_units,
          slotCount: 1,
          openSlots: 1,
          createdAt: 1,
          expiresAt: Math.floor(new Date(f.link.expires_at).getTime() / 1000),
          slots: [
            {
              amount: f.slot.amount_base_units,
              status: 1,
              intentId: "00".repeat(16),
              version: "0",
              priorityUntil: 0,
              destination: PublicKey.default.toBase58(),
              toTreasury: false,
            },
          ],
          rentPayer: PublicKey.default.toBase58(),
          mint: process.env.USDT_MINT!,
          tokenProgram: process.env.TOKEN_PROGRAM_ID!,
          attestor: PublicKey.default.toBase58(),
          treasury: process.env.TREASURY_TOKEN_ACCOUNT!,
          treasuryOwner: PublicKey.default.toBase58(),
          bump: 1,
        });
        vi.spyOn(chain, "status").mockResolvedValue({
          slot: 1,
          confirmations: null,
          err: null,
          confirmationStatus: "finalized",
        });
        if (alreadyFinalized) {
          await transaction(async (c) => {
            await c.query("UPDATE operations SET state='finalized' WHERE id=$1", [op.operation_id]);
            await c.query(
              "UPDATE transaction_attempts SET state='finalized' WHERE operation_id=$1",
              [op.operation_id],
            );
          });
          await reconcileLink(f.link.id, chain);
        } else await reconcileOperation(op.operation_id, chain);
        expect(
          await one("SELECT status,create_sig FROM links WHERE id=$1", [f.link.id]),
        ).toMatchObject({ status: "open", create_sig: funding.signature });
      },
    );
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
