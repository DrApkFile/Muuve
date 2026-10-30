# Muuve backend handoff — 30 October 2026

Prepared at the owner's request around **12:14 UTC / 13:14 Lagos**. The owner
explicitly stopped this testing session and requested documentation for another
agent. No further OTP requests, claims, funding, payouts, upgrades or worker runs
should be inferred from this handoff. Resume only under the owner's next task and
the applicable approval gates.

## Start here

1. Read `CLAUDE.md` and `docs/backend-decisions.md`, then inspect Git status and the
   actual scripts. Preserve all current changes. Work on **main only**; do not create
   a branch, commit, push or deploy for the owner. The owner handles Render deployment.
2. Read [frontend integration](docs/frontend-integration.md) for the current client
   contract and readiness. No browser frontend was found in this workspace; browser
   integration and recipient embedded-wallet enrollment remain unverified.
3. Read [Textbee implementation](docs/handoff/2026-10-30-textbee-demo-expiry.md),
   [hosted continuation](docs/handoff/2026-10-30-textbee-hosted-verification.md),
   [original funded tests](docs/handoff/2026-10-30-backend-payment-verification.md),
   [payment approval](docs/backend-payment-approval.md) and
   [demo upgrade review](docs/demo-expiry-approval.md).

These reports describe successive stages. This root handoff supersedes older
statements that Textbee is unimplemented or that hosted sending is still failing.
Do not replace historical evidence or relabel local tests as hosted success.

## Current environment

- API: `https://muuve.onrender.com`, Render. Owner reported pushing and deploying
  `f59823b` (`implemented textbee for batch payment and claims`). The API does not
  expose its build SHA, so the exact hosted SHA has not been independently attested.
- Checkout: `main`, tracking `origin/main`, base `f59823b`, with uncommitted changes
  and evidence from this continuation. No branch/commit/push was performed by this agent.
- Supabase project: `yirelxmcveyxcqofzayq`; session pooler
  `aws-0-eu-west-1.pooler.supabase.com:5432`, database `postgres`, schema `muuve`.
  Six migrations exist. Remote database TLS uses `sslmode=verify-full` and the
  existing CA. No hosted migration/reset/truncation was performed in this continuation.
- Blockchain: **Solana devnet only**, legacy SPL Token, dedicated six-decimal test mint.
- OTP: hosted **Textbee** claim sending accepted and confirmed by database references.
  WhatsApp stays disabled. No local/mock OTP may be substituted on Render.
- Payouts, bank resolution and rates remain **mocked**. No real NGN payout integration.
- Worker stays local. No payment worker is left running. The scoped worker below
  was prepared but has never processed a live payout in this session.
- Live Config still uses **172800 seconds / 48 hours**. The four-minute feature is
  local code/build/tests only; no program upgrade or Config change was authorized
  or submitted. It is unnecessary for testing ordinary cashout.

| Public identity        | Address                                        |
| ---------------------- | ---------------------------------------------- |
| Program                | `147uqUCHmuUgziXH31v352QycgSuxLgZfzN2MYE67Sxe` |
| Config                 | `9qa5jB5TrW1TBB9rk2t422cUTSoWTWJWoQYPgbZryy22` |
| Test mint              | `H9d97DiVPydaxKTWFxVYfAg3FLSsicqx9u2boCoMksQJ` |
| Treasury token account | `29vE2HKDM5MLmDytaFQXDCp4ejSBam8FrGqZhTC85XuC` |
| Test sender            | `BrMxuBfhPhXfyzpX8Hpnv1xo6W6nMyomKh8gXt4acT85` |
| Fee/rent payer         | `EXCRqXUPPtVsDLgYsqsd2Uo88NawAT5sUy35sqVk4hg8` |

Use `wallets.md` and `config/devnet-public.json` for the other roles. Never display
private key files, environment contents, codes, full phones, JWTs, cookies or claim
secrets. Owner-authorized environment loading/provisioning is documented in CLAUDE.md.

## What actually happened after deployment

1. Hosted health passed. Original fixtures and balances were read without transfers.
2. The first hosted recipient-A request returned 503. The owner then confirmed the
   Textbee environment had not been uploaded and subsequently added it.
