import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { database, transaction, one, closeDatabase, audit } from "../../apps/web/lib/server/db";
import { transition, settleLink } from "../../apps/web/lib/server/state";
import { setupEnv, reset, seed, makeSession, prepared } from "../helpers";
import { insertOperation } from "../../apps/web/lib/server/operations";
setupEnv();
describe.skipIf(process.env.MUUVE_TEST_DB !== "1")("real Postgres invariants", () => {
  beforeEach(reset);
  afterAll(closeDatabase);
  it("rolls back incomplete link allocations", async () => {
    const f = await seed();
    await expect(
      transaction((c) => c.query("UPDATE links SET total_base_units=2 WHERE id=$1", [f.link.id])),
    ).rejects.toThrow("immutable link terms");
    expect(
      (await one("SELECT total_base_units FROM links WHERE id=$1", [f.link.id]))?.total_base_units,
    ).toBe("1000000");
  });
  it("prevents funded allocation or membership rewrites", async () => {
    const f = await seed();
    await expect(
      database().query("UPDATE link_slots SET amount_base_units=2 WHERE id=$1", [f.slot.id]),
    ).rejects.toThrow("immutable slot allocation");
  });
  it("keeps events atomic with transitions and rejects illegal terminal changes", async () => {
    const f = await seed();
    await expect(
      transaction(async (c) => {
        await transition(c, "link_slots", f.slot.id, "kept");
        throw new Error("crash");
      }),
    ).rejects.toThrow("crash");
    expect((await one("SELECT status FROM link_slots WHERE id=$1", [f.slot.id]))?.status).toBe(
      "funded",
    );
    expect((await one("SELECT count(*) FROM events"))?.count).toBe("0");
    await transaction((c) => transition(c, "link_slots", f.slot.id, "kept"));
    await expect(
      transaction((c) => transition(c, "link_slots", f.slot.id, "recalled")),
    ).rejects.toThrow("invalid_transition");
  });
  it("allows identical local IDs under different senders only", async () => {
    await seed();
    await seed({ senderPhone: "+2348030000003", wallet: "11111111111111111111111111111112" });
    expect((await one("SELECT count(*) FROM links"))?.count).toBe("2");
  });
  it("does not settle an unresolved payout even when escrow slots are terminal", async () => {
    const f = await seed();
    await transaction(async (c) => {
      await transition(c, "link_slots", f.slot.id, "kept");
      await c.query(
        "INSERT INTO principals(source,link_slot_id,owner_phone,sender_wallet,amount_base_units,state) VALUES('escrow_claim',$1,$2,$3,1000000,'treasury')",
        [f.slot.id, f.slot.recipient_phone_e164, f.link.sender_wallet],
      );
      await settleLink(c, f.link.id);
    });
    expect((await one("SELECT status FROM links WHERE id=$1", [f.link.id]))?.status).toBe("open");
  });
  it("rejects a duplicate active operation under concurrent inserts", async () => {
    const f = await seed(),
      s = await makeSession("claim", f.slot.recipient_phone_e164, null, f.link.id);
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        transaction((c) =>
          insertOperation(
            c,
            s.session,
            { kind: "intent", linkId: f.link.id, slotId: f.slot.id, request: {} },
            prepared(),
          ),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
  it("makes audit records append only", async () => {
    const id = randomUUID();
    await transaction((c) => audit(c, "test", id, "test.done"));
    await expect(database().query("DELETE FROM events WHERE entity_id=$1", [id])).rejects.toThrow(
      "events are append only",
    );
  });
  it("rejects incomplete cross-row allocation accounting at commit", async () => {
    const f = await seed(),
      local = randomUUID().replaceAll("-", "");
    await expect(
      transaction(async (c) => {
        const l = await one(
          "INSERT INTO links(sender_user_id,sender_wallet,link_id_hex,pda,claim_pubkey,kind,total_base_units,slot_count) VALUES($1,$2,$3,$4,$5,'batch',200,2) RETURNING id",
          [f.user.id, f.user.wallet_address, local, `fixture-${local}`, f.link.claim_pubkey],
          c,
        );
        await c.query(
          "INSERT INTO link_slots(link_id,slot_index,recipient_phone_e164,amount_base_units) VALUES($1,0,'+2348030000002',100)",
          [l!.id],
        );
      }),
    ).rejects.toThrow("invalid fixed allocation accounting");
    expect((await one("SELECT count(*) FROM links"))?.count).toBe("1");
  });
  it("enforces RLS default denial even when a client role has SELECT privileges", async () => {
    await seed();
    await database().query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='muuve_untrusted_test') THEN CREATE ROLE muuve_untrusted_test; END IF; END $$",
    );
    await database().query(
      "GRANT USAGE ON SCHEMA muuve TO muuve_untrusted_test; GRANT SELECT ON muuve.users TO muuve_untrusted_test",
    );
    const visible = await transaction(async (c) => {
      await c.query("SET LOCAL ROLE muuve_untrusted_test");
      return one("SELECT count(*) FROM users", [], c);
    });
    expect(visible?.count).toBe("0");
  });
});
