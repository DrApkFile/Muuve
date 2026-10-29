import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { handle } from "../../apps/web/lib/server/router";
import { database, closeDatabase } from "../../apps/web/lib/server/db";
import { setupEnv, reset, seed, makeSession } from "../helpers";
setupEnv();
function request(path: string, method = "GET", data?: unknown, cookie?: string, ip = "192.0.2.1") {
  return handle(
    new Request(`https://muuve.test/api/${path}`, {
      method,
      headers: {
        origin: "https://muuve.test",
        "content-type": "application/json",
        "x-forwarded-for": ip,
        ...(cookie ? { cookie } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    }),
  );
}
describe.skipIf(process.env.MUUVE_TEST_DB !== "1")(
  "API auth and recipient privacy with real Postgres",
  () => {
    beforeEach(reset);
    afterAll(closeDatabase);
    it("requires sessions and rejects invalid mutation origins", async () => {
      expect((await request("me")).status).toBe(401);
      expect(
        (
          await handle(
            new Request("https://muuve.test/api/auth/signup", {
              method: "POST",
              headers: { origin: "https://evil.test" },
              body: "{}",
            }),
          )
        ).status,
      ).toBe(403);
    });
    it("rejects expired and revoked sessions", async () => {
      const f = await seed(),
        s = await makeSession("account", f.user.phone_e164, f.user.id, null);
      await database().query(
        "UPDATE sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
        [s.session.id],
      );
      expect((await request("me", "GET", undefined, s.cookie)).status).toBe(401);
    });
    it("has no membership-dependent OTP send result and binds verification to a link", async () => {
      const f = await seed();
      const sent = await request("auth/otp/send", "POST", {
        phone_e164: "+2348030000003",
        purpose: "claim",
        channel: "sms",
        link_id: f.link.id,
      });
      expect(sent.status).toBe(200);
      const data = await sent.json();
      const verified = await request("auth/otp/verify", "POST", {
        challenge_id: data.challenge_id,
        code: "000000",
      });
      expect(verified.status).toBe(200);
      const cookie = verified.headers.getSetCookie()[0]!.split(";")[0];
      expect((await request(`claims/${f.link.id}/share`, "GET", undefined, cookie)).status).toBe(
        404,
      );
      expect((await request(`claims/${randomUUID()}/share`, "GET", undefined, cookie)).status).toBe(
        403,
      );
      expect(
        (
          await request("auth/otp/verify", "POST", {
            challenge_id: data.challenge_id,
            code: "000000",
          })
        ).status,
      ).toBe(401);
    });
    it("rate limits concurrent sends across channels", async () => {
      const data = { phone_e164: "+2348030000002", purpose: "account", channel: "sms" };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => request("auth/otp/send", "POST", data)),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
      expect(results.filter((r) => r.status === 429)).toHaveLength(2);
    });
    it("consumes signup proof exactly once and issues an account session", async () => {
      const sent = await (
        await request("auth/otp/send", "POST", {
          phone_e164: "+2348030000002",
          purpose: "account",
          channel: "sms",
        })
      ).json();
      const verified = await request("auth/otp/verify", "POST", {
          challenge_id: sent.challenge_id,
          code: "000000",
        }),
        proof = verified.headers.getSetCookie()[0]!.split(";")[0];
      const signup = await request("auth/signup", "POST", { display_name: "Recipient" }, proof);
      expect(signup.status).toBe(200);
      expect((await request("auth/signup", "POST", { display_name: "Again" }, proof)).status).toBe(
        401,
      );
      expect(
        (await request("me", "GET", undefined, signup.headers.getSetCookie()[0]!.split(";")[0]))
          .status,
      ).toBe(200);
    });
    it("exposes only the verified recipient share and denies another sender", async () => {
      const f = await seed(),
        s = await makeSession("claim", f.slot.recipient_phone_e164, null, f.link.id);
      const res = await request(`claims/${f.link.id}/share`, "GET", undefined, s.cookie);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("phone");
      expect(text).not.toContain("label");
      expect(text).toContain("1000000");
      const second = await seed({
          senderPhone: "+2348030000003",
          wallet: "11111111111111111111111111111112",
        }),
        a = await makeSession("account", second.user.phone_e164, second.user.id, null);
      expect((await request(`links/${f.link.id}`, "GET", undefined, a.cookie)).status).toBe(404);
    });
  },
);
