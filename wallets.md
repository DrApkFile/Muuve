# Muuve devnet wallets

These are real public addresses derived from locally generated, separate keypairs.
Private keys are under ignored `keys/` with restrictive permissions. Do not commit
or upload that directory. All activity is restricted to Solana **devnet**.

## Verified deployment and balances

The program is deployed, the dedicated test mint and treasury ATA exist, and Config
initialization/readiness verification passed. No additional SOL is currently needed
for the completed setup. Programmatic airdrop requests failed; the owner funded the
wallets, and subsequent deployment/testing used those devnet funds.

Finalized balance snapshot at **2026-10-29 08:45:23 UTC**:

| Wallet                         | Verified balance          |
| ------------------------------ | ------------------------- |
| Deployment / upgrade authority | **2.01390136 devnet SOL** |
| Transaction fee / rent payer   | **0.97164108 devnet SOL** |

## Funding addresses for future refills

Use <https://faucet.solana.com/> with devnet selected if later refills are needed.

Deployment / upgrade authority — target approximately **3.2 devnet SOL** available
for this build. The loader reuses buffer rent for ProgramData, and the deployment
sets `--max-len` to the artifact length. The initial conservative estimate counted
that rent twice. Deployment is complete; do not fund another deployment merely
because the remaining wallet balance is below its original setup budget:

```text
8QdwEAfREtpycxbCLEm8YhAC8CE5D941sqEmrXLx5HnD
```

Transaction fee / rent payer — target **1 devnet SOL** for setup and test operations:

```text
EXCRqXUPPtVsDLgYsqsd2Uo88NawAT5sUy35sqVk4hg8
```

Run `OPERATOR_APPROVED_DEVNET=1 node --env-file=.env.local --import tsx
scripts/devnet-status.ts` to refresh verified balances and the deployment estimate.
Results are written to `evidence/render-devnet/devnet-status.json`.

## All wallet roles

| Role                           | Public address                                 | Purpose                                                      |
| ------------------------------ | ---------------------------------------------- | ------------------------------------------------------------ |
| Deployment / upgrade authority | `8QdwEAfREtpycxbCLEm8YhAC8CE5D941sqEmrXLx5HnD` | Deploys and controls upgrades; excluded from Render.         |
| On-chain admin                 | `BvfPFXU4t6rkNHhAGJKTwWchFGszkf6A7io8DAspAdvN` | Signs initial configuration and later configuration updates. |
| Backend attestor               | `As2E5nQkD6sL7kWVMY6c44JgYfLAnHevpG85JZLgQ6Px` | Authorizes eligible claims after backend verification.       |
| Fee / rent payer               | `EXCRqXUPPtVsDLgYsqsd2Uo88NawAT5sUy35sqVk4hg8` | Pays backend transaction fees and account rent.              |
| Treasury owner                 | `6dWu1Y2b7oMCGmJkQfoDqnzGLjMsKXyFFdKoB9wwT12f` | Controls test tokens backing mock cash-outs and refunds.     |
| Test mint authority            | `6eG2i1arM6ei52bxj3XyhATwUvseRDNoJkL2VfMPX3kV` | Mints dedicated devnet test tokens.                          |
| Test sender                    | `BrMxuBfhPhXfyzpX8Hpnv1xo6W6nMyomKh8gXt4acT85` | Signs test funding and recalls.                              |
| Test recipient                 | `DCepsn6o7DR54zdU1egoPw7DMrLFygF1jFjRtH9rmXjW` | Receives dedicated test tokens in wallet-claim tests.        |

The other authorities do not need SOL merely to co-sign; the fee payer funds those
transactions. All identities are verified locally. Admin/attestor/fee payer/treasury/
mint authority also match on-chain Config and mint/token ownership. Sender and
recipient are bound to the observed finalized test transactions and token accounts.
A zero-SOL authority can still co-sign; its owner account need not hold SOL.

## Program and token identities

| Identity               | Public address                                 | Verified status                                                         |
| ---------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| Program ID             | `147uqUCHmuUgziXH31v352QycgSuxLgZfzN2MYE67Sxe` | Deployed; executable bytes and upgrade authority verified.              |
| Dedicated test mint    | `H9d97DiVPydaxKTWFxVYfAg3FLSsicqx9u2boCoMksQJ` | Created; six decimals, legacy SPL Token, no freeze authority.           |
| Treasury token account | `29vE2HKDM5MLmDytaFQXDCp4ejSBam8FrGqZhTC85XuC` | Created; canonical ATA, owner/mint verified.                            |
| Config PDA             | `9qa5jB5TrW1TBB9rk2t422cUTSoWTWJWoQYPgbZryy22` | Initialized; roles, mint, treasury, limits and 48-hour window verified. |

The treasury **owner wallet** and treasury **token account** are different addresses.
Faucet SOL goes to the two funding wallets above, not to the mint or token account.
See `config/devnet-public.json` for the full public identity manifest.

Deployment signature:

```text
ba7R5Yw4CiZms7DT8hU3XikCt5GHrMywRNpgLuGNMhpvTPGnYwbbmgrrdzSQuJoaoFzsXXKJaRkXFyq6GHCSoCy
```

[View the finalized devnet deployment](https://explorer.solana.com/tx/ba7R5Yw4CiZms7DT8hU3XikCt5GHrMywRNpgLuGNMhpvTPGnYwbbmgrrdzSQuJoaoFzsXXKJaRkXFyq6GHCSoCy?cluster=devnet).

## Actual test-token distribution and pending expiry

Seven dedicated test tokens were minted. Verified distribution: sender **2**, test
recipient **2**, treasury **2**, expiry vault **1**. Single and batch settlement
vaults closed; the separate expiry fixture remains funded intentionally.

Expiry fixture:

```text
Hg9tsPmCdDBMbWcUEwepRGcNyUfxGubSaFBPYzxdFtde
```

Its actual deadline is **31 October 2026, 08:39:30 UTC / 09:39:30 Lagos**. The devnet
expiry refund is not verified yet. Leave this fixture funded for that test; never
shorten its 48-hour window. See `docs/devnet-operations.md` for the gated expiry command.
Actual signatures and account verification are in `evidence/devnet/`.
