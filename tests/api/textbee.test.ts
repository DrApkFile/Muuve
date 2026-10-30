import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setupEnv, reset, seed } from "../helpers";
import { database, closeDatabase } from "../../apps/web/lib/server/db";
import { handle } from "../../apps/web/lib/server/router";

setupEnv();
const device = "1234567890abcdef12345678",
  messages = new Map<string, string>();
function request(path: string, body?: unknown, cookie?: string) {
  return handle(
    new Request(`https://muuve.test/api/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin: "https://muuve.test",
        "content-type": "application/json",
        "x-forwarded-for": "192.0.2.5",
        ...(cookie ? { cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}
async function send(phone: string, link?: string) {
  const response = await request("auth/otp/send", {
    phone_e164: phone,
    channel: "sms",
    purpose: link ? "claim" : "account",
    ...(link ? { link_id: link } : {}),
  });
  expect(response.status).toBe(200);
  return (await response.json()).challenge_id as string;
}
async function verify(id: string, phone: string) {
  return request("auth/otp/verify", { challenge_id: id, code: messages.get(phone) });
}
describe.skipIf(process.env.MUUVE_TEST_DB !== "1")(
  "Textbee-backed OTP with disposable PostgreSQL and simulated SMS transport",
  () => {
    beforeEach(async () => {
      await reset();
      setupEnv();
      messages.clear();
      vi.stubEnv("OTP_PROVIDER", "textbee");
      vi.stubEnv("TEXTBEE_API_KEY", "local-transport-test");
      vi.stubEnv("TEXTBEE_DEVICE_ID", device);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init) => {
          const body = JSON.parse(init.body);
          messages.set(body.recipients[0], body.message.match(/\b\d{6}\b/)[0]);
          return Response.json({ data: { success: true, smsBatchId: device, recipientCount: 1 } });
        }),
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });
    afterAll(closeDatabase);
    it("independently authorizes two fixed batch slots without exposing batch membership", async () => {
      const second = "+2348030000003",
        f = await seed({
          recipients: [
            { phone: "+2348030000002", amount: "100000" },
            { phone: second, amount: "200000" },
          ],
        });
      const a = await send(f.slot.recipient_phone_e164, f.link.id),
        b = await send(second, f.link.id);
      for (const [id, phone, index, amount] of [
        [a, f.slot.recipient_phone_e164, 0, "100000"],
        [b, second, 1, "200000"],
      ] as const) {
        const verified = await verify(id, phone);
        expect(verified.status).toBe(200);
        const cookie = verified.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .join("; ");
        const share = await request(`claims/${f.link.id}/share`, undefined, cookie);
        expect(share.status).toBe(200);
        const body = await share.json();
        expect(body.slot_index).toBe(index);
        expect(body.amount_base_units).toBe(amount);
        expect(body).not.toHaveProperty("slots");
        expect(JSON.stringify(body)).not.toContain(second);
        expect((await request(`claims/${randomUUID()}/share`, undefined, cookie)).status).toBe(403);
        expect((await verify(id, phone)).status).toBe(401);
      }
      expect(
        (
          await database().query("SELECT status FROM link_slots WHERE link_id=$1", [f.link.id])
        ).rows.map((r) => r.status),
      ).toEqual(["funded", "funded"]);
    });
    it("enforces attempts, expiry and atomic single consumption for locally verified codes", async () => {
      const f = await seed(),
        destination = f.slot.recipient_phone_e164;
      const id = await send(destination);
      const correct = messages.get(destination)!;
      for (let i = 0; i < 5; i++)
        expect(
          (
            await request("auth/otp/verify", {
              challenge_id: id,
              code: correct === "000000" ? "000001" : "000000",
            })
          ).status,
        ).toBe(401);
      expect((await verify(id, destination)).status).toBe(401);
      const expired = await send(destination);
      await database().query(
        "UPDATE otp_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
        [expired],
      );
      expect((await verify(expired, destination)).status).toBe(401);
      const concurrent = await send(destination);
      const outcomes = await Promise.all([
        verify(concurrent, destination),
        verify(concurrent, destination),
      ]);
      expect(outcomes.map((r) => r.status).sort()).toEqual([200, 401]);
      expect(
        (await database().query("SELECT count(*) FROM sessions WHERE phone_e164=$1", [destination]))
          .rows[0].count,
      ).toBe("1");
    });
    it("keeps pre-verification membership private and rejects rate-limited or unsupported sends", async () => {
      const f = await seed(),
        outsider = "+2348030000003";
      const id = await send(outsider, f.link.id);
      const verified = await verify(id, outsider);
      expect(verified.status).toBe(200);
      const cookie = verified.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
      expect((await request(`claims/${f.link.id}/share`, undefined, cookie)).status).toBe(404);
      await send(outsider);
      await send(outsider);
      expect(
        (
          await request("auth/otp/send", {
            phone_e164: outsider,
            channel: "sms",
            purpose: "account",
          })
        ).status,
      ).toBe(429);
      vi.stubEnv("WHATSAPP_OTP_ENABLED", "true");
      expect(
        (
          await request("auth/otp/send", {
            phone_e164: f.slot.recipient_phone_e164,
            channel: "whatsapp",
            purpose: "account",
          })
        ).status,
      ).toBe(400);
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
    });
    it("keeps existing phone account login working and fails closed after ambiguous SMS transport", async () => {
      const f = await seed(),
        id = await send(f.user.phone_e164);
      const verified = await verify(id, f.user.phone_e164);
      expect(verified.status).toBe(200);
      const cookie = verified.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
      expect((await request("me", undefined, cookie)).status).toBe(200);
      vi.mocked(fetch).mockRejectedValueOnce(new Error("ambiguous upstream request"));
      const failed = await request("auth/otp/send", {
        phone_e164: f.slot.recipient_phone_e164,
        channel: "sms",
        purpose: "account",
      });
      expect(failed.status).toBe(503);
      expect((await failed.json()).error).toBe("otp_provider_unavailable");
      const row = (
        await database().query(
          "SELECT status,provider_ref FROM otp_challenges WHERE phone_e164=$1",
          [f.slot.recipient_phone_e164],
        )
      ).rows[0];
      expect(row).toEqual({ status: "failed", provider_ref: null });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });
  },
);
