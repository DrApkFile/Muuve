import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { phone, uuid } from "@muuve/shared";
import { assert, AppError } from "../errors";
import type { OtpContext, OtpProvider } from "./otp";

const prefix = "textbee:v1:";
function key() {
  const secret = process.env.SESSION_SECRET;
  assert(secret && secret.length >= 32, "session_not_configured", 503);
  return secret;
}
function digest(context: OtpContext, salt: string, code: string) {
  return createHmac("sha256", key())
    .update(
      JSON.stringify(["muuve:otp:textbee:v1", context.challengeId, context.phone, salt, code]),
    )
    .digest();
}
function validContext(context?: OtpContext): asserts context is OtpContext {
  assert(
    context &&
      uuid.safeParse(context.challengeId).success &&
      phone.safeParse(context.phone).success,
    "otp_context_required",
    503,
  );
}

// Textbee transports SMS. Muuve verifies the code; database expiry, attempt limits
// and atomic consumption remain enforced by verifyOtp for every provider.
export class TextbeeOtpProvider implements OtpProvider {
  async send(destination: string, channel: "sms" | "whatsapp", context?: OtpContext) {
    validContext(context);
    assert(context.phone === destination, "otp_context_mismatch", 503);
    assert(channel === "sms", "channel_unavailable", 400);
    const apiKey = process.env.TEXTBEE_API_KEY,
      deviceId = process.env.TEXTBEE_DEVICE_ID,
      sim = process.env.TEXTBEE_SIM_SUBSCRIPTION_ID;
    assert(apiKey && deviceId && /^[a-f0-9]{24}$/i.test(deviceId), "textbee_not_configured", 503);
    assert(!sim || /^\d{1,9}$/.test(sim), "textbee_invalid_sim", 503);
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0"),
      salt = randomBytes(32).toString("hex"),
      verifier = digest(context, salt, code).toString("hex");
    try {
      const response = await fetch("https://api.textbee.dev/api/v1/gateway/send-sms", {
        method: "POST",
        headers: { "x-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          deviceId,
          recipients: [destination],
          message: `Your Muuve verification code is ${code}. It expires in 10 minutes. Do not share this code.`,
          ...(sim ? { simSubscriptionId: Number(sim) } : {}),
        }),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("provider_rejected");
      const result = await response.json();
      if (
        result?.data?.success !== true ||
        result.data.recipientCount !== 1 ||
        typeof result.data.smsBatchId !== "string" ||
        !/^[a-f0-9]{24}$/i.test(result.data.smsBatchId)
      )
        throw new Error("invalid_provider_receipt");
      // No plaintext code or phone in the persisted provider reference. A keyed
      // verifier prevents offline enumeration of the six-digit space after a DB leak.
      return (
        prefix +
        Buffer.from(JSON.stringify({ salt, verifier, batch: result.data.smsBatchId })).toString(
          "base64url",
        )
      );
    } catch {
      // A timeout can mean an SMS was queued. Never retry automatically or expose
      // upstream request/response bodies, which may contain a code or phone.
      throw new AppError("otp_provider_unavailable", 503);
    }
  }

  async check(reference: string, code: string, context?: OtpContext) {
    validContext(context);
    if (!reference.startsWith(prefix) || reference.length > 512 || !/^\d{6}$/.test(code))
      return false;
    let receipt;
    try {
      receipt = JSON.parse(
        Buffer.from(reference.slice(prefix.length), "base64url").toString("utf8"),
      );
    } catch {
      return false;
    }
    if (
      !receipt ||
      typeof receipt.salt !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.salt) ||
      typeof receipt.verifier !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.verifier) ||
      typeof receipt.batch !== "string" ||
      !/^[a-f0-9]{24}$/i.test(receipt.batch)
    )
      return false;
    return timingSafeEqual(
      Buffer.from(receipt.verifier, "hex"),
      digest(context, receipt.salt, code),
    );
  }
}