3. A bounded recovery request returned HTTP 200. Read-only Supabase audit confirmed
   a **Textbee claim-purpose challenge for original slot 0**, amount 500000 base units.
   Its ID was `850ab7ac-ec2f-4571-a49a-b21e5cbc6bd5`. This is actual hosted sending
   evidence, not proof of code receipt/ownership. The owner could not access that
   phone and requested a different controlled number.
4. Original funded recipient assignments were **not changed**. A separate single-slot
   link for the replacement number was prepared through the hosted API with amount
   **100000 base units / 0.1 test token**. The sender authenticated through the real
   hosted wallet challenge/login flow, then logged out. Preparation and SQL terms
   were reviewed; the sender never signed the funding transaction.
5. The replacement link's real hosted Textbee SMS request returned HTTP 200, with
   a Textbee provider receipt in Supabase. Challenge:
   `de5bfdcd-84b4-4a53-af4c-b37d2c6372af`, requested around **11:57:28 UTC**.
   No code was supplied or verified. Its ten-minute window had elapsed by handoff;
   reconcile the actual database before arranging a fresh code when the owner is ready.
6. No funded recipient claim, treasury release or hosted mock payout has run. No
   additional tokens, faucet funds or minting were requested or used.

An earlier parallel health curl timed out while Render was waking; the hosted SMS
request nevertheless succeeded. Requests were not blindly repeated. The subsequent
replacement preparation also observed HTTP 200 health.

## Fixtures and immutable terms

| Fixture                           | API link UUID                          | State/evidence at last check                                                                              |
| --------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Original funded batch             | `eaccb3c3-3434-4db9-9a30-209025be3c9f` | 500000 + 1000000 base units, both funded/unclaimed; original phones fixed. Expiry `2026-11-01T01:18:31Z`. |
| Original recall fixture           | `bde1fffd-df0b-4ff5-a5dd-7a7778db3f9b` | Both slots recalled, sender refund and vault/rent recovery already verified.                              |
| Original funded expiry fixture    | `a31f8e22-a5cf-49e7-b10f-ff5f5c1f4c8a` | 100000 + 100000 base units, awaiting genuine expiry `2026-11-01T07:23:52Z`. No expiry refund yet.         |
| Replacement recipient preparation | `cc8a9d6f-d6cd-47bf-b76e-23333bf4459b` | One pending allocation of 100000; unfunded by this agent. No funded expiry yet.                           |

Replacement operation: `b4874f6b-21b4-4708-949f-ebe2ce7c5527`.
PDA: `J39DiGRG2bLRZJ5hca6sL5o8AFZjFaKbo8dwB5QyonbQ`.
Vault: `EEmgXKVuseCQ2WY9iPCazw7PHqVBJ4924krRo8PGBUCv`.
Reviewed message hash:
`3608ef30237dbdae95c4650e22081feb9417368100b2441233acd64c013d9b7c`.
Original last-valid block height: `503945441`. This preparation is stale by handoff;
**never sign it blindly**. Reconcile signature/account/operation state before using
the existing replacement mechanism. If cancellation has already released the
unfunded link, prepare a new reviewed fixture and new link-bound OTP; do not force
SQL states or reuse another link's claim session.

The independent original-batch chain audit is
`evidence/textbee/hosted-chain-105a3061-c9b7-479d-9fa4-3f38572e414d.json`.
The new unsigned review is
`evidence/backend-payment/prepare-78f610e2-9380-4648-999e-538aa0549c29.json`.
The replacement SMS receipt is
`evidence/backend-payment/replacement-otp-1e6905e4-dfb3-4990-af4e-c9a9420683b5.json`.
These artifacts contain no private credentials or full recipient phone.

There is also an older raw-contract 48-hour fixture recorded in `wallets.md`, with
deadline **31 October 2026 at 08:39:30 UTC / 09:39:30 Lagos**. It is separate from
the hosted November 1 fixtures. Its future expiry transaction would be contract
evidence, not proof of hosted API expiry orchestration. Do not shorten it.

## Private resumable files — preserve them

