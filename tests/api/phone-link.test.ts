import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Keypair } from "@solana/web3.js";
import { handle } from "../../apps/web/lib/server/router";
import { database, closeDatabase, one } from "../../apps/web/lib/server/db";
import { setupEnv, reset, seed, makeSession } from "../helpers";
setupEnv();
function request(path: string, data?: unknown, cookie?: string) {
  return handle(
    new Request(`https://muuve.test/api/${path}`, {
      method: data ? "POST" : "GET",
      headers: {
        origin: "https://muuve.test",
        "content-type": "application/json",
        "x-forwarded-for": "192.0.2.9",
        ...(cookie ? { cookie } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    }),
  );
}
async function walletUser() {
  const user = await one(
    "INSERT INTO users(phone_e164,display_name,auth_origin,wallet_address) VALUES(NULL,'Wallet sender','wallet',$1) RETURNING *",
    [Keypair.generate().publicKey.toBase58()],
  );
  return { user: user!, ...(await makeSession("account", null, user!.id, null)) };
}
async function sendCode(phone: string) {
  const res = await request("auth/otp/send", {
    phone_e164: phone,
    channel: "sms",
    purpose: "account",
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge_id: string }).challenge_id;
}
describe.skipIf(process.env.MUUVE_TEST_DB !== "1")("phone linking for wallet sign-ups", () => {
  beforeEach(reset);
  afterAll(closeDatabase);
  it("requires a phone to send, then links a verified number to the wallet account", async () => {
    const { user, cookie } = await walletUser();
    const blocked = await request(
      "links/prepare",
      {
        link_id_hex: "ab".repeat(16),
        claim_pubkey: Keypair.generate().publicKey.toBase58(),
        recipients: [{ phone_e164: "+2348030000002", amount_base_units: "1000000" }],
      },
      cookie,
    );
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toBe("phone_required");
    const me = await (await request("me", undefined, cookie)).json();
    expect(me.user).toMatchObject({ phone_linked: false, phone_last4: null });

    const wrong = await request(
      "me/phone",
      { challenge_id: await sendCode("+2348030000009"), code: "123456" },
      cookie,
    );
    expect(wrong.status).toBe(401);

    const linked = await request(
      "me/phone",
      { challenge_id: await sendCode("+2348030000009"), code: "000000" },
      cookie,
    );
    expect(linked.status).toBe(200);
    expect((await linked.json()).user).toMatchObject({
      id: user.id,
      phone_linked: true,
      phone_last4: "0009",
    });
    expect(linked.headers.getSetCookie()).toEqual([]);
    const row = await database().query("SELECT phone_e164 FROM users WHERE id=$1", [user.id]);
    expect(row.rows[0].phone_e164).toBe("+2348030000009");
  });
  it("refuses a number that belongs to another account and needs a signed-in user", async () => {
    const other = await seed();
    const { cookie } = await walletUser();
    const taken = await request(
      "me/phone",
      { challenge_id: await sendCode(other.user.phone_e164), code: "000000" },
      cookie,
    );
    expect(taken.status).toBe(409);
    expect((await taken.json()).error).toBe("phone_in_use");
    const anonymous = await request("me/phone", {
      challenge_id: await sendCode("+2348030000008"),
      code: "000000",
    });
    expect(anonymous.status).toBe(401);
  });
});
