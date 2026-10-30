import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Read-only provider check. Never sends SMS or prints device/account records.
const evidence: Record<string, unknown> = {
  checked_at: new Date().toISOString(),
  sms_requests: 0,
  live_delivery_verified: false,
};
try {
  const missing = ["TEXTBEE_API_KEY", "TEXTBEE_DEVICE_ID"].filter((name) => !process.env[name]);
  evidence.missing_configuration_names = missing;
  if (missing.length) throw new Error("textbee_not_configured");
  const id = process.env.TEXTBEE_DEVICE_ID!;
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error("textbee_invalid_device_id");
  const response = await fetch(`https://api.textbee.dev/api/v1/gateway/devices/${id}`, {
    headers: { "x-api-key": process.env.TEXTBEE_API_KEY! },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  evidence.provider_http_status = response.status;
  if (!response.ok) throw new Error("textbee_device_lookup_failed");
  const result = await response.json();
  if (result?.data?._id !== id || result.data.enabled !== true)
    throw new Error("textbee_device_not_ready");
  evidence.state = "credentials_and_enabled_device_verified_delivery_not_tested";
} catch (error) {
  evidence.state = "blocked";
  evidence.code =
    error instanceof Error && /^textbee_[a-z_]+$/.test(error.message)
      ? error.message
      : "textbee_provider_unavailable";
  process.exitCode = 1;
}
await mkdir("evidence/textbee", { recursive: true });
const path = `evidence/textbee/readiness-${randomUUID()}.json`;
await writeFile(path, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
console.info(JSON.stringify({ ...evidence, evidence: path }));