| Ignored local file                      | Purpose                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `.env.local`                            | Existing local operator/DB/chain configuration and Textbee settings.                                        |
| `.env.render-api`                       | Private API upload file; Textbee configured, window remains 172800. Never publish it.                       |
| `.env.render-worker`                    | Existing minimal worker export. Local DB use must use the local CA path, matching the same hosted database. |
| `keys/backend-payment-run.json`         | Original fixtures, claim keys, receipts and original recipient identities. Do not reset or reassign.        |
| `keys/hosted-test-phones.json`          | Original authorized test phone roles. Keep unchanged.                                                       |
| `keys/replacement-recipient-phone.json` | Owner's newly authorized recipient, stored privately.                                                       |
| `keys/replacement-payment-test.json`    | New unsigned preparation and client-held claim key.                                                         |
| `keys/replacement-claim-session.json`   | New hosted OTP progress; currently waiting for a code, no verified claim session.                           |
| `keys/replacement-payment-otp.json`     | Private replacement code input; no code was supplied in this session.                                       |
| `keys/replacement-payment-run.json`     | Future isolated funding/claim journal. Not initialized by this agent because funding approval is missing.   |

Do not substitute an old local Privy identity/wallet or delete `keys/privy-live-test.json`.
The standalone Textbee/account OTP files are different tests; their codes and
sessions do not authorize these claim links.

## Uncommitted implementation/tooling changes

- `apps/web/lib/server/jobs.ts`: optional `runJobs({ payoutIds })` filter restricts
  leasing to payout/mock-webhook/provider-reconcile jobs for supplied IDs. Empty
  scope processes nothing. Default callers retain their prior behavior. Existing
  leasing, heartbeat, retry and deduplication remain in use.
- `tests/db/worker.test.ts`: concurrent scope-isolation regression test; unrelated
  payout and refund jobs remain untouched.
- `scripts/run-scoped-payout-worker.ts`: local bounded worker using the existing
  `runWorker` engine and `runJobs` handlers, no global maintenance. It verifies actual
  finalized treasury movement, matching Link/slot and hosted SQL first, polls at
  one second, stops within two minutes and handles SIGTERM. It supports the original
  profile and `--replacement-recipient`. **No live invocation yet.**
- `scripts/private-progress.ts` and `tests/unit/private-progress.test.ts`: serialized
  private atomic progress writes prevent concurrent duplicate HTTP requests from
  racing one temp filename; a journal failure poisons subsequent writes.
- `scripts/run-hosted-payments.ts`: code input cleanup, bounded provider recovery,
  shared budget lock and isolated `--replacement-recipient` profile. Original
  phone assignments/1.9-token allowance remain separate. The new profile uses
  the reviewed unsigned link and requires an independently verified phone session
  plus a separate approval record before funding. Combined fee reservations cannot
  exceed the original 50000000-lamport ceiling. Latest changes are typechecked;
  the replacement funding/claim paths have **not been executed**.
- `scripts/verify-hosted-payments.ts`: replacement-recipient mode prepares one 100000
  allocation in its own private file; uses the existing HTTPS test transport.
  Default batch preparation remains separate. It cannot sign/submit funding.
- `scripts/verify-replacement-claim-phone.ts`: real hosted claim OTP send/verify/audit
  for the replacement link, actual JWT/SQL binding and private `/share` checks.
  Only send mode has run; no code/session was fabricated.
- `scripts/audit-hosted-payment-otp.ts`: read-only original-recipient audit. A null
  receipt now reports unknown provider rather than incorrectly inferring Twilio.
- Updated handoffs, this root file, frontend guide and new evidence.

Inspect the actual Git diff before resuming; do not assume these operator additions
are fully integration-tested merely because they typecheck. No new database migration
or runtime secret is required for these additions. The optional job scope is used
locally, so no hosted worker deployment is required.

## Checks actually observed

Exact command arrays, exit codes and timing are in `evidence/render-devnet/`.

