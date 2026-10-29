import { Connection, PublicKey } from "@solana/web3.js";
import { DEVNET_GENESIS } from "../apps/web/lib/server/solana/chain";
import { assert } from "../apps/web/lib/server/errors";
import { setTimeout as pause } from "node:timers/promises";
export async function operatorConnection() {
  assert(process.env.OPERATOR_APPROVED_DEVNET === "1", "operator_approval_required");
  assert(
    process.env.SOLANA_CLUSTER === "devnet" && process.env.SOLANA_RPC_URL,
    "devnet_configuration_required",
  );
  let requestQueue = Promise.resolve(),
    lastRequestAt = 0;
  const connection = new Connection(process.env.SOLANA_RPC_URL, {
    commitment: "finalized",
    disableRetryOnRateLimit: true,
    fetch: async (input, init) => {
      const previous = requestQueue;
      let unlock!: () => void;
      requestQueue = new Promise<void>((r) => {
        unlock = r;
      });
      await previous;
      try {
        for (let attempt = 0; attempt < 6; attempt++) {
          await pause(Math.max(0, 500 - (Date.now() - lastRequestAt)));
          lastRequestAt = Date.now();
          const response = await fetch(input, { ...init, signal: AbortSignal.timeout(15000) });
          if (response.status !== 429 || attempt === 5) return response;
          const retryAfter = Number(response.headers.get("retry-after"));
          await response.body?.cancel();
          await pause(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 60000)
              : Math.min(1000 * 2 ** attempt, 30000),
          );
        }
        throw new Error("operator_rpc_rate_limited");
      } finally {
        unlock();
      }
    },
  });
  assert((await connection.getGenesisHash()) === DEVNET_GENESIS, "devnet_required");
  return connection;
}
export function requiredPublic(name: string) {
  assert(process.env[name], `missing_${name}`);
  return new PublicKey(process.env[name]!);
}
