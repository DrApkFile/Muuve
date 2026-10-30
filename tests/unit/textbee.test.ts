import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { TextbeeOtpProvider } from "../../apps/web/lib/server/providers/textbee";
import { otpProvider, TwilioVerifyOtpProvider } from "../../apps/web/lib/server/providers/otp";
import { config, chainConfig } from "../../apps/web/lib/server/config";
import { setupEnv } from "../helpers";

const destination = "+2348030000002",
  device = "1234567890abcdef12345678";
beforeEach(() => {
  setupEnv();
  vi.stubEnv("OTP_PROVIDER", "textbee");
  vi.stubEnv("TEXTBEE_API_KEY", "unit-test-api-key");
  vi.stubEnv("TEXTBEE_DEVICE_ID", device);
  vi.stubEnv("TEXTBEE_SIM_SUBSCRIPTION_ID", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function gateway() {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ data: { success: true, recipientCount: 1, smsBatchId: device } }),
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
describe("Textbee OTP transport and keyed verifier", () => {
  it("sends one SMS to the explicit device and stores no plaintext code or phone", async () => {
    const fetch = gateway(),
      context = { challengeId: randomUUID(), phone: destination },
      provider = otpProvider();
    const reference = await provider.send(destination, "sms", context);
    const [url, options] = fetch.mock.calls[0]!,
      body = JSON.parse(options.body),
      code = body.message.match(/\b\d{6}\b/)[0];
    expect(url).toBe("https://api.textbee.dev/api/v1/gateway/send-sms");
    expect(options.redirect).toBe("error");
    expect(body.recipients).toEqual([destination]);
    expect(body.deviceId).toBe(device);
    expect(body).not.toHaveProperty("simSubscriptionId");
    const stored = JSON.parse(Buffer.from(reference.split(":")[2]!, "base64url").toString());
    expect(Object.keys(stored).sort()).toEqual(["batch", "salt", "verifier"]);
    expect(JSON.stringify(stored)).not.toContain(destination);
    expect(await provider.check(reference, code, context)).toBe(true);
    expect(await provider.check(reference, code === "000000" ? "000001" : "000000", context)).toBe(
      false,
    );
    expect(await provider.check(reference, code, { ...context, challengeId: randomUUID() })).toBe(
      false,
    );
    expect(await provider.check(reference, code, { ...context, phone: "+2348030000003" })).toBe(
      false,
    );
    vi.stubEnv("SESSION_SECRET", "different-session-secret-with-enough-entropy-for-test");
    expect(await provider.check(reference, code, context)).toBe(false);
  });
  it("uses the explicit SIM when configured", async () => {
    const fetch = gateway();
    vi.stubEnv("TEXTBEE_SIM_SUBSCRIPTION_ID", "2");
    await otpProvider().send(destination, "sms", { challengeId: randomUUID(), phone: destination });
    expect(JSON.parse(fetch.mock.calls[0]![1].body).simSubscriptionId).toBe(2);
  });
  it("rejects missing configuration, missing context and unsupported channels before network access", async () => {
    const fetch = gateway(),
      provider = new TextbeeOtpProvider(),
      context = { challengeId: randomUUID(), phone: destination };
    await expect(provider.send(destination, "sms")).rejects.toThrow("otp_context_required");
    await expect(provider.send(destination, "whatsapp", context)).rejects.toThrow(
      "channel_unavailable",
    );
    await expect(provider.send("+2348030000003", "sms", context)).rejects.toThrow(
      "otp_context_mismatch",
    );
    vi.stubEnv("TEXTBEE_DEVICE_ID", "");
    await expect(provider.send(destination, "sms", context)).rejects.toThrow(
      "textbee_not_configured",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["reject", "timeout", "receipt"])(
    "redacts %s errors and never automatically resends",
    async (failure) => {
      const fetch = gateway();
      if (failure === "reject")
        fetch.mockResolvedValue(new Response("sensitive provider body", { status: 429 }));
      if (failure === "timeout") fetch.mockRejectedValue(new Error("sensitive request details"));
      if (failure === "receipt")
        fetch.mockResolvedValue(Response.json({ data: { success: true, recipientCount: 2 } }));
      await expect(
        otpProvider().send(destination, "sms", { challengeId: randomUUID(), phone: destination }),
      ).rejects.toThrow("otp_provider_unavailable");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects malformed receipts without any provider call", async () => {
    const fetch = gateway(),
      provider = new TextbeeOtpProvider(),
      context = { challengeId: randomUUID(), phone: destination };
    for (const reference of [
      "textbee:v1:!",
      "textbee:v1:" + Buffer.from("null").toString("base64url"),
      "textbee:v1:" + "a".repeat(600),
    ])
      expect(await provider.check(reference, "000000", context)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("routes pending challenges by stored provider, preserving Twilio challenges during a switch", () => {
    expect(otpProvider("VE" + "1".repeat(32))).toBeInstanceOf(TwilioVerifyOtpProvider);
    vi.stubEnv("OTP_PROVIDER", "twilio");
    expect(otpProvider("textbee:v1:pending")).toBeInstanceOf(TextbeeOtpProvider);
    expect(() => otpProvider("unknown-reference")).toThrow("invalid_otp_reference");
    expect(() => otpProvider("local-only")).toThrow();
  });
});
describe("four-minute expiry guard", () => {
  it("allows only the explicit 240-second demo value in local or preview devnet", () => {
    for (const APP_ENV of ["local", "preview"]) {
      const env = { ...process.env, APP_ENV, CLAIM_WINDOW_SECS: "240" };
      expect(config(env).CLAIM_WINDOW_SECS).toBe("240");
      expect(chainConfig(env).CLAIM_WINDOW_SECS).toBe("240");
    }
    for (const APP_ENV of ["production", undefined])
      expect(() => chainConfig({ ...process.env, APP_ENV, CLAIM_WINDOW_SECS: "240" })).toThrow();
    expect(() =>
      config({ ...process.env, APP_ENV: "production", CLAIM_WINDOW_SECS: "240" }),
    ).toThrow();
    expect(() =>
      config({ ...process.env, SOLANA_CLUSTER: "mainnet-beta", CLAIM_WINDOW_SECS: "240" }),
    ).toThrow();
    expect(() => config({ ...process.env, CLAIM_WINDOW_SECS: "239" })).toThrow();
  });
});
