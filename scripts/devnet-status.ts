import { readFile, mkdir, writeFile } from "node:fs/promises";
import { PublicKey } from "@solana/web3.js";
import { operatorConnection } from "./operator";
try {
  const c = await operatorConnection();
  const manifest = JSON.parse(await readFile("config/devnet-public.json", "utf8"));
  const accounts = await c.getMultipleAccountsInfo(
    Object.values(manifest.roles).map((r: any) => new PublicKey(r.public_key)),
    "finalized",
  );
  const roles = Object.entries(manifest.roles).map(([role, r]: [string, any], i) => ({
    role,
    address: r.public_key,
    lamports: accounts[i]?.lamports ?? 0,
    account_exists: !!accounts[i],
    verified_on_chain: true,
  }));
  const artifact = await readFile("target/sbf-check/sbpf-solana-solana/release/muuve_escrow.so");
  const rent = await c.getMinimumBalanceForRentExemption(artifact.length + 45);
  const bufferRent = await c.getMinimumBalanceForRentExemption(artifact.length + 37);
  const programRent = await c.getMinimumBalanceForRentExemption(36);
  const deployed = !!accounts[Object.keys(manifest.roles).indexOf("program")]?.executable;
  const bufferBalance =
    accounts[Object.keys(manifest.roles).indexOf("deployment-buffer")]?.lamports ?? 0;
  const authorityBalance = roles.find((role) => role.role === "deployment-authority")!.lamports;
  // Agave funds the buffer with ProgramData rent, then the loader reuses it.
  // Do not count the same rent twice. --max-len is the exact artifact length.
  const record = {
    state: "verified",
    network: "devnet",
    verified_at: new Date().toISOString(),
    program_id: manifest.program_id,
    program_deployed: deployed,
    artifact_bytes: artifact.length,
    programdata_rent_lamports: rent,
    temporary_buffer_minimum_rent_lamports: bufferRent,
    buffer_rent_reused: true,
    program_account_rent_lamports: programRent,
    deployment_target_lamports: Math.max(rent, bufferRent) + programRent + 200_000_000,
    additional_deployment_funding_needed_lamports: deployed
      ? 0
      : Math.max(
          0,
          Math.max(rent, bufferRent) - bufferBalance + programRent + 200_000_000 - authorityBalance,
        ),
    fee_payer_target_lamports: 1_000_000_000,
    roles,
  };
  await mkdir("evidence/render-devnet", { recursive: true });
  await writeFile(
    "evidence/render-devnet/devnet-status.json",
    JSON.stringify(record, null, 2) + "\n",
  );
  console.info(JSON.stringify(record));
} catch {
  console.error("Devnet status failed; no deployment or funding result inferred.");
  process.exitCode = 1;
}
