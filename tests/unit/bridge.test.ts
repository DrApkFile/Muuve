import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import {
  bridgeApi,
  bridgeEnv,
  verifyBridgeSignature,
} from "../../apps/web/lib/server/providers/bridge";
import { usdToBaseUnits } from "../../apps/web/lib/server/usd-accounts";
import { setupEnv } from "../helpers";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
function sign(raw: string, t = Date.now().toString()) {
  const digest = createHash("sha256").update(`${t}.${raw}`).digest();
  return `t=${t},v0=${createSign("SHA256").update(digest).end().sign(privateKey, "base64")}`;
}
beforeEach(() => {
  setupEnv();
  vi.stubEnv("BRIDGE_ENV", "sandbox");
  vi.stubEnv("BRIDGE_API_KEY", "sk-test-unit");
  vi.stubEnv("BRIDGE_WEBHOOK_PUBLIC_KEY", pem.replace(/\n/g, "\\n"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Bridge US dollar accounts", () => {
  it("only runs the sandbox on devnet, with test keys", () => {
    expect(bridgeEnv()).toBe("sandbox");
    vi.stubEnv("BRIDGE_ENV", "production");
    expect(() => bridgeEnv()).toThrow("bridge_env_mismatch");
    vi.stubEnv("BRIDGE_ENV", "sandbox");
    vi.stubEnv("BRIDGE_API_KEY", "sk-live-unit");
    return expect(bridgeApi.kycLink("k")).rejects.toThrow("bridge_live_key_refused");
  });
  it("accepts a genuine signature and rejects tampering, staleness and missing headers", () => {
    const raw = JSON.stringify({ event_category: "virtual_account.activity", event_object: {} });
    expect(() => verifyBridgeSignature(raw, sign(raw))).not.toThrow();
    expect(() => verifyBridgeSignature(raw + " ", sign(raw))).toThrow("invalid_webhook");
    const old = (Date.now() - 11 * 60_000).toString();
    expect(() => verifyBridgeSignature(raw, sign(raw, old))).toThrow("invalid_webhook");
    expect(() => verifyBridgeSignature(raw, null)).toThrow("invalid_webhook");
  });
  it("asks for USDT on Solana to the user's address, against the sandbox host", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        id: "va_1",
        status: "activated",
        customer_id: "c_1",
        source_deposit_instructions: {},
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await bridgeApi.createVirtualAccount("c_1", "Addr111", "muuve-va-u1");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.sandbox.bridge.xyz/v0/customers/c_1/virtual_accounts");
    expect(init.headers["idempotency-key"]).toBe("muuve-va-u1");
    expect(init.headers["api-key"]).toBe("sk-test-unit");
    expect(JSON.parse(init.body)).toEqual({
      source: { currency: "usd" },
      destination: { currency: "usdt", payment_rail: "solana", address: "Addr111" },
    });
  });
  it("hides provider error bodies behind codes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ message: "a@b.c" }, { status: 400 })),
    );
    await expect(bridgeApi.kycLink("k")).rejects.toThrow("usd_provider_rejected");
  });
  it("converts dollar strings to base units exactly", () => {
    expect(usdToBaseUnits("250.00")).toBe(250_000_000n);
    expect(usdToBaseUnits("0.000001")).toBe(1n);
    expect(usdToBaseUnits("1.5")).toBe(1_500_000n);
    for (const bad of ["0", "-1", "1e3", "1.1234567", "", undefined])
      expect(usdToBaseUnits(bad)).toBeNull();
  });
});
