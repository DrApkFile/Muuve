import { assert } from "../errors";
export async function verifyWallet(userId: string, address: string): Promise<string> {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    appSecret = process.env.PRIVY_APP_SECRET;
  assert(appId && appSecret, "privy_not_configured", 503);
  const { PrivyClient } = await import("@privy-io/node");
  const client = new PrivyClient({ appId, appSecret });
  const user = await client.users().getByCustomAuthID({ custom_user_id: userId });
  assert(
    user.linked_accounts.some((a) => a.type === "custom_auth" && a.custom_user_id === userId),
    "wallet_not_owned",
    403,
  );
  assert(
    user.linked_accounts.some(
      (a) =>
        a.type === "wallet" &&
        a.chain_type === "solana" &&
        a.address === address &&
        a.wallet_client_type === "privy",
    ),
    "wallet_not_owned",
    403,
  );
  return user.id;
}
