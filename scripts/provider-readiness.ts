import { PrivyClient } from "@privy-io/node";
import { mkdir, writeFile } from "node:fs/promises";

// Read-only credential/config checks. Never sends OTPs, creates users or wallets,
// returns user records, changes dashboards, or dispatches fiat.
const result: Record<string, unknown> = {
  checked_at: new Date().toISOString(),
  scope: "read-only provider configuration; no SMS, wallet creation or payout",
};
try {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) result.privy = { state: "not_configured" };
  else {
    const client = new PrivyClient({ appId, appSecret, timeout: 10000, maxRetries: 0 });
    const settings = await client.apps().getSettings();
    const response = await client.users().list({ limit: 1 }).asResponse();
    await response.body?.cancel();
    result.privy = {
      state:
        response.ok && settings.id === appId ? "credentials_verified" : "configuration_mismatch",
      privileged_api_authenticated: response.ok,
      app_matches: settings.id === appId,
      custom_jwt_auth_enabled: settings.custom_jwt_auth,
      canonical_origin_exactly_listed: settings.allowed_domains.includes(
        process.env.APP_BASE_URL ?? "",
      ),
    };
  }
} catch (error) {
  result.privy = {
    state: "blocked",
    http_status:
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : undefined,
    code: "provider_auth_or_transport_failed",
  };
}
try {
  const sid = process.env.TWILIO_ACCOUNT_SID,
    token = process.env.TWILIO_AUTH_TOKEN,
    service = process.env.TWILIO_VERIFY_SERVICE_SID;
  if (!sid || !token || !service) result.twilio = { state: "not_configured" };
  else {
    if (!/^VA[a-f0-9]{32}$/i.test(service)) throw new Error("invalid_service");
    const response = await fetch(`https://verify.twilio.com/v2/Services/${service}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      result.twilio = {
        state: "blocked",
        http_status: response.status,
        code: "provider_auth_or_service_failed",
      };
    } else {
      const info = (await response.json()) as {
        sid: string;
        account_sid: string;
        code_length: number;
      };
      const matches = info.sid === service && info.account_sid === sid && info.code_length === 6;
      result.twilio = {
        state: matches ? "credentials_verified" : "configuration_mismatch",
        service_matches: info.sid === service,
        account_matches: info.account_sid === sid,
        code_length: info.code_length,
        otp_provider: process.env.OTP_PROVIDER,
        live_sms_sent: false,
      };
    }
  }
} catch {
  result.twilio = {
    state: "blocked",
    code: "provider_auth_or_transport_failed",
    live_sms_sent: false,
  };
}
await mkdir("evidence/render-devnet", { recursive: true });
await writeFile(
  "evidence/render-devnet/provider-readiness.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.info(JSON.stringify(result));
if (
  [result.privy, result.twilio].some(
    (x) => (x as { state: string }).state !== "credentials_verified",
  )
)
  process.exitCode = 1;
