import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { verifyWallet } from "../../apps/web/lib/server/providers/privy";
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@privy-io/node", () => ({
  PrivyClient: class {
    users() {
      return { getByCustomAuthID: lookup };
    }
  },
}));
const user = randomUUID(),
  address = Keypair.generate().publicKey.toBase58();
beforeEach(() => {
  lookup.mockReset();
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app";
  process.env.PRIVY_APP_SECRET = "test-only";
});
describe("Privy server-record wallet ownership", () => {
  it("binds the embedded Solana wallet and custom identity to the authenticated user", async () => {
    lookup.mockResolvedValue({
      id: "did:privy:test",
      linked_accounts: [
        { type: "custom_auth", custom_user_id: user },
        { type: "wallet", chain_type: "solana", address, wallet_client_type: "privy" },
      ],
    });
    await expect(verifyWallet(user, address)).resolves.toBe("did:privy:test");
    expect(lookup).toHaveBeenCalledWith({ custom_user_id: user });
  });
  it.each(["wrong_identity", "wrong_wallet", "external_wallet", "wrong_chain"])(
    "rejects %s",
    async (scenario) => {
      lookup.mockResolvedValue({
        id: "did:privy:test",
        linked_accounts: [
          {
            type: "custom_auth",
            custom_user_id: scenario === "wrong_identity" ? randomUUID() : user,
          },
          {
            type: "wallet",
            chain_type: scenario === "wrong_chain" ? "ethereum" : "solana",
            address:
              scenario === "wrong_wallet" ? Keypair.generate().publicKey.toBase58() : address,
            wallet_client_type: scenario === "external_wallet" ? "phantom" : "privy",
          },
        ],
      });
      await expect(verifyWallet(user, address)).rejects.toThrow("wallet_not_owned");
    },
  );
});
