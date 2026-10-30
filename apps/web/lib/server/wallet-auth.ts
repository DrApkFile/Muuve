import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { isIP } from "node:net";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { z } from "zod";
import { schemas } from "@muuve/shared";
import { assert } from "./errors";
import { transaction, one, audit } from "./db";
import { cookie, issue } from "./auth";
import { publicUser } from "./otp";

const challengeCookie = "muuve_wallet_challenge";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function origin() {
  const value = process.env.APP_BASE_URL;
  assert(value && new URL(value).origin === value, "invalid_auth_issuer", 503);
  assert(process.env.APP_ENV === "local" || value.startsWith("https://"), "https_required", 503);
  assert(process.env.SOLANA_CLUSTER === "devnet", "devnet_required", 503);
  return value;
}
export function validWalletSignature(address: string, message: string, signature: string) {
  try {
    const bytes = new PublicKey(address).toBytes();
    if (!PublicKey.isOnCurve(bytes)) return false;
    const signed = bs58.decode(signature);
    if (signed.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]),
      type: "spki",
      format: "der",
    });
    return verify(null, Buffer.from(message, "utf8"), key, signed);
  } catch {
    return false;
  }
}
export async function walletChallenge(
  req: Request,
  input: z.infer<typeof schemas.walletChallenge>,
) {
  const canonical = origin();
  let address: string;
  try {
    const key = new PublicKey(input.wallet_address);
    assert(PublicKey.isOnCurve(key.toBytes()), "invalid_wallet");
    address = key.toBase58();
  } catch {
    assert(false, "invalid_wallet");
  }
  const forwarded =
    process.env.TRUSTED_PROXY === "true"
      ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      : undefined;
  const ip = forwarded && isIP(forwarded) ? forwarded : "127.0.0.1";
  const id = randomUUID(),
    browser = randomBytes(32).toString("base64url");
  const body = await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `wallet:address:${address}`,
    ]);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`wallet:ip:${ip}`]);
    const rate = await one(
      `SELECT count(*) FILTER(WHERE wallet_address=$1 AND created_at>now()-interval '10 minutes') AS wallet,
       count(*) FILTER(WHERE ip=$2::inet AND created_at>now()-interval '1 hour') AS ip
       FROM wallet_auth_challenges WHERE created_at>now()-interval '1 hour'
       AND (wallet_address=$1 OR ip=$2::inet)`,
      [address, ip],
      c,
    );
    assert(Number(rate!.wallet) < 3 && Number(rate!.ip) < 20, "rate_limited", 429);
    const clock = await one("SELECT date_trunc('milliseconds',now()) AS now", [], c);
    const issued = clock!.now as Date,
      expires = new Date(issued.getTime() + 300000);
    const message = `${new URL(canonical).host} wants you to sign in with your Solana account:\n${address}\n\nSign in to Muuve as a sender. This does not authorize a transfer or verify a phone.\n\nURI: ${canonical}\nVersion: 1\nChain ID: devnet\nNonce: ${randomBytes(16).toString("hex")}\nIssued At: ${issued.toISOString()}\nExpiration Time: ${expires.toISOString()}\nRequest ID: ${id}`;
    await c.query(
      `INSERT INTO wallet_auth_challenges(id,wallet_address,browser_hash,origin,message,ip,created_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, address, digest(browser), canonical, message, ip, issued, expires],
    );
    return { challenge_id: id, message, expires_at: expires.toISOString() };
  });
  return { body, cookie: cookie(challengeCookie, browser, 300) };
}
export async function walletLogin(req: Request, input: z.infer<typeof schemas.walletLogin>) {
  const canonical = origin();
  const browser = (req.headers.get("cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .find((value) => value.startsWith(`${challengeCookie}=`))
    ?.slice(challengeCookie.length + 1);
  assert(browser && /^[A-Za-z0-9_-]{43}$/.test(browser), "invalid_wallet_challenge", 401);
  const result = await transaction(async (c) => {
    const challenge = await one(
      `SELECT * FROM wallet_auth_challenges WHERE id=$1 AND browser_hash=$2 AND origin=$3
       AND expires_at>now() AND consumed_at IS NULL AND attempts<5 FOR UPDATE`,
      [input.challenge_id, digest(browser), canonical],
      c,
    );
    if (!challenge) return { error: "invalid_wallet_challenge" };
    // Commit failed-attempt accounting too; throwing inside this transaction would roll it back.
    await c.query("UPDATE wallet_auth_challenges SET attempts=attempts+1 WHERE id=$1", [
      challenge.id,
    ]);
    if (!validWalletSignature(challenge.wallet_address, challenge.message, input.signature))
      return { error: "invalid_wallet_signature" };
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `wallet:user:${challenge.wallet_address}`,
    ]);
    let user = await one(
      "SELECT * FROM users WHERE wallet_address=$1 FOR UPDATE",
      [challenge.wallet_address],
      c,
    );
    if (!user)
      user = await one(
        `INSERT INTO users(phone_e164,display_name,auth_origin,wallet_address)
         VALUES(NULL,'Wallet sender','wallet',$1) RETURNING *`,
        [challenge.wallet_address],
        c,
      );
    await c.query("UPDATE wallet_auth_challenges SET consumed_at=now() WHERE id=$1", [
      challenge.id,
    ]);
    await audit(c, "user", user!.id, "user.wallet_authenticated");
    return { user: publicUser(user!), cookie: await issue(c, "account", null, user!.id, null) };
  });
  assert(!result.error, result.error ?? "invalid_wallet_challenge", 401);
  return { user: result.user!, cookies: [result.cookie!, cookie(challengeCookie, "", 0)] };
}
