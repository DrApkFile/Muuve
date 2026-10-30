# Four-minute devnet expiry — shared-environment review

Prepared 30 October 2026. This is a concrete review, not execution evidence or a
record of operator approval. No mainnet, real assets, real fiat, account reset or
existing-link deadline modification is proposed.

## Verified read-only upgrade inputs

From `evidence/demo-expiry/upgrade-review-facac9be-9230-4d67-b32c-e9b2f19bba96.json`:

| Item                                                   | Reviewed value                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| Cluster                                                | Solana devnet, verified genesis                                    |
| Stable program                                         | `147uqUCHmuUgziXH31v352QycgSuxLgZfzN2MYE67Sxe`                     |
| Upgrade authority                                      | `8QdwEAfREtpycxbCLEm8YhAC8CE5D941sqEmrXLx5HnD`                     |
| New artifact                                           | `target/sbf-check/sbpf-solana-solana/release/muuve_escrow.so`      |
| Artifact SHA-256                                       | `2aeacaeeee96893acb856944acec0c2d1c4d501614c25c53a12ed7df8877f456` |
| Source fingerprint                                     | `f5b85839f848405c6b760d1f9d33c994371516d3bf2e8fa9ace52726acb555b5` |
| Artifact length                                        | 591808 bytes                                                       |
| Current program capacity                               | 586896 bytes                                                       |
| Required extension                                     | 4912 bytes                                                         |
| Additional program rent estimate                       | 24952960 lamports                                                  |
| New buffer rent estimate                               | 3007222840 lamports                                                |
| Conservative upfront requirement, including fee margin | 3082175800 lamports                                                |
| Authority balance at review                            | 7013901360 lamports                                                |

The buffer balance is normally returned during a successful upgrade. Upfront
requirements are distinct from permanent rent and fees. Recheck exact hashes,
loader authority, balance, rent and capacity immediately before any action. Do not
request funds or use another key if they differ. The existing initial-deployment
script rejects a different binary and must not be used to bypass upgrade review.

## Proposed authority actions

After local native/SBF verification, explicitly approve these actions as one scope:

1. Extend the same devnet program by the verified 4912 bytes and upgrade to the
   exact reviewed artifact. Preserve program identity, authority, Config and Link
   layouts. Record signatures before broadcast, reconcile uncertain loader steps
   and verify finalized deployed bytes and authority before proceeding.
2. Simulate the new admin instruction, then set Config's future claim window to
   240 seconds with `scripts/set-claim-window.ts --seconds=240 --execute
--operator-approved-window-change` and its documented environment guards.
   Change no other Config fields and verify finalized state.
3. Coordinate `CLAIM_WINDOW_SECS=240` with the owner's Render API deployment and
   local worker environment; keep `APP_ENV=preview`. The owner handles push/Render
   deployment. Existing funded links retain their original deadline.

The initial unsigned review of the currently deployed program returned custom
error 101. No configuration transaction was signed/submitted. Setting the variable
alone cannot make a four-minute link and would cause readiness mismatch.

## Proposed additional expiry fixture

The original 1.9-test-token gross funding budget has been used. For the new short
fixture, request **100000 additional base units (0.1 test token)**, using the
existing dedicated sender and mint, one controlled recipient, a fresh sender-local
ID, operation and client-held claim key. This increases the total new escrow
funding allowance to 2.0 test tokens. Recheck its balance before preparing.

Reserve at most **0.01 devnet SOL** for this fixture's creation/expiry fees and rent
within the original fee-payer ceiling of 0.05 SOL; reconcile previous actual debits
and outstanding reservations first. The separate deployment-authority allowance
above is additional and must not be silently charged to the payment-test budget.

Review the exact prepared message, accounts and allocations before signing. Record
its original creation/deadline, observe 240 actual on-chain seconds, verify early
expiry rejection, reject claim/recall at the deadline, refund only its unclaimed
principal, and verify sender balance, vault closure, original rent beneficiary and
hosted SQL state. Never shorten either existing 48-hour fixture.

## Existing cashout batch

The already-approved funded batch and its 500000/1000000 allocations can continue
with real Textbee phone verification after the owner deploys the new API. Its two
original recipient phones must remain unchanged. Intent/treasury claim and scoped
mock payout/retry processing fall within that prior approved batch scope. No new
funding or program upgrade is needed merely to continue those cashouts.
