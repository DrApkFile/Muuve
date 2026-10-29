const allowed = new Set([
  "event",
  "request_id",
  "operation_id",
  "link_id",
  "payout_id",
  "state",
  "code",
  "duration_ms",
  "signature",
]);
export function safeLog(fields: Record<string, unknown>) {
  const safe = Object.fromEntries(
    Object.entries(fields).filter(
      ([k, v]) => allowed.has(k) && ["string", "number", "boolean"].includes(typeof v),
    ),
  );
  console.info(JSON.stringify(safe));
}
export const maskPhone = (value: string) => `***${value.slice(-4)}`;
export const maskAccount = (value: string) => `******${value.slice(-4)}`;
