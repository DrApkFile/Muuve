import {
  createMint,
  getMint,
  getExtensionTypes,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { assertExtensions } from "../apps/web/lib/server/solana/chain";
import { operatorConnection, requiredPublic } from "./operator";
import { keypair } from "../apps/web/lib/server/config";
import { assert } from "../apps/web/lib/server/errors";
import { AppError } from "../apps/web/lib/server/errors";
async function main() {
  const connection = await operatorConnection(),
    payer = keypair("FEE_PAYER_SECRET"),
    authority = keypair("TEST_MINT_AUTHORITY_SECRET"),
    program = requiredPublic("TOKEN_PROGRAM_ID"),
    identity = keypair("TEST_MINT_SECRET"),
    intended = requiredPublic("USDT_MINT");
  assert(identity.publicKey.equals(intended), "mint_identity_mismatch");
  assert(!payer.publicKey.equals(authority.publicKey), "role_collision");
  assert(
    program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID),
    "unsupported_token_program",
  );
  const existing = await connection.getAccountInfo(intended, "finalized");
  if (existing) {
    const mint = await getMint(connection, intended, "finalized", program);
    assert(
      mint.decimals === 6 &&
        !mint.freezeAuthority &&
        mint.mintAuthority?.equals(authority.publicKey),
      "mint_configuration_mismatch",
    );
    assertExtensions(getExtensionTypes(mint.tlvData));
    console.info(JSON.stringify({ mint: intended.toBase58(), state: "existing_verified" }));
    return;
  }
  const mint = await createMint(
    connection,
    payer,
    authority.publicKey,
    null,
    6,
    identity,
    { commitment: "finalized" },
    program,
  );
  console.info(
    JSON.stringify({
      mint: mint.toBase58(),
      token_program: program.toBase58(),
      decimals: 6,
      extensions: [],
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
