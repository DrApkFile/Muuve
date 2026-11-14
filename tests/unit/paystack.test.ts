import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PaystackPayoutProvider,
  paystackResolve,
} from "../../apps/web/lib/server/providers/paystack";
import { payoutProvider } from "../../apps/web/lib/server/providers/payout";
import { setupEnv } from "../helpers";

const request = {
  payoutId: "6f3c1e9a-58b4-4c51-9d2a-2d8a3f6f9b10",
  providerKey: "0d6c5f7e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
  amountKobo: "4514400",
  bankCode: "999992",
  accountNumber: "0123456789",
  accountName: "ADA OBI",
};
beforeEach(() => {
  setupEnv();
  vi.stubEnv("PAYOUT_PROVIDER", "paystack");
  vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_test_unit");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const ok = (data: unknown) => Response.json({ status: true, data });
const fail = (status: number) => Response.json({ status: false, message: "x" }, { status });

describe("Paystack payouts", () => {
  it("refuses a live key on devnet", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_unit");
    expect(() => payoutProvider()).toThrow("paystack_live_key_refused");
  });
  it("selects the provider that created a payout, not the current setting", () => {
    expect(payoutProvider("mock")).not.toBeInstanceOf(PaystackPayoutProvider);
    expect(payoutProvider()).toBeInstanceOf(PaystackPayoutProvider);
  });
  it("creates a recipient, then a transfer keyed by the payout reference", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(ok({ recipient_code: "RCP_1" }))
      .mockResolvedValueOnce(ok({ transfer_code: "TRF_1" }));
    vi.stubGlobal("fetch", fetch);
    expect(await new PaystackPayoutProvider().createPayout(request)).toEqual({
      providerRef: "TRF_1",
    });
    const [url, init] = fetch.mock.calls[1]!;
    expect(url).toBe("https://api.paystack.co/transfer");
    expect(init.headers.authorization).toBe("Bearer sk_test_unit");
    expect(JSON.parse(init.body)).toMatchObject({
      amount: 4514400,
      recipient: "RCP_1",
      reference: request.providerKey,
    });
  });
  it("reuses the accepted transfer when the reference already exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(ok({ recipient_code: "RCP_1" }))
        .mockResolvedValueOnce(fail(400))
        .mockResolvedValueOnce(ok({ transfer_code: "TRF_1", status: "pending" })),
    );
    expect(await new PaystackPayoutProvider().createPayout(request)).toEqual({
      providerRef: "TRF_1",
    });
  });
  it("maps transfer states and unknown references", async () => {
    const provider = new PaystackPayoutProvider();
    for (const [state, expected] of [
      ["success", "paid"],
      ["reversed", "failed"],
      ["failed", "failed"],
      ["pending", "processing"],
      ["otp", "processing"],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ transfer_code: "T", status: state })));
      expect((await provider.status("k"))?.status).toBe(expected);
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(404)));
    expect(await provider.status("k")).toBeUndefined();
  });
  it("resolves account names only for listed banks and 10-digit numbers", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(ok([{ code: "999992", name: "OPay Digital Services", active: true }]))
      .mockResolvedValueOnce(ok({ account_name: "ADA OBI" }));
    vi.stubGlobal("fetch", fetch);
    expect(await paystackResolve("999992", "0123456789")).toEqual({ accountName: "ADA OBI" });
    await expect(paystackResolve("999992", "123")).rejects.toThrow("account_not_found");
    await expect(paystackResolve("000000", "0123456789")).rejects.toThrow("account_not_found");
  });
});
