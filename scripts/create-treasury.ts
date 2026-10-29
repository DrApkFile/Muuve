import { getOrCreateAssociatedTokenAccount, getMint, getExtensionTypes } from "@solana/spl-token";
import { operatorConnection, requiredPublic } from "./operator";
import { keypair } from "../apps/web/lib/server/config";
import { assertExtensions } from "../apps/web/lib/server/solana/chain";
import { assert } from "../apps/web/lib/server/errors";
import { AppError } from "../apps/web/lib/server/errors";
async function main() {
  const connection = await operatorConnection(),
    payer = keypair("FEE_PAYER_SECRET"),
    owner = keypair("TREASURY_SECRET"),
    mint = requiredPublic("USDT_MINT"),
    token = requiredPublic("TOKEN_PROGRAM_ID");
  const info = await getMint(connection, mint, "finalized", token);
  assert(info.decimals === 6 && !info.freezeAuthority, "unsupported_mint");
  assertExtensions(getExtensionTypes(info.tlvData));
  assert(!payer.publicKey.equals(owner.publicKey), "role_collision");
  const account = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    owner.publicKey,
    false,
    "finalized",
    { commitment: "finalized" },
    token,
  );
  console.info(
    JSON.stringify({
      treasury_token_account: account.address.toBase58(),
      owner: owner.publicKey.toBase58(),
      mint: mint.toBase58(),
    }),
  );
}
main().catch((error: unknown) => {
  console.error(
    error instanceof AppError
      ? error.code
      : "Operator action failed; reconcile any recorded signature before retrying. See docs/backend-runbook.md.",
  );
  process.exitCode = 1;
});
