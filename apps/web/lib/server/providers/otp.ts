import { assert, AppError } from "../errors";
import { TextbeeOtpProvider } from "./textbee";
export type OtpContext = { challengeId: string; phone: string };
export interface OtpProvider {
  send(phone: string, channel: "sms" | "whatsapp", context?: OtpContext): Promise<string>;
  check(reference: string, code: string, context?: OtpContext): Promise<boolean>;
}
export class MockOtpProvider implements OtpProvider {
  constructor() {
    assert(
      process.env.APP_ENV === "local" && process.env.SOLANA_CLUSTER === "devnet",
      "mock_otp_local_only",
    );
  }
  async send() {
    return "local-only";
  }
  async check(_reference: string, code: string) {
    return code === "000000";
  }
}
export class TwilioVerifyOtpProvider implements OtpProvider {
  private async call(path: string, body: URLSearchParams) {
    const sid = process.env.TWILIO_ACCOUNT_SID,
      token = process.env.TWILIO_AUTH_TOKEN,
      service = process.env.TWILIO_VERIFY_SERVICE_SID;
    assert(
      sid && token && service && /^VA[a-f0-9]{32}$/i.test(service),
      "twilio_not_configured",
      503,
    );
    const response = await fetch(`https://verify.twilio.com/v2/Services/${service}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new AppError("otp_provider_unavailable", 503);
    return response.json() as Promise<{ sid: string; status: string }>;
  }
  async send(phone: string, channel: "sms" | "whatsapp") {
    return (await this.call("Verifications", new URLSearchParams({ To: phone, Channel: channel })))
      .sid;
  }
  async check(reference: string, code: string) {
    return (
      (
        await this.call(
          "VerificationCheck",
          new URLSearchParams({ VerificationSid: reference, Code: code }),
        )
      ).status === "approved"
    );
  }
}
export function otpProvider(reference?: string): OtpProvider {
  if (reference !== undefined) {
    if (reference.startsWith("textbee:v1:")) return new TextbeeOtpProvider();
    if (/^VE[a-f0-9]{32}$/i.test(reference)) return new TwilioVerifyOtpProvider();
    assert(
      reference === "local-only" && process.env.OTP_PROVIDER === "mock",
      "invalid_otp_reference",
      401,
    );
    return new MockOtpProvider();
  }
  if (process.env.OTP_PROVIDER === "mock") return new MockOtpProvider();
  if (process.env.OTP_PROVIDER === "textbee") return new TextbeeOtpProvider();
  assert(process.env.OTP_PROVIDER === "twilio", "otp_not_configured", 503);
  return new TwilioVerifyOtpProvider();
}
