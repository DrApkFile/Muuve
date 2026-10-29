import { createMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { operatorConnection, requiredPublic } from "./operator";
import { keypair } from "../apps/web/lib/server/config";
import { assert } from "../apps/web/lib/server/errors";
import { AppError } from "../apps/web/lib/server/errors";
async function main() {
  const connection = await operatorConnection(),
    payer = keypair("FEE_PAYER_SECRET"),
    authority = keypair("TEST_MINT_AUTHORITY_SECRET"),
    program = requiredPublic("TOKEN_PROGRAM_ID");
  assert(!payer.publicKey.equals(authority.publicKey), "role_collision");
  assert(
    program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID),
    "unsupported_token_program",
  );
  const mint = await createMint(
    connection,
    payer,
    authority.publicKey,
    null,
    6,
    undefined,
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
