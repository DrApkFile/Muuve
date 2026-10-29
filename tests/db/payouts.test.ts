import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setupEnv, reset, seed, makeSession, prepared, payer, treasury, mint } from "../helpers";
import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Chain, ata } from "../../apps/web/lib/server/solana/chain";
import { runJobs } from "../../apps/web/lib/server/jobs";
import { transaction, one, closeDatabase } from "../../apps/web/lib/server/db";
import { transition } from "../../apps/web/lib/server/state";
import {
  dispatchPayout,
  receiveWebhook,
  quote,
  retryPayout,
  resolvePrincipal,
} from "../../apps/web/lib/server/payouts";
import { MockPayoutProvider, signWebhook } from "../../apps/web/lib/server/providers/payout";
setupEnv();
async function fixture(fail = false, source: "escrow_claim" | "wallet" = "escrow_claim") {
  const f = await seed(),
    session =
      source === "escrow_claim"
        ? (await makeSession("claim", f.slot.recipient_phone_e164, null, f.link.id)).session
        : (await makeSession("account", f.user.phone_e164, f.user.id, null)).session;
  const result = await transaction(async (c) => {
    if (source === "escrow_claim") await transition(c, "link_slots", f.slot.id, "cashing_out");
    const principal = await one(
      `INSERT INTO principals(source,link_slot_id,user_id,owner_phone,sender_wallet,amount_base_units,state,treasury_owner,treasury_account)
   VALUES($1,$2,$3,$4,$5,1000000,'treasury',$6,$7) RETURNING *`,
      [
        source,
        source === "escrow_claim" ? f.slot.id : null,
        source === "wallet" ? f.user.id : null,
        session.phone_e164,
        f.link.sender_wallet,
        treasury.publicKey.toBase58(),
        ata(treasury.publicKey, mint, TOKEN_PROGRAM_ID).toBase58(),
      ],
      c,
    );
    const q = await one(
      "INSERT INTO quotes(actor_session_id,principal_id,amount_base_units,rate,amount_ngn_kobo,expires_at) VALUES($1,$2,1000000,1504.8,150480,now()+interval '60 seconds') RETURNING *",
      [session.id, principal!.id],
      c,
    );
    const payout = await one(
      "INSERT INTO payouts(principal_id,quote_id,bank_code,account_number,account_name,status,provider,provider_key) VALUES($1,$2,'100004',$4,'Mock Name','processing','mock',$3) RETURNING *",
      [principal!.id, q!.id, randomUUID(), fail ? "1234560000" : "1234567890"],
      c,
    );
    await c.query("UPDATE principals SET active_payout_id=$2 WHERE id=$1", [
      principal!.id,
      payout!.id,
    ]);
    return { principal: principal!, payout: payout! };
  });
  return { ...f, ...result, session };
}
async function notify(
  payout: string,
  ref: string,
  status: "paid" | "failed",
  event = randomUUID(),
) {
  const raw = JSON.stringify({ event_id: event, payout_id: payout, provider_ref: ref, status }),
    s = signWebhook(raw);
  return receiveWebhook(raw, s.timestamp, s.signature);
}
describe.skipIf(process.env.MUUVE_TEST_DB !== "1")("durable mock payouts and recovery", () => {
  beforeEach(reset);
  afterEach(() => vi.restoreAllMocks());
  afterAll(closeDatabase);
  it.each([false, true])(
    "worker advances durable provider and webhook jobs (failure=%s)",
    async (fail) => {
      const f = await fixture(fail);
      await transaction((c) =>
        c.query("INSERT INTO jobs(kind,entity_id,dedupe_key) VALUES('payout',$1,$2)", [
          f.payout.id,
          `worker-payout:${f.payout.id}`,
        ]),
      );
      await runJobs();
      expect(
        (await one("SELECT provider_ref FROM payouts WHERE id=$1", [f.payout.id]))?.provider_ref,
      ).toBeTruthy();
      await transaction(async (c) => {
        await c.query(
          "UPDATE mock_provider_transfers SET ready_at=now()-interval '1 second' WHERE payout_id=$1",
          [f.payout.id],
        );
        await c.query(
          "UPDATE jobs SET run_after=now()-interval '1 second' WHERE entity_id=$1 AND kind='mock_webhook'",
          [f.payout.id],
        );
      });
      await Promise.all([runJobs(), runJobs()]);
      expect((await one("SELECT status FROM payouts WHERE id=$1", [f.payout.id]))?.status).toBe(
        fail ? "failed" : "paid",
      );
      expect(
        (await one("SELECT count(*) FROM webhook_inbox WHERE payout_id=$1", [f.payout.id]))?.count,
      ).toBe("1");
    },
  );
  function resolutionRpc(f: Awaited<ReturnType<typeof fixture>>) {
    vi.spyOn(Chain.prototype, "readiness").mockResolvedValue({} as never);
    const tx = { ...prepared(payer), expectedSigners: [] };
    const transfer = vi.spyOn(Chain.prototype, "tokenTransfer").mockResolvedValue(tx);
    vi.spyOn(Chain.prototype, "send").mockResolvedValue(tx.signature);
    vi.spyOn(Chain.prototype, "status").mockResolvedValue({
      slot: 1,
      confirmations: null,
      err: null,
      confirmationStatus: "finalized",
    });
    vi.spyOn(Chain.prototype, "link").mockResolvedValue({
      linkId: f.link.link_id_hex,
      sender: f.link.sender_wallet,
      rentPayer: payer.publicKey.toBase58(),
      claimPubkey: f.link.claim_pubkey,
      mint: mint.toBase58(),
      tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
      attestor: Keypair.generate().publicKey.toBase58(),
      treasury: ata(treasury.publicKey, mint, TOKEN_PROGRAM_ID).toBase58(),
      treasuryOwner: treasury.publicKey.toBase58(),
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(f.link.expires_at.getTime() / 1000),
      total: "1000000",
      slotCount: 1,
      openSlots: 0,
      bump: 255,
      slots: [
        {
          amount: "1000000",
          status: 2,
          intentId: randomUUID().replaceAll("-", ""),
          version: "1",
          priorityUntil: 0,
          destination: ata(treasury.publicKey, mint, TOKEN_PROGRAM_ID).toBase58(),
          toTreasury: true,
        },
      ],
    });
    return transfer;
  }
  it.each(["keep", "refund"] as const)(
    "resolves a failed escrow payout to the exact %s destination with fault-injected RPC",
    async (mode) => {
      const f = await fixture(true);
      await dispatchPayout(f.payout.id);
      const original = await one("SELECT provider_ref FROM payouts WHERE id=$1", [f.payout.id]);
      await notify(f.payout.id, original!.provider_ref, "failed");
      let account;
      let destination = f.link.sender_wallet;
      if (mode === "keep") {
        destination = Keypair.generate().publicKey.toBase58();
        const user = await transaction((c) =>
          one(
            "INSERT INTO users(phone_e164,display_name,auth_origin,wallet_address) VALUES($1,'Recipient','muuve',$2) RETURNING id",
            [f.session.phone_e164, destination],
            c,
          ),
        );
        account = (await makeSession("account", f.session.phone_e164, user!.id, null)).session;
      } else
        await transaction((c) =>
          c.query("UPDATE payouts SET failed_at=now()-interval '49 hours' WHERE id=$1", [
            f.payout.id,
          ]),
        );
      const transfer = resolutionRpc(f);
      await resolvePrincipal(
        mode === "keep" ? f.session : null,
        f.link.id,
        mode,
        account,
        f.principal.id,
      );
      expect(transfer).toHaveBeenCalledWith(
        "treasury",
        treasury.publicKey.toBase58(),
        destination,
        "1000000",
        expect.any(String),
      );
      expect((await one("SELECT state FROM principals WHERE id=$1", [f.principal.id]))?.state).toBe(
        mode === "keep" ? "kept" : "refunded",
      );
      expect(
        (await one("SELECT resolution FROM payouts WHERE id=$1", [f.payout.id]))?.resolution,
      ).toBe(mode === "keep" ? "kept_in_dollars" : "refunded_to_sender");
    },
  );
  it("automatically returns a failed wallet payout to its original wallet with fault-injected RPC", async () => {
    const f = await fixture(true, "wallet");
    await dispatchPayout(f.payout.id);
    const original = await one("SELECT provider_ref FROM payouts WHERE id=$1", [f.payout.id]);
    await notify(f.payout.id, original!.provider_ref, "failed");
    const transfer = resolutionRpc(f);
    await runJobs();
    expect(transfer).toHaveBeenCalledWith(
      "treasury",
      treasury.publicKey.toBase58(),
      f.link.sender_wallet,
      "1000000",
      expect.any(String),
    );
    expect(
      (await one("SELECT resolution FROM payouts WHERE id=$1", [f.payout.id]))?.resolution,
    ).toBe("returned_to_wallet");
  });
  it("immediately retries a timed-out provider with the same key and only one transfer", async () => {
    const f = await fixture(),
      real = new MockPayoutProvider();
    let attempts = 0;
    const provider = {
      safeIdempotency: true,
      status: real.status.bind(real),
      createPayout: async (p: Parameters<typeof real.createPayout>[0]) => {
        attempts++;
        const result = await real.createPayout(p);
        if (attempts === 1) throw new Error("response_lost");
        return result;
      },
    };
    await dispatchPayout(f.payout.id, provider);
    expect(attempts).toBe(2);
    expect((await one("SELECT count(*) FROM mock_provider_transfers"))?.count).toBe("1");
    expect((await one("SELECT count(*) FROM provider_attempts"))?.count).toBe("2");
  });
  it("quarantines a timeout when safe provider idempotency is unavailable", async () => {
    const f = await fixture();
    let calls = 0;
    await dispatchPayout(f.payout.id, {
      safeIdempotency: false,
      createPayout: async () => {
        calls++;
        throw new Error("timeout");
      },
      status: async () => undefined,
    });
    expect(calls).toBe(1);
    expect((await one("SELECT state FROM principals WHERE id=$1", [f.principal.id]))?.state).toBe(
      "quarantined",
    );
  });
  it("recovers the provider reference after both immediate attempts lose their response", async () => {
    const f = await fixture(),
      real = new MockPayoutProvider();
    await dispatchPayout(f.payout.id, {
      safeIdempotency: true,
      status: real.status.bind(real),
      createPayout: async (p) => {
        await real.createPayout(p);
        throw new Error("response_lost");
      },
    });
    const stored = await one("SELECT provider_ref FROM payouts WHERE id=$1", [f.payout.id]);
    expect(stored?.provider_ref).toBe(`mock-${f.payout.provider_key}`);
    expect((await one("SELECT count(*) FROM jobs WHERE kind='provider_reconcile'"))?.count).toBe(
      "1",
    );
  });
  it("ignores old failure repeats and keeps contradictory outcomes quarantined", async () => {
    const f = await fixture();
    await dispatchPayout(f.payout.id);
    const original = await one("SELECT provider_ref FROM payouts WHERE id=$1", [f.payout.id]);
    await notify(f.payout.id, original!.provider_ref, "failed");
    const q = await quote(f.session, { retry_of: f.payout.id }, f.link.id);
    const next = await retryPayout(f.session, f.link.id, {
      quote_id: q.quote_id,
      bank_code: "100004",
      account_number: "1234567891",
      idempotency_key: "retry-conflict-test",
    });
    await notify(f.payout.id, original!.provider_ref, "failed");
    expect((await one("SELECT state FROM principals WHERE id=$1", [f.principal.id]))?.state).toBe(
      "treasury",
    );
    await dispatchPayout(next.payout!.id);
    const replacement = await one("SELECT provider_ref FROM payouts WHERE id=$1", [
      next.payout!.id,
    ]);
    await notify(f.payout.id, original!.provider_ref, "paid");
    await notify(next.payout!.id, replacement!.provider_ref, "paid");
    const principal = await one("SELECT state,quarantine_reason FROM principals WHERE id=$1", [
      f.principal.id,
    ]);
    expect(principal?.state).toBe("quarantined");
    expect(principal?.quarantine_reason).toBe("provider_conflict");
    expect((await one("SELECT status FROM links WHERE id=$1", [f.link.id]))?.status).toBe("open");
  });
  it("does not downgrade an existing provider conflict when an in-flight dispatch times out", async () => {
    const f = await fixture(true);
    await dispatchPayout(f.payout.id);
    const original = await one("SELECT provider_ref FROM payouts WHERE id=$1", [f.payout.id]);
    await notify(f.payout.id, original!.provider_ref, "failed");
    const q = await quote(f.session, { retry_of: f.payout.id }, f.link.id),
      next = await retryPayout(f.session, f.link.id, {
        quote_id: q.quote_id,
        bank_code: "100004",
        account_number: "1234567891",
        idempotency_key: "conflict-race-test",
      });
    await dispatchPayout(next.payout!.id, {
      safeIdempotency: false,
      status: async () => undefined,
      createPayout: async () => {
        await notify(f.payout.id, original!.provider_ref, "paid");
        throw new Error("response_lost");
      },
    });
    expect(
      (await one("SELECT quarantine_reason FROM principals WHERE id=$1", [f.principal.id]))
        ?.quarantine_reason,
    ).toBe("provider_conflict");
  });
  it("deduplicates signed webhooks and settles only after payment is terminal", async () => {
    const f = await fixture();
    await dispatchPayout(f.payout.id);
    const p = await one("SELECT provider_ref FROM payouts WHERE id=$1", [f.payout.id]),
      event = randomUUID();
    await notify(f.payout.id, p!.provider_ref, "paid", event);
    await notify(f.payout.id, p!.provider_ref, "paid", event);
    expect((await one("SELECT count(*) FROM webhook_inbox"))?.count).toBe("1");
    expect((await one("SELECT status FROM link_slots WHERE id=$1", [f.slot.id]))?.status).toBe(
      "cashed_out",
    );
    expect((await one("SELECT status FROM links WHERE id=$1", [f.link.id]))?.status).toBe(
      "settled",
    );
  });
  it("retries a failed payout without a second escrow release and handles repeated retry requests", async () => {
    const f = await fixture();
    await dispatchPayout(f.payout.id);
    const p = await one("SELECT provider_ref FROM payouts WHERE id=$1", [f.payout.id]);
    await notify(f.payout.id, p!.provider_ref, "failed");
    const q = await quote(f.session, { retry_of: f.payout.id }, f.link.id),
      body = {
        quote_id: q.quote_id,
        bank_code: "100004",
        account_number: "1234567891",
        idempotency_key: "retry-key-one",
      };
    const results = await Promise.all([
      retryPayout(f.session, f.link.id, body),
      retryPayout(f.session, f.link.id, body),
    ]);
    expect(results[0].payout?.id).toBe(results[1].payout?.id);
    expect((await one("SELECT count(*) FROM payouts"))?.count).toBe("2");
    expect((await one("SELECT count(*) FROM operations"))?.count).toBe("0");
  });
});
