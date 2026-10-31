import { assert, AppError } from "../errors";
export async function verifyWallet(userId: string, address: string): Promise<string> {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    appSecret = process.env.PRIVY_APP_SECRET;
  assert(appId && appSecret, "privy_not_configured", 503);
  const { PrivyClient } = await import("@privy-io/node");
  const client = new PrivyClient({ appId, appSecret, timeout: 10000, maxRetries: 0 });
  const user = await client
    .users()
    .getByCustomAuthID({ custom_user_id: userId })
    .catch((error: unknown) => {
      // Missing membership denies ownership. Provider failures remain retryable;
      // raw SDK messages can include upstream details and must not escape.
      if (error && typeof error === "object" && "status" in error && error.status === 404)
        throw new AppError("wallet_not_owned", 403);
      throw new AppError("privy_unavailable", 503);
    });
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
// Muuve-created accounts (recipients keeping dollars) get a Privy embedded Solana wallet
// generated server-side for their custom-auth identity. If they later sign in to Privy
// with the bridge JWT (sub = Muuve user ID), it's the same Privy user and wallet.
export async function ensureEmbeddedWallet(userId: string): Promise<string> {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID,
    appSecret = process.env.PRIVY_APP_SECRET;
  assert(appId && appSecret, "privy_not_configured", 503);
  const { PrivyClient } = await import("@privy-io/node");
  const users = new PrivyClient({ appId, appSecret, timeout: 15000, maxRetries: 1 }).users();
  const unavailable = () => {
    throw new AppError("privy_unavailable", 503);
  };
  type PrivyUser = Awaited<ReturnType<typeof users.getByCustomAuthID>>;
  const solana = (user: PrivyUser) =>
    user.linked_accounts.find(
      (a) => a.type === "wallet" && a.chain_type === "solana" && a.wallet_client_type === "privy",
    ) as { address: string } | undefined;
  let user: PrivyUser = await users
    .getByCustomAuthID({ custom_user_id: userId })
    .catch(async (error: unknown) => {
      if (!(error && typeof error === "object" && "status" in error && error.status === 404))
        return unavailable();
      return users
        .create({
          linked_accounts: [{ type: "custom_auth", custom_user_id: userId }],
          wallets: [{ chain_type: "solana" }],
        })
        .catch(unavailable);
    });
  if (!solana(user))
    user = await users
      .pregenerateWallets(user.id, { wallets: [{ chain_type: "solana" }] })
      .catch(unavailable);
  const wallet = solana(user);
  assert(wallet, "privy_unavailable", 503);
  return wallet.address;
}
