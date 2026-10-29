# Devnet operator sequence

Current public identities and funding instructions are in [wallets.md](../wallets.md).
Private key files and `.env.local` are ignored and protected; never print or commit
them. The owner explicitly authorized devnet provisioning and deployment in this
milestone. Builds/default tests do not submit transactions.

The stable program ID is configured in `Anchor.toml`, `.env.local` and
`config/devnet-public.json`. The Rust declaration is generated from `MUUVE_PROGRAM_ID`
at build time; the SBF builder records that ID and source/artifact fingerprints.
The public native-test fallback is not the deployment ID. The deploy script refuses
a fixture, a stale build, a mismatched identity or a differently deployed binary.

## Build and verify

```sh
CARGO_HOME="$PWD/.cache/cargo" SBF_TOOLCHAIN_ROOT="$PWD/.cache/platform-tools-v1.58" \
  node --env-file=.env.local scripts/build-sbf.mjs
CARGO_HOME="$PWD/.cache/cargo" pnpm test:sbf
CARGO_HOME="$PWD/.cache/cargo" node --env-file=.env.local scripts/build-idl.mjs
OPERATOR_APPROVED_DEVNET=1 node --env-file=.env.local --import tsx scripts/devnet-status.ts
```

The status check verifies devnet genesis, reads public account balances and computes
rent from the actual artifact. Agave's initial deployment reuses the buffer balance
for ProgramData. The deploy script specifies the exact artifact size as `--max-len`;
it does not reserve double size for possible future growth. The estimate includes
0.2 SOL margin and the program account. Increasing program size later requires an
explicit reviewed upgrade/extension. Do not transfer mainnet funds.

## Authorized network actions

Run these in order, stopping and reconciling any uncertain result before proceeding:

```sh
OPERATOR_APPROVED_DEVNET=1 node --env-file=.env.local --import tsx scripts/deploy-devnet.ts --paced
OPERATOR_APPROVED_DEVNET=1 node --env-file=.env.local --import tsx scripts/create-test-mint.ts
OPERATOR_APPROVED_DEVNET=1 node --env-file=.env.local --import tsx scripts/create-treasury.ts
OPERATOR_APPROVED_DEVNET=1 node --env-file=.env.local --import tsx scripts/init-config.ts
node --env-file=.env.local --import tsx scripts/verify-devnet.ts
OPERATOR_APPROVED_DEVNET=1 node --env-file=.env.local --import tsx scripts/fund-test-sender.ts
OPERATOR_APPROVED_DEVNET=1 MUUVE_RUN_DEVNET_TRANSACTIONS=1 \
  node --env-file=.env.local --import tsx scripts/devnet-integration.ts
```

Deployment uses the existing local Solana CLI 2.3.13 unless `SOLANA_CLI` explicitly
selects another executable. Every command pins the devnet RPC and signer paths; no
global Solana wallet/cluster configuration is changed. An existing buffer key makes
interrupted deployment resumable without generating or printing a recovery phrase.
The public RPC bulk CLI upload stopped after partially filling this buffer. The
`--paced` path reads and validates its authority, writes only differing chunks,
records every signature before broadcast, respects HTTP 429 backoff and verifies
all finalized bytes before a simulated and finalized loader deployment. Its wire
format/accounts are independently cross-checked against the pinned Rust SDK.
Only a matching existing program is accepted; the wrapper does not silently upgrade
a different binary. Verify program, ProgramData, exact bytes and upgrade authority.

Mint creation uses a stable local mint identity. If it exists, its owner, authority,
six decimals, lack of freeze authority and extension allowlist must match. Treasury
setup uses its canonical ATA. Config initialization requires both admin and the
legitimate upgrade authority, and an existing Config must match instead of being
overwritten. This deployment uses legacy SPL Token. The immutable mint means a
separate deployment is necessary for a real-devnet Token-2022 verification run.

Test funding mints exactly seven dedicated test tokens, protected by one durable
operation receipt. Its signed transaction stays in an ignored 0600 local file;
public evidence contains its ID/signature, not the transaction. An expired/unknown
funding operation must be reconciled before any replacement/new funding. No script
requests real money or talks to a fiat provider.

## Integration evidence and expiry

The runner tests single and multi-slot creation, independent wallet/treasury claims,
recipient priority, sender recall and rebroadcasting identical creation bytes. It
also simulates failures against the deployed program with signature verification:
wrong claim key/attestor/destination, invalid slot, unauthorized recall, duplicate
claim, protected-slot recall and premature expiry. Simulation rejection evidence is
distinct from finalized transaction evidence. It never substitutes for backend
phone/session/wallet-ownership checks or live Privy/API end-to-end verification.

If interrupted, set `MUUVE_DEVNET_RESUME_EVIDENCE` to the existing public run file.
The runner verifies recorded signatures are finalized and checks the original
fixture allocations/claim key before reusing its PDAs. It does not mint another
seven tokens or create replacement funded links merely because an RPC call failed.
Identical rebroadcast can return AlreadyProcessed; the original signature is
reconciled instead of being represented as a failed transfer. The explicit
`scripts/verify-devnet-evidence.ts` audit verifies terminal states, vault closure,
token supply/distribution and a signature-only unauthorized recall rejection.

Without an aged fixture, it creates a separate one-token expiry fixture and records
its real creation/deadline. The run remains incomplete for the 48-hour expiry case.
Do not rerun the entire funded integration merely to expire that fixture. After its
actual on-chain deadline, use the recorded PDA:

```sh
OPERATOR_APPROVED_DEVNET=1 MUUVE_RUN_DEVNET_TRANSACTIONS=1 \
MUUVE_DEVNET_EXPIRED_LINK_PDA=THE_RECORDED_PDA \
  node --env-file=.env.local --import tsx scripts/verify-expiry.ts
```

The expiry script records the signature before broadcast and verifies finalized
execution, unchanged allocations and terminal slot states, the exact sender token
refund, vault closure and rent returned to the recorded beneficiary. These checks
require the actual deadline; preparing the verifier is not a passing expiry result.
Existing evidence files prevent accidental
unreviewed retry after an ambiguous outcome. Never shorten Config's claim window to
manufacture a passing devnet expiry check.

Evidence lives in `evidence/render-devnet/` and `evidence/devnet/`. A configured
address or successful build is not evidence of a deployed or initialized account.
