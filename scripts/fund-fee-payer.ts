import { operatorConnection } from "./operator";
import { keypair } from "../apps/web/lib/server/config";
import { AppError } from "../apps/web/lib/server/errors";
async function main() {
  const c = await operatorConnection(),
    payer = keypair("FEE_PAYER_SECRET");
  // Read-only: funding remains an explicit operator wallet/faucet action.
  console.info(
    JSON.stringify({
      fee_payer: payer.publicKey.toBase58(),
      lamports: await c.getBalance(payer.publicKey, "finalized"),
      minimum_recommended_lamports: 2_000_000_000,
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
