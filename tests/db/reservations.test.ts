import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setupEnv, reset, makeSession, prepared, sender, payer } from "../helpers";
import { transaction, one, closeDatabase } from "../../apps/web/lib/server/db";
import { createLink } from "../../apps/web/lib/server/links";
import { fund } from "../../apps/web/lib/server/funding";
import { Chain } from "../../apps/web/lib/server/solana/chain";
setupEnv();
async function actor() {
  const u = await transaction((c) =>
    one(
      "INSERT INTO users(phone_e164,display_name,auth_origin,wallet_address) VALUES('+2348030000001','Sender','muuve',$1) RETURNING *",
      [sender.publicKey.toBase58()],
      c,
    ),
  );
  return (await makeSession("account", u!.phone_e164, u!.id, null)).session;
}
describe.skipIf(process.env.MUUVE_TEST_DB !== "1")(
  "transactional capacity with fault-injected chain",
  () => {
    beforeEach(reset);
    afterEach(() => vi.restoreAllMocks());
    afterAll(closeDatabase);
    it("counts concurrent preparations against outstanding and balance capacity", async () => {
      const s = await actor();
      vi.spyOn(Chain.prototype, "readiness").mockResolvedValue({
        maxLink: "1000000000",
        maxSlot: "500000000",
      } as never);
      vi.spyOn(Chain.prototype, "balance").mockResolvedValue("1000000000");
      vi.spyOn(Chain.prototype, "create").mockImplementation(async () => prepared());
      const recipients = [
        { phone_e164: "+2348030000002", amount_base_units: "300000000" },
        { phone_e164: "+2348030000003", amount_base_units: "300000000" },
      ];
      const results = await Promise.allSettled(
        [1, 2].map(() =>
          createLink(s, {
            link_id_hex: randomUUID().replaceAll("-", ""),
            claim_pubkey: sender.publicKey.toBase58(),
            recipients,
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (
          await one(
            "SELECT sum(total_base_units)::text AS total FROM links WHERE capacity_state='reserved'",
          )
        )?.total,
      ).toBe("600000000");
    });
    it("returns the existing prepared create operation on identical retries", async () => {
      const s = await actor();
      vi.spyOn(Chain.prototype, "readiness").mockResolvedValue({
        maxLink: "1000000000",
        maxSlot: "500000000",
      } as never);
      vi.spyOn(Chain.prototype, "balance").mockResolvedValue("1000000000");
      vi.spyOn(Chain.prototype, "create").mockImplementation(async () => prepared());
      const input = {
        link_id_hex: randomUUID().replaceAll("-", ""),
        claim_pubkey: sender.publicKey.toBase58(),
        recipients: [{ phone_e164: "+2348030000002", amount_base_units: "1000000" }],
      };
      const a = await createLink(s, input),
        b = await createLink(s, input);
      expect(a.operation_id).toBe(b.operation_id);
      expect((await one("SELECT count(*) FROM operations"))?.count).toBe("1");
    });
    it("reserves the daily funding allowance atomically before any mint submission", async () => {
      const s = await actor();
      vi.spyOn(Chain.prototype, "fund").mockImplementation(async () => ({
        ...prepared(payer),
        expectedSigners: [],
      }));
      vi.spyOn(Chain.prototype, "send").mockResolvedValue("test-signature");
      vi.spyOn(Chain.prototype, "status").mockResolvedValue(null);
      vi.spyOn(Chain.prototype, "height").mockResolvedValue(100);
      const results = await Promise.allSettled([
        fund(s, "150000000", "funding-one"),
        fund(s, "150000000", "funding-two"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (
          await one(
            "SELECT sum(amount_base_units)::text AS total FROM funding_reservations WHERE state='reserved'",
          )
        )?.total,
      ).toBe("150000000");
    });
  },
);
