import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { schemas } from "@muuve/shared";
import { transaction, one, audit } from "./db";
import { issue, type Session } from "./auth";
import { assert } from "./errors";
import { otpProvider } from "./providers/otp";
export async function sendOtp(req: Request, body: z.infer<typeof schemas.otpSend>) {
  assert((body.purpose === "claim") === !!body.link_id, "link_required");
  assert(
    body.channel !== "whatsapp" || process.env.WHATSAPP_OTP_ENABLED === "true",
    "channel_unavailable",
  );
  assert(process.env.OTP_PROVIDER !== "textbee" || body.channel === "sms", "channel_unavailable");
  const forwarded =
    process.env.TRUSTED_PROXY === "true"
      ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      : undefined;
  const ip = forwarded && isIP(forwarded) ? forwarded : "127.0.0.1";
  const id = randomUUID();
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `otp:phone:${body.phone_e164}`,
    ]);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`otp:ip:${ip}`]);
    const rate = await one(
      `SELECT count(*) FILTER(WHERE phone_e164=$1 AND created_at>now()-interval '10 minutes') AS ten,
   count(*) FILTER(WHERE phone_e164=$1 AND created_at>now()-interval '24 hours') AS day,
   count(*) FILTER(WHERE ip=$2::inet AND created_at>now()-interval '1 hour') AS hour FROM otp_challenges
   WHERE created_at>now()-interval '24 hours' AND (phone_e164=$1 OR ip=$2::inet)`,
      [body.phone_e164, ip],
      c,
    );
    assert(
      Number(rate?.ten) < 3 && Number(rate?.day) < 10 && Number(rate?.hour) < 20,
      "rate_limited",
      429,
    );
    await c.query(
      "INSERT INTO otp_challenges(id,phone_e164,ip,channel,purpose,link_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')",
      [id, body.phone_e164, ip, body.channel, body.purpose, body.link_id ?? null],
    );
  });
  try {
    const ref = await otpProvider().send(body.phone_e164, body.channel, {
      challengeId: id,
      phone: body.phone_e164,
    });
    await transaction((c) =>
      c.query("UPDATE otp_challenges SET provider_ref=$2,status='sent' WHERE id=$1", [id, ref]),
    );
  } catch (error) {
    await transaction((c) =>
      c.query("UPDATE otp_challenges SET status='failed' WHERE id=$1", [id]),
    );
    throw error;
  }
  return { sent: true, channel: body.channel, challenge_id: id };
}
export async function verifyOtp(body: z.infer<typeof schemas.otpVerify>) {
  const challenge = await transaction(async (c) => {
    const row = await one(
      "UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1 AND status='sent' AND attempts<5 AND expires_at>now() RETURNING *",
      [body.challenge_id],
      c,
    );
    assert(row, "invalid_challenge", 401);
    return row;
  });
  const ok = await otpProvider(challenge.provider_ref).check(challenge.provider_ref, body.code, {
    challengeId: challenge.id,
    phone: challenge.phone_e164,
  });
  assert(ok, "invalid_code", 401);
  return transaction(async (c) => {
    const consumed = await one(
      "UPDATE otp_challenges SET status='verified',verified_at=now() WHERE id=$1 AND status='sent' AND expires_at>now() RETURNING *",
      [challenge.id],
      c,
    );
    assert(consumed, "invalid_challenge", 401);
    const user = await one("SELECT * FROM users WHERE phone_e164=$1", [consumed.phone_e164], c),
      cookies: string[] = [];
    if (consumed.purpose === "claim") {
      // Unknown links follow the same send/verify path; membership is checked only after proof.
      const link = await one("SELECT id FROM links WHERE id=$1", [consumed.link_id], c);
      assert(link, "not_on_payment", 404);
      cookies.push(
        await issue(c, "claim", consumed.phone_e164, user?.id ?? null, consumed.link_id),
      );
      if (user) cookies.push(await issue(c, "account", consumed.phone_e164, user.id, null));
      return { body: { verified: true }, cookies };
    }
    cookies.push(
      await issue(c, user ? "account" : "proof", consumed.phone_e164, user?.id ?? null, null),
    );
    return { body: user ? { user: publicUser(user) } : { needs_signup: true }, cookies };
  });
}
// Attach a verified phone to the signed-in account (wallet sign-ups start without one).
// Uses an "account" challenge, but issues no cookies: the caller is already signed in.
export async function linkPhone(account: Session, body: z.infer<typeof schemas.otpVerify>) {
  assert(account.user_id, "account_required", 401);
  const challenge = await transaction(async (c) => {
    const row = await one(
      "UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1 AND purpose='account' AND status='sent' AND attempts<5 AND expires_at>now() RETURNING *",
      [body.challenge_id],
      c,
    );
    assert(row, "invalid_challenge", 401);
    return row;
  });
  const ok = await otpProvider(challenge.provider_ref).check(challenge.provider_ref, body.code, {
    challengeId: challenge.id,
    phone: challenge.phone_e164,
  });
  assert(ok, "invalid_code", 401);
  return transaction(async (c) => {
    const consumed = await one(
      "UPDATE otp_challenges SET status='verified',verified_at=now() WHERE id=$1 AND status='sent' AND expires_at>now() RETURNING *",
      [challenge.id],
      c,
    );
    assert(consumed, "invalid_challenge", 401);
    const phone = consumed.phone_e164 as string;
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`phone:link:${phone}`]);
    const user = await one("SELECT * FROM users WHERE id=$1 FOR UPDATE", [account.user_id], c);
    assert(user, "unauthorized", 401);
    if (user.phone_e164 === phone) return { user: publicUser(user) };
    assert(!user.phone_e164, "phone_already_linked", 409);
    const owner = await one("SELECT id FROM users WHERE phone_e164=$1", [phone], c);
    assert(!owner, "phone_in_use", 409);
    const updated = await one(
      "UPDATE users SET phone_e164=$2 WHERE id=$1 RETURNING *",
      [user.id, phone],
      c,
    );
    // Money already kept for this number before the account existed now belongs to it.
    await c.query(
      "UPDATE principals SET user_id=$2 WHERE owner_phone=$1 AND source='escrow_claim' AND user_id IS NULL",
      [phone, user.id],
    );
    await audit(c, "user", user.id, "user.phone_linked");
    return { user: publicUser(updated!) };
  });
}
export function publicUser(user: Record<string, unknown>) {
  return {
    id: user.id,
    display_name: user.display_name,
    auth_origin: user.auth_origin,
    wallet_address: user.wallet_address,
    phone_linked: !!user.phone_e164,
    phone_last4: typeof user.phone_e164 === "string" ? user.phone_e164.slice(-4) : null,
  };
}
