import { banks, resolveBank, rate, payoutProviderName } from "./payout";
import { paystackBanks, paystackResolve } from "./paystack";
import { assert } from "../errors";
import { one } from "../db";
export interface RateProvider {
  getRate(): Promise<{ ngnPerUsd: string; source: string; asOf: Date }>;
}
export interface BankDirectory {
  listBanks(): Promise<typeof banks>;
  resolveAccount(code: string, number: string): Promise<{ accountName: string }>;
}
export interface ClevaGateway {
  getLinkedBalance(userId: string): Promise<string>;
}
export const mockRateProvider: RateProvider = {
  async getRate() {
    assert(process.env.RATE_PROVIDER === "mock", "rate_provider_not_implemented", 503);
    return { ngnPerUsd: rate(), source: "mock_env_with_1_percent_spread", asOf: new Date() };
  },
};
export const mockBankDirectory: BankDirectory = {
  async listBanks() {
    return banks;
  },
  async resolveAccount(code, number) {
    return { accountName: resolveBank(code, number).account_name };
  },
};
export const paystackBankDirectory: BankDirectory = {
  listBanks: paystackBanks,
  resolveAccount: paystackResolve,
};
/** Banks and account-name lookup come from the same provider that pays out. */
export function bankDirectory(): BankDirectory {
  return payoutProviderName() === "paystack" ? paystackBankDirectory : mockBankDirectory;
}
export const mockClevaGateway: ClevaGateway = {
  async getLinkedBalance(userId) {
    assert(process.env.SOLANA_CLUSTER === "devnet", "devnet_required", 503);
    const user = await one(
      "SELECT wallet_address FROM users WHERE id=$1 AND auth_origin='cleva_preview'",
      [userId],
    );
    assert(user?.wallet_address, "preview_account_required", 403);
    const { Chain } = await import("../solana/chain");
    return new Chain().balance(user.wallet_address);
  },
};
