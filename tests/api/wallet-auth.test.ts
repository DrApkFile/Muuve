import { beforeEach, afterAll, describe, expect, it } from "vitest";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { handle } from "../../apps/web/lib/server/router";
import { database, closeDatabase } from "../../apps/web/lib/server/db";
import { session, verifyCustomAuthToken } from "../../apps/web/lib/server/auth";
import { setupEnv, reset, seed, makeSession } from "../helpers";

setupEnv();
function request(path: string, body?: unknown, cookie?: string, origin = "https://muuve.test") {
  return handle(
    new Request(`https://muuve.test/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
function signature(wallet: Keypair, message: string) {
  const key = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      wallet.secretKey.slice(0, 32),
    ]),
    type: "pkcs8",
    format: "der",
  });
  return bs58.encode(sign(null, Buffer.from(message), key));
}
async function challenge(wallet = Keypair.generate()) {
  const response = await request("auth/wallet/challenge", {
    wallet_address: wallet.publicKey.toBase58(),
  });
  expect(response.status).toBe(200);
  const body = await response.json(),
    cookies = response.headers.getSetCookie();
  expect(cookies[0]).toContain("HttpOnly; Secure; SameSite=Lax");
  return {
    wallet,
    ...body,
    cookie: cookies[0]!.split(";")[0]!,
    signature: signature(wallet, body.message),
  };
}
async function login(c: Awaited<ReturnType<typeof challenge>>) {
  return request(
    "auth/wallet/login",
    { challenge_id: c.challenge_id, signature: c.signature },
    c.cookie,
  );
}
const accountCookie = (response: Response) =>
  response.headers
    .getSetCookie()
    .find((v) => v.startsWith("muuve_session="))!
    .split(";")[0]!;

describe.skipIf(process.env.MUUVE_TEST_DB !== "1")(
  "wallet-only sender auth with real PostgreSQL",
  () => {
    beforeEach(async () => {
      setupEnv();
      await reset();
      process.env.AUTH_JWT_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      process.env.AUTH_JWT_KID = "wallet-login-test";
      process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app";
    });
    afterAll(closeDatabase);
    it("authenticates the signer without OTP, issues a secure account cookie and a valid bridge JWT", async () => {
      const c = await challenge(),
        response = await login(c);
      expect(response.status).toBe(200);
      const user = (await response.json()).user,
        cookie = accountCookie(response);
      expect(user).toMatchObject({
        auth_origin: "wallet",
        wallet_address: c.wallet.publicKey.toBase58(),
      });
      expect(user).not.toHaveProperty("phone_e164");
      expect(response.headers.getSetCookie()).toHaveLength(2);
      expect(response.headers.getSetCookie()[0]).toContain("HttpOnly; Secure; SameSite=Lax");
      expect((await request("me", undefined, cookie)).status).toBe(200);
      const actor = await session(
        new Request("https://muuve.test", { headers: { cookie } }),
        "account",
      );
      expect(actor.phone_e164).toBeNull();
      expect(actor.user_id).toBe(user.id);
      const bridge = await (await request("auth/privy-token", undefined, cookie)).json();
      expect((await verifyCustomAuthToken(bridge.token)).sub).toBe(user.id);
      expect((await database().query("SELECT count(*) FROM otp_challenges")).rows[0].count).toBe(
        "0",
      );
      const stored = (
        await database().query("SELECT * FROM wallet_auth_challenges WHERE id=$1", [c.challenge_id])
      ).rows[0];
      expect(stored.browser_hash).not.toBe(c.cookie.split("=")[1]);
      expect(stored.expires_at.getTime() - stored.created_at.getTime()).toBe(300000);
      expect(c.message).toContain("URI: https://muuve.test\nVersion: 1\nChain ID: devnet");
    });
    it.each(["wrong_wallet", "altered_message", "missing_cookie", "different_browser"])(
      "rejects %s",
      async (scenario) => {
        const c = await challenge();
        const body = {
          challenge_id: c.challenge_id,
          signature:
            scenario === "wrong_wallet"
              ? signature(Keypair.generate(), c.message)
              : scenario === "altered_message"
                ? signature(c.wallet, c.message.replace("muuve.test", "evil.test"))
                : c.signature,
        };
        const cookie =
          scenario === "missing_cookie"
            ? undefined
            : scenario === "different_browser"
              ? (await challenge()).cookie
              : c.cookie;
        expect((await request("auth/wallet/login", body, cookie)).status).toBe(401);
        expect((await database().query("SELECT count(*) FROM users")).rows[0].count).toBe("0");
      },
    );
    it("persists failed attempts, exhausts five proofs and cannot recover with a valid signature", async () => {
      const c = await challenge();
      const wrong = {
        challenge_id: c.challenge_id,
        signature: signature(Keypair.generate(), c.message),
      };
      for (let i = 0; i < 5; i++)
        expect((await request("auth/wallet/login", wrong, c.cookie)).status).toBe(401);
      expect((await login(c)).status).toBe(401);
      expect(
        (
          await database().query("SELECT attempts FROM wallet_auth_challenges WHERE id=$1", [
            c.challenge_id,
          ])
        ).rows[0].attempts,
      ).toBe(5);
    });
    it("rejects at expiry without creating a session", async () => {
      const c = await challenge();
      await database().query(
        "UPDATE wallet_auth_challenges SET created_at=now()-interval '5 minutes',expires_at=now() WHERE id=$1",
        [c.challenge_id],
      );
      expect((await login(c)).status).toBe(401);
      expect((await database().query("SELECT count(*) FROM sessions")).rows[0].count).toBe("0");
    });
    it("consumes a challenge exactly once under concurrent verification and replay", async () => {
      const c = await challenge(),
        results = await Promise.all([login(c), login(c)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
      expect((await login(c)).status).toBe(401);
      expect((await database().query("SELECT count(*) FROM users")).rows[0].count).toBe("1");
      expect((await database().query("SELECT count(*) FROM sessions")).rows[0].count).toBe("1");
      expect(
        (
          await database().query(
            "SELECT count(*) FROM events WHERE type='user.wallet_authenticated'",
          )
        ).rows[0].count,
      ).toBe("1");
    });
    it("serializes distinct proofs for the same wallet to one user", async () => {
      const wallet = Keypair.generate(),
        [a, b] = await Promise.all([challenge(wallet), challenge(wallet)]);
      const results = await Promise.all([login(a), login(b)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect((await results[0]!.json()).user.id).toBe((await results[1]!.json()).user.id);
      expect((await database().query("SELECT count(*) FROM users")).rows[0].count).toBe("1");
    });
    it("retains the existing wallet identity without inheriting its verified-phone privileges", async () => {
      const f = await seed(),
        wallet = Keypair.generate();
      const user = (
        await database().query(
          "INSERT INTO users(phone_e164,display_name,auth_origin,wallet_address) VALUES($1,'Recipient','muuve',$2) RETURNING *",
          [f.slot.recipient_phone_e164, wallet.publicKey.toBase58()],
        )
      ).rows[0];
      const result = await login(await challenge(wallet));
      expect((await result.json()).user.id).toBe(user.id);
      const account = accountCookie(result),
        claim = await makeSession("claim", user.phone_e164, user.id, f.link.id);
      const selfPayment = await request(
        "links/prepare",
        {
          link_id_hex: "00112233445566778899aabbccddeeff",
          claim_pubkey: Keypair.generate().publicKey.toBase58(),
          recipients: [{ phone_e164: user.phone_e164, amount_base_units: "1000000" }],
        },
        account,
      );
      expect(selfPayment.status).toBe(400);
      expect((await selfPayment.json()).error).toBe("self_payment");
      const rejected = await request(
        `claims/${f.link.id}/intent/prepare`,
        { path: "keep" },
        `${account}; ${claim.cookie}`,
      );
      expect(rejected.status).toBe(403);
      expect((await rejected.json()).error).toBe("account_phone_mismatch");
      expect((await request(`claims/${f.link.id}/share`, undefined, account)).status).toBe(401);
      expect((await request(`claims/${f.link.id}/share`, undefined, claim.cookie)).status).toBe(
        200,
      );
    });
    it("refreshes and logs out a phone-less account and permits its own mock wallet quote", async () => {
      const cookie = accountCookie(await login(await challenge()));
      const quote = await request("payouts/quote", { amount_base_units: "1000000" }, cookie);
      expect(quote.status).toBe(200);
      expect(
        (await database().query("SELECT owner_phone FROM principals")).rows[0].owner_phone,
      ).toBeNull();
      const refreshed = await request("auth/refresh", {}, cookie);
      expect(refreshed.status).toBe(200);
      expect((await request("me", undefined, cookie)).status).toBe(401);
      const replacement = accountCookie(refreshed);
      expect((await request("me", undefined, replacement)).status).toBe(200);
      expect((await request("auth/logout", {}, replacement)).status).toBe(200);
      expect((await request("me", undefined, replacement)).status).toBe(401);
    });
    it("enforces concurrent per-wallet issuance limits", async () => {
      const wallet = Keypair.generate();
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request("auth/wallet/challenge", { wallet_address: wallet.publicKey.toBase58() }),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
      expect(results.filter((r) => r.status === 429)).toHaveLength(1);
    });
    it("enforces the IP limit across distinct wallets", async () => {
      for (let i = 0; i < 20; i++) await challenge();
      const result = await request("auth/wallet/challenge", {
        wallet_address: Keypair.generate().publicKey.toBase58(),
      });
      expect(result.status).toBe(429);
    });
    it("rejects foreign origins, off-curve addresses, injected identity and changed origin/cluster", async () => {
      const wallet = Keypair.generate(),
        input = { wallet_address: wallet.publicKey.toBase58() };
      expect(
        (await request("auth/wallet/challenge", input, undefined, "https://evil.test")).status,
      ).toBe(403);
      const offCurve = PublicKey.findProgramAddressSync([Buffer.from("test")], wallet.publicKey)[0];
      expect(
        (await request("auth/wallet/challenge", { wallet_address: offCurve.toBase58() })).status,
      ).toBe(400);
      const c = await challenge(wallet);
      expect(
        (
          await request(
            "auth/wallet/login",
            { challenge_id: c.challenge_id, signature: c.signature, phone_e164: "+2348030000002" },
            c.cookie,
          )
        ).status,
      ).toBe(400);
      process.env.APP_BASE_URL = "https://other.test";
      expect(
        (
          await request(
            "auth/wallet/login",
            { challenge_id: c.challenge_id, signature: c.signature },
            c.cookie,
            "https://other.test",
          )
        ).status,
      ).toBe(401);
      process.env.APP_BASE_URL = "https://muuve.test";
      process.env.SOLANA_CLUSTER = "mainnet-beta";
      expect((await request("auth/wallet/challenge", input)).status).toBe(503);
    });
    it("keeps mandatory phone proofs and non-wallet user identities constrained in SQL", async () => {
      await expect(
        database().query("INSERT INTO users(display_name,auth_origin) VALUES('Invalid','muuve')"),
      ).rejects.toThrow();
      await expect(
        database().query("INSERT INTO users(display_name,auth_origin) VALUES('Invalid','wallet')"),
      ).rejects.toThrow();
      await expect(
        database().query(
          "INSERT INTO sessions(id,purpose,expires_at) VALUES(gen_random_uuid(),'proof',now()+interval '1 minute')",
        ),
      ).rejects.toThrow();
    });
  },
);
