// Registers and enables Muuve's Bridge webhook, then prints its public key (a public value) for
// BRIDGE_WEBHOOK_PUBLIC_KEY. Needs BRIDGE_ENV and BRIDGE_API_KEY; never prints the API key.
//   pnpm bridge:webhook https://muuve.onrender.com/api/webhooks/bridge
import { randomUUID } from "node:crypto";

const env = process.env.BRIDGE_ENV,
  key = process.env.BRIDGE_API_KEY,
  url = process.argv[2];
if ((env !== "sandbox" && env !== "production") || !key)
  throw new Error("Set BRIDGE_ENV and BRIDGE_API_KEY");
if (env === "sandbox" && !key.startsWith("sk-test"))
  throw new Error("Sandbox needs an sk-test key");
if (!url?.startsWith("https://")) throw new Error("Pass the https webhook URL");
const base = env === "sandbox" ? "https://api.sandbox.bridge.xyz/v0" : "https://api.bridge.xyz/v0";
const categories = ["virtual_account.activity", "kyc_link", "customer"];

async function call(path: string, method: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "api-key": key!,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}`);
  return (await res.json()) as { id: string; public_key?: string; status?: string };
}

const created = await call("/webhooks", "POST", {
  url,
  event_epoch: "webhook_creation",
  event_categories: categories,
});
const enabled = await call(`/webhooks/${created.id}`, "PUT", {
  url,
  status: "active",
  event_categories: categories,
});
console.log(JSON.stringify({ webhook_id: created.id, status: enabled.status }));
console.log("BRIDGE_WEBHOOK_PUBLIC_KEY (paste into Render as one line):");
console.log((enabled.public_key ?? "").replace(/\n/g, "\\n"));
