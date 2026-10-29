import { PublicKey, Transaction } from "@solana/web3.js";
import { operatorConnection, requiredPublic } from "./operator";
import { keypair } from "../apps/web/lib/server/config";
import { ix, meta, u64 } from "../apps/web/lib/server/solana/codec";
import { SystemProgram, BPF_LOADER_UPGRADEABLE_PROGRAM_ID } from "./solana-ids";
import { AppError } from "../apps/web/lib/server/errors";
async function main() {
  const connection = await operatorConnection(),
    payer = keypair("FEE_PAYER_SECRET"),
    admin = keypair("OPERATOR_ADMIN_SECRET"),
    deployment = keypair("OPERATOR_DEPLOYMENT_SECRET"),
    attestor = keypair("ATTESTOR_SECRET"),
    treasury = keypair("TREASURY_SECRET");
  const program = requiredPublic("MUUVE_PROGRAM_ID"),
    mint = requiredPublic("USDT_MINT"),
    token = requiredPublic("TOKEN_PROGRAM_ID"),
    destination = requiredPublic("TREASURY_TOKEN_ACCOUNT");
  const config = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0],
    programData = PublicKey.findProgramAddressSync(
      [program.toBuffer()],
      BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
    )[0];
  const instruction = ix(
    program,
    "init_config",
    [
      meta(payer.publicKey, true, true),
      meta(admin.publicKey, false, true),
      meta(deployment.publicKey, false, true),
      meta(program),
      meta(programData),
      meta(config, true),
      meta(mint),
      meta(destination),
      meta(treasury.publicKey),
      meta(token),
      meta(SystemProgram.programId),
    ],
    attestor.publicKey.toBuffer(),
    payer.publicKey.toBuffer(),
    u64(500_000_000),
    u64(1_000_000_000),
  );
  const life = await connection.getLatestBlockhash("finalized"),
    tx = new Transaction({ feePayer: payer.publicKey, ...life }).add(instruction);
  tx.sign(
    ...[payer, admin, deployment].filter(
      (v, i, a) => a.findIndex((k) => k.publicKey.equals(v.publicKey)) === i,
    ),
  );
  const signature = await connection.sendRawTransaction(tx.serialize());
  const result = await connection.confirmTransaction({ ...life, signature }, "finalized");
  if (result.value.err) throw new Error("Config initialization failed");
  console.info(JSON.stringify({ signature, config: config.toBase58() }));
}
main().catch((error: unknown) => {
  console.error(
    error instanceof AppError
      ? error.code
      : "Operator action failed; reconcile any recorded signature before retrying. See docs/backend-runbook.md.",
  );
  process.exitCode = 1;
});
