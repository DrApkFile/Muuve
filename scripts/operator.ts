import { Connection, PublicKey } from "@solana/web3.js";
import { DEVNET_GENESIS } from "../apps/web/lib/server/solana/chain";
import { assert } from "../apps/web/lib/server/errors";
export async function operatorConnection() {
  assert(process.env.OPERATOR_APPROVED_DEVNET === "1", "operator_approval_required");
  assert(
    process.env.SOLANA_CLUSTER === "devnet" && process.env.SOLANA_RPC_URL,
    "devnet_configuration_required",
  );
  const connection = new Connection(process.env.SOLANA_RPC_URL, "finalized");
  assert((await connection.getGenesisHash()) === DEVNET_GENESIS, "devnet_required");
  return connection;
}
export function requiredPublic(name: string) {
  assert(process.env[name], `missing_${name}`);
  return new PublicKey(process.env[name]!);
}