| Evidence prefix                                | Observed result                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `textbee-hosted-recipient-a-provider-recovery` | Exit 0, hosted send accepted; no transfer.                                                            |
| `textbee-hosted-recipient-a-recovery-audit`    | Exit 0, real Textbee claim reference and exact original slot.                                         |
| `scoped-payout-worker-database`                | Exit 0, **19 tests passed**, disposable PostgreSQL worker/payout suites.                              |
| `payment-progress-and-worker-unit`             | Exit 0, **18 tests passed**, progress journal/worker/message-review unit suites.                      |
| `scoped-payout-worker-typecheck`               | Initial failure: optional token-balance values not narrowed; retained artifact.                       |
| `scoped-payout-worker-typecheck-fixed`         | Exit 0 after explicit presence assertion.                                                             |
| `scoped-payout-worker-production-build`        | Exit 0, production build including scoped job change.                                                 |
| `replacement-recipient-unsigned-prepare`       | Exit 0, actual hosted sender login, preparation, SQL review and logout; no sender funding signature.  |
| `replacement-recipient-hosted-sms`             | Exit 0, actual hosted Textbee claim send to new recipient.                                            |
| `replacement-recipient-tooling`                | Exit 0, `pnpm check` before the final funding-profile extension.                                      |
| `replacement-funding-controller-typecheck`     | Exit 0, latest controller/profile typecheck. This was already running when the owner stopped testing. |

Historical baseline: 79 unit, 64 DB/API, 18 native Rust passes (1 native bootstrap
ignored), 14 SBF runtime passes, production build and HTTP smoke passed before
these latest changes. Do not describe those counts as a new complete-suite run
for the current working tree. The new tests above are focused local tests, not
hosted cashout or browser evidence. The full lifecycle remains incomplete.

## Approvals and next agent's sequence

The original approval in `evidence/backend-payment/approval.json` allows **1900000
base units** total new escrow funding and **50000000 lamports** fees/rent. Its gross
funding allowance is fully used. Existing original claims remain in that scope,
but their assigned phones cannot be replaced.

The new number requires the separate 100000-base-unit cashout fixture. **No extra
funding approval was requested/received before the owner stopped testing.** No
`evidence/backend-payment/replacement-approval.json` was created. The controller
requires that independently approved record with `cluster=devnet`, `payouts=mock`,
`max_new_funding_base_units="100000"`, `max_fee_and_rent_lamports=10000000` before
execution. Never create it as though approval already exists.

The proposed 0.01 SOL fixture ceiling fits inside the original overall 0.05 SOL
limit; the controller also checks combined reservations. This adds 0.1 test token
to gross funding (1.9 → 2.0), not a new mint/airdrop or real payment. The last sender
read showed 300000 base units; recheck before signing. This cashout fixture is
distinct from the separately proposed four-minute expiry fixture.

When the owner asks the next agent to resume:

1. Reinspect instructions, Git and configuration; establish that no worker is active.
   Read-only reconcile pending challenges/preparation/chain accounts without resetting
   progress or changing original fixtures.
2. Review the fresh controller/worker code and focused checks. Obtain explicit
   approval for the additional **0.1 test token**, its exact destination/terms and
   fee bound before any token-moving signature/submission. Review a current exact
   transaction; do not sign the stale preparation above.
3. Arrange a fresh real Textbee code for the accessible replacement number when
   the owner can verify promptly. Preserve real phone/link membership and server
   session checks. Existing script sends are intentionally single-use; add any
   bounded recovery only after reconciling the expired challenge, with history
   retained and rate limits intact. Never reset a counter to bypass a guard.
4. Verify the actual code and signed claim-cookie/SQL identity. If the old pending
   link was cancelled, use a new reviewed link and code; don't force reopening.
5. Only after approval and valid recipient proof, execute the replacement profile's
   funding and claim stages, inspecting exact messages and finalized chain/SQL
   receipts after each. The relevant controller flags are
   `--replacement-recipient --fund-main` and `--replacement-recipient --claim=a`,
   with the existing explicit operator flags and approval file. Never run them
   simply to discover what they do.
6. Run the scoped local mock worker for the exact finalized payout, using
   `--replacement-recipient --role=a` and its approval guards. Confirm real queue
   leasing, mock transfer/webhook deduplication and terminal principal/slot status.
   Reconcile ambiguity before any retry. Stop the worker cleanly.
7. A successful single-recipient cashout still does not prove independent batch
   claims. Resume original recipients only when their actual assigned phones are
   accessible, or prepare a separately reviewed new batch with distinct eligible
   recipients and any additional approved funding.
8. Treat four-minute deployment/Config change and extra expiry funding as separate
   unapproved work. Original natural-expiry fixtures retain their November 1 dates.

Leave all real NGN integrations mocked. Do not call Muuve production-ready or claim
hosted settlement until the actual transactions, provider state and database agree.
