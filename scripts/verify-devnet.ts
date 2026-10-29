import { Connection, PublicKey } from "@solana/web3.js";
import {
  getMint,
  getAccount,
  getExtensionTypes,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { DEVNET_GENESIS, assertExtensions } from "../apps/web/lib/server/solana/chain";
import { decodeConfig, decodeLink } from "../apps/web/lib/server/solana/codec";
import { assert } from "../apps/web/lib/server/errors";
// Read-only verification deliberately requires public role identities, not private keys.
async function main() {
  const required = [
    "SOLANA_CLUSTER",
    "SOLANA_RPC_URL",
    "MUUVE_PROGRAM_ID",
    "USDT_MINT",
    "TOKEN_PROGRAM_ID",
    "TREASURY_TOKEN_ACCOUNT",
    "ADMIN_PUBLIC_KEY",
    "ATTESTOR_PUBLIC_KEY",
    "FEE_PAYER_PUBLIC_KEY",
    "TREASURY_OWNER_PUBLIC_KEY",
    "TEST_MINT_AUTHORITY_PUBLIC_KEY",
  ];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.info(JSON.stringify({ state: "blocked", missing_configuration_names: missing }));
    process.exitCode = 1;
    return;
  }
  assert(process.env.SOLANA_CLUSTER === "devnet", "devnet_required");
  const urls = [
    process.env.SOLANA_RPC_URL!,
    ...(process.env.SOLANA_RPC_URL_FALLBACK ? [process.env.SOLANA_RPC_URL_FALLBACK] : []),
  ];
  const connections = urls.map((url) => new Connection(url, "finalized"));
  for (const connection of connections)
    assert((await connection.getGenesisHash()) === DEVNET_GENESIS, "devnet_required");
  const c = connections[0]!,
    program = new PublicKey(process.env.MUUVE_PROGRAM_ID!);
  const executable = await c.getAccountInfo(program);
  assert(executable?.executable, "program_not_deployed");
  const configPda = PublicKey.findProgramAddressSync([Buffer.from("config")], program)[0],
    account = await c.getAccountInfo(configPda);
  assert(account && account.owner.equals(program), "config_not_initialized");
  const state = decodeConfig(account.data);
  const roles = {
    admin: "ADMIN_PUBLIC_KEY",
    attestor: "ATTESTOR_PUBLIC_KEY",
    feePayer: "FEE_PAYER_PUBLIC_KEY",
    treasuryOwner: "TREASURY_OWNER_PUBLIC_KEY",
    mintAuthority: "TEST_MINT_AUTHORITY_PUBLIC_KEY",
  } as const;
  for (const [field, name] of Object.entries(roles))
    assert(state[field as keyof typeof roles] === process.env[name], "role_identity_mismatch");
  assert(
    new Set(Object.keys(roles).map((field) => state[field as keyof typeof roles])).size === 5,
    "role_collision",
  );
  assert(
    state.mint === process.env.USDT_MINT &&
      state.tokenProgram === process.env.TOKEN_PROGRAM_ID &&
      state.treasury === process.env.TREASURY_TOKEN_ACCOUNT &&
      state.claimWindow === 172800,
    "config_mismatch",
  );
  const token = new PublicKey(state.tokenProgram),
    mintKey = new PublicKey(state.mint);
  assert(
    token.equals(TOKEN_PROGRAM_ID) || token.equals(TOKEN_2022_PROGRAM_ID),
    "unsupported_token_program",
  );
  const mint = await getMint(c, mintKey, "finalized", token);
  assert(
    mint.decimals === 6 &&
      !mint.freezeAuthority &&
      mint.mintAuthority?.toBase58() === state.mintAuthority,
    "mint_configuration_mismatch",
  );
  assertExtensions(getExtensionTypes(mint.tlvData));
  const treasury = await getAccount(c, new PublicKey(state.treasury), "finalized", token);
  assert(
    treasury.owner.toBase58() === state.treasuryOwner &&
      treasury.mint.equals(mintKey) &&
      !treasury.delegate &&
      !treasury.closeAuthority &&
      getAssociatedTokenAddressSync(mintKey, treasury.owner, false, token).equals(treasury.address),
    "treasury_configuration_mismatch",
  );
  assertExtensions(getExtensionTypes(treasury.tlvData), true);
  console.info(
    JSON.stringify(
      {
        network: "devnet",
        genesis: DEVNET_GENESIS,
        program: program.toBase58(),
        config: state,
        verified_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  if (process.env.MUUVE_DEVNET_LINK_PDA) {
    const info = await c.getAccountInfo(new PublicKey(process.env.MUUVE_DEVNET_LINK_PDA));
    assert(info && info.owner.equals(program), "fixture_missing");
    const link = decodeLink(info.data);
    assert(link.expiresAt - link.createdAt === 172800, "claim_window_mismatch");
    console.info(
      JSON.stringify({
        fixture: process.env.MUUVE_DEVNET_LINK_PDA,
        slotCount: link.slotCount,
        openSlots: link.openSlots,
      }),
    );
  }
}
main().catch(() => {
  console.error(
    "Devnet verification failed. Check public configuration and the operator runbook; no private key is required.",
  );
  process.exitCode = 1;
});
