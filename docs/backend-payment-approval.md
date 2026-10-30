# Backend-only devnet payment test — operator review

Prepared 30 October 2026. This document requests approval; it is not a record of
approval or a successful funded test. Browser and Privy embedded-wallet tests remain
outside this run. All payouts remain mocked.

Subsequent status: the owner approved this exact budget. Approval and actual results
are recorded separately in `evidence/backend-payment/approval.json` and the
[backend verification report](handoff/2026-10-30-backend-payment-verification.md).
The unsigned review preparation below expired and was cancelled; the approved run
used fresh IDs and transactions. Do not reuse the old preparation.

## Verified prerequisites

- Hosted API: `https://muuve.onrender.com`.
- Intended Supabase project: `yirelxmcveyxcqofzayq`, six checked migrations,
  certificate-verified TLS, and matching local-worker/API database targets.
- Actual devnet program: `147uqUCHmuUgziXH31v352QycgSuxLgZfzN2MYE67Sxe`.
- Test mint: `H9d97DiVPydaxKTWFxVYfAg3FLSsicqx9u2boCoMksQJ`, legacy SPL Token,
  six decimals. Treasury: `29vE2HKDM5MLmDytaFQXDCp4ejSBam8FrGqZhTC85XuC`.
- Sender: `BrMxuBfhPhXfyzpX8Hpnv1xo6W6nMyomKh8gXt4acT85`, verified balance
  **2000000 base units** (2 test tokens) during this preflight.
- Fee payer: `EXCRqXUPPtVsDLgYsqsd2Uo88NawAT5sUy35sqVk4hg8`, verified
  **971641080 lamports** (0.97164108 devnet SOL).
- Two distinct authorized recipient phone numbers are configured privately. No SMS
  was sent during preparation. The external-wallet sender requires no phone proof.
- The initial hosted database had zero active operations, payouts, principals,
  pending/running jobs or active maintenance leases. One bounded local-worker probe
  subsequently completed two obsolete-payout no-op jobs without releasing principal.

## Requested authorization and bounds

| Fixture                 | Fixed allocations in base units | Maximum new funding | Intended result                                                                                                                       |
| ----------------------- | ------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Main batch              | 500000 + 1000000                | 1500000             | Two independent phone-verified treasury claims. Mock success and mock failure/retry; verify one logical principal release per slot.   |
| Separate recall batch   | 100000 + 100000                 | 200000              | Sender-only recall-one/recall-all, refunds to the original sender and vault/rent verification.                                        |
| Separate expiry fixture | 100000 + 100000                 | 200000              | Fund a new fixture with the real 48-hour deadline; later verify only remaining slots refund. No shortened expiry or premature refund. |

Total new escrow funding ceiling: **1900000 base units (1.9 devnet test tokens)**,
leaving at least 100000 from the verified sender balance before any refunds. Maximum
fee-payer budget: **0.05 devnet SOL for transaction fees and account rent combined**.
Recheck balances/configuration and enforce budgets before execution. No airdrop,
minting, real assets, real NGN transfer, program deployment, shared migration,
original-customer-record changes or Privy/browser enrollment is requested.

Approval would cover the listed devnet funding, bounded claim-intent and treasury
claim transactions, authorized sender recalls and due expiry/refunds, along with
scoped reconciliation and mock-provider processing for those exact test fixtures.
Negative/duplicate tests must not create another principal release. If any outcome
is uncertain, reconcile the existing signature/operation before another submission.
Stop for review if the requested scope, balances, recipients, destination or budgets
cannot be preserved. Existing raw contract fixtures remain separate evidence.

## Concrete unsigned preparation reviewed

The hosted API created this review-only preparation:

- Link UUID: `d2b10316-973e-48e3-bd1d-08a7c80ab221`.
- Operation UUID: `a2c7a3c0-ac60-4149-b350-5825d8c2983f`.
- Link PDA: `36C4nk7tAmKyNWhgmahGa7MC91efYZgyytwJWqbXCi9M`.
- Vault: `89L6dJKheWsqeykGMUhviV3c18APM8kRELkriXKVfWSt`.
- Sender token account: `3S2qKvoe7kHTxa8z15J17zagjBNBHvQ9cUAnHH6PY7uS`.
- Message SHA-256: `9a545ade6b7caf09e4f9cf9e6231397a6caf9977c16c17c6a7cbe9a37b51b644`.
- Last valid block height: `503784651`.
- Exactly three instructions: bounded compute-unit limit, expected escrow
  `create_link` and a public UUID memo. Program/mint/token-program/PDA/ATA/account
  flags, claim public key and fixed amounts matched the intended request.
- Existing fee-payer signature verified. Sender signature was absent; no funding
  transaction was signed by the sender or submitted. No funded link account existed.
- Hosted slot phones and allocations matched the private authorized inputs.
  The claim private key remained in ignored, mode-0600 local progress storage.

**The reviewed preparation is short-lived.** Do not sign or submit it after expiry.
The preparatory verifier can safely reconcile it after finalized blockhash expiry,
cancel the unfunded link and release its reservation. A later approved execution
requires a fresh server preparation and a fresh review of the same approved terms;
approval never permits blind reuse, message mutation or a stale blockhash.

No successful funding, claim, mock payout, recall or expiry is claimed by this review.
The expiry test requires the actual 48-hour deadline and cannot finish immediately.
