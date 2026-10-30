# Backend-only hosted devnet verification — 30 October 2026

Subsequent implementation: [Textbee and demo-expiry handoff](2026-10-30-textbee-demo-expiry.md)
records the new adapter, verified local suites and remaining deployment/authority
gates. This report's funded fixtures and original deadlines remain authoritative;
the new four-minute option does not rewrite them.

## Done

**Actual hosted batch funding, funding replay protection, sender recall-one/recall-all,
refund token balances and vault rent recovery passed on devnet.** Recipient claims
and mock payouts remain blocked by Twilio phone verification. A new expiry fixture
is funded with its real 48-hour deadline; no expiry refund has run yet.

Latest provider decision: after the Nigerian country restriction persisted, the owner
requested replacement-provider research. The runtime still uses Twilio; no provider
has been switched. See the [OTP research](../otp-provider-research.md) for the Termii
recommendation, account prerequisites and remaining delivery verification.

The owner explicitly changed the continuation to backend-only testing after the
browser client could not be located. Privy enrollment and browser verification remain
outside this run. The deployed OTP configuration still selects Twilio; Textbee was researched
at the owner's request but was not implemented or configured.

- Source checkout: main, base commit `cee381f3ec11f7e556f06518bae1ccc9b26c0b43`.
  Existing documentation changes were preserved. No branch, commit, push or hosted
  deployment was performed by this agent.
- Actual hosted API: `https://muuve.onrender.com`.
- Actual hosted database: Supabase project `yirelxmcveyxcqofzayq`, verified TLS,
  migration names/checksums 001–006 matched. No hosted migration/reset occurred.
- Actual devnet program: `147uqUCHmuUgziXH31v352QycgSuxLgZfzN2MYE67Sxe`.
- Mint: `H9d97DiVPydaxKTWFxVYfAg3FLSsicqx9u2boCoMksQJ`, six-decimal legacy SPL.
- Treasury: `29vE2HKDM5MLmDytaFQXDCp4ejSBam8FrGqZhTC85XuC`.
- No new program deployment, minting, faucet request or real fiat provider integration.

The earlier [hosted wallet report](2026-10-30-hosted-wallet-verification.md) remains
the historical authentication baseline. This continuation does not independently
attest Render's current source SHA. The reconciliation fix below is local and still
requires the owner's commit/push/deploy before its hosted behavior can be retested.

## Explicit approval and budgets

Owner approved [the reviewed test budget](../backend-payment-approval.md): up to
1900000 base units in new test escrow funding and 50000000 lamports for fees/rent.
The approval is recorded separately in `evidence/backend-payment/approval.json`.

The prior auth preparation and the new unsigned review preparation were never
submitted. After actual blockhash expiry, the new review preparation was scoped,
reconciled to failed/cancelled and its capacity released. The approved run used fresh
sender-local IDs, operations, claim keys and transaction lifetimes.

Actual new funding: **1900000 base units (1.9 test tokens)**. Conservative fee/rent
reservations: **36750000 lamports**, including the future expiry reservation.
Verified gross fee/rent debits across the five receipts: **22422320 lamports**.
No further new escrow funding remains authorized under this budget.

Final audited sender token balance: **300000 base units**.
Fee-payer balance at audit: **5950707200 lamports**. Fee/rent accounting
uses each transaction receipt rather than attributing unrelated wallet credits to
this test. No funding was requested by the agent.

## Actual transactions and fixture states

All five transactions below have successful finalized receipts and matching hosted
operation states. Signing/submission used the actual hosted prepare/submit endpoints.
Scoped local reconciliation used the same hosted database and real devnet RPC; it is
not described as hosted worker execution. Signed transaction bytes remain private.

| Action                     | Actual devnet receipt                                                                                                                                   | Sender token delta, base units |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Main batch funding         | [4aKsZwmbJKJM…](https://explorer.solana.com/tx/4aKsZwmbJKJMCoPavMjU7ZxDxGAUDL5JJPqJfB5wB1CFRR8yio8Ek3mn2yDTDRpnooLgL4HqyRprTHX3oRY2WUQC?cluster=devnet) | -1500000                       |
| Recall fixture funding     | [3eV3dfMtYeiv…](https://explorer.solana.com/tx/3eV3dfMtYeivuCVzGLcBcmGxCYmLvz4JCPEGhjaEiQ7mscpChA7G9rh7VVh9XkMYPCEeV2ob2ZuPzmFGPbq8X9Ky?cluster=devnet) | -200000                        |
| Recall slot 0              | [5e1KwhYziq6t…](https://explorer.solana.com/tx/5e1KwhYziq6tuuFLDDBcx9zhNyFmBqc6EPkG5CmcVAGKR3Eww8wmTKzr5Me577iR3EtxUuzCzLtANNcbu5MXr6ZC?cluster=devnet) | 100000                         |
| Recall all remaining slots | [2YhbpAWUfo1E…](https://explorer.solana.com/tx/2YhbpAWUfo1EFad7szi7nvPFYx13T1fU7Y3wh6Q3P2UQMvpH9uFf4S1BL1Ca613Cd1spHpT7cZAqRW6btL9M9mAK?cluster=devnet) | 100000                         |
| Expiry fixture funding     | [5SvRwYBmsdaJ…](https://explorer.solana.com/tx/5SvRwYBmsdaJKE8VwBRCY5JhSaZdFuihSYifXpZgYdrY3DUFtwwKrSZqxSbrFVGMxzZtue4VD9NFvYSUKDnXqEWc?cluster=devnet) | -200000                        |

The recalled token deltas are +100000 and +100000 to the original sender. Final
recall closed the vault and returned **1488440 lamports** to the recorded original
fee/rent payer `EXCRqXUPPtVsDLgYsqsd2Uo88NawAT5sUy35sqVk4hg8`.
The Link receipt remains allocated as designed. Surplus donations were not exercised
in this run; no guarantee is inferred for an untested scenario.

| Fixture | API link UUID                          | Hosted status | Vault balance, base units | Real on-chain deadline, UTC |
| ------- | -------------------------------------- | ------------- | ------------------------- | --------------------------- |
| main    | `eaccb3c3-3434-4db9-9a30-209025be3c9f` | open          | 1500000                   | 2026-11-01T01:18:31.000Z    |
| recall  | `bde1fffd-df0b-4ff5-a5dd-7a7778db3f9b` | settled       | 0                         | 2026-11-01T07:21:05.000Z    |
| expiry  | `a31f8e22-a5cf-49e7-b10f-ff5f5c1f4c8a` | open          | 200000                    | 2026-11-01T07:23:52.000Z    |

Main allocations remain 500000 and 1000000, both funded and unclaimed. The separate
expiry allocations remain 100000 each. Total still held in the new test escrows is
1700000 base units; it has not been paid out or silently returned.

The expiry fixture matures **1 November 2026 at 08:23:52 Lagos**. Main batch expiry
is **1 November 2026 at 02:18:31 Lagos**. Do not shorten either deadline. The older
raw contract fixture maturing 31 October remains separate and was not modified.

## Hosted authorization and privacy tests

- Replaying the actual funded creation submission returned its same finalized
  operation. Sender token movement and vault principal remained single.
- Public batch preview disclosed no slots, slot count or batch allocation total.
- Sender wallet-only cookies were rejected by claim share and intent routes (401).
- A second real wallet-authenticated user could neither read nor prepare recall of
  the funded sender link (404). That session was logged out afterward.
- Out-of-range slot index was rejected (400) before a recall operation was created.
- Client-supplied refund destination was rejected by strict schema validation (400).
  Valid recalls used the original sender ATA; no redirect was attempted on-chain.

No claim session was fabricated and no local mock OTP was enabled on Render. Wrong
claim-key/destination and duplicate claim submission against funded slots cannot be
claimed passed in this hosted run before actual recipient phone verification.

## Local worker against hosted Supabase

One actual local worker processed two dedicated obsolete-payout no-op fixture jobs
against the intended hosted database. It processed the normal job once, recovered
an expired running lease, rejected the stale owner's update and drained SIGTERM
with exit 0. Worker/API exports target the same project; the local public-CA path
was used. No hosted worker was deployed, and no authenticated global cron endpoint
was invoked.

This proves queue pickup and lease recovery, not a completed funded payout. Concurrent
ownership, provider retry/timeout and payout reconciliation are covered by the local
disposable-database tests below. Concurrent hosted payout workers were not run.

## Defects discovered and fixes

### Missing link funding signature after earlier state reconciliation

The main create operation had the real finalized signature while `links.create_sig`
was null. `syncLink` only wrote that field while transitioning pending → open; a
prior state reconciliation could open the link before its receipt was applied.

Added two regression cases: a receipt applied after the link opens, and repair when
the create operation is already finalized. Both failed before the fix and pass after.
`syncLink` now preserves or fills the exact create signature independently of that
transition, and rejects a conflicting existing value. `reconcileLink` can recover
it from the finalized create attempt after validating actual link state.

After regression tests passed, local scoped reconciliation verified the real receipts
and repaired only the dedicated test fixtures in hosted Supabase. It did not submit
another transaction. The deployed API still needs the owner's source push/deploy;
this local repair is not evidence that the hosted source fix has been deployed.

### Test tooling and transport

- The older worker verifier hardcoded five migrations. It now validates the complete
  migration filename set and checksums, and supports a separate evidence filename.
- The disposable database runner can target named DB/API test files; its default
  suite and loopback/reset guards are preserved.
- Added strict transaction review for program/mint/PDA/ATA, instruction bytes, amount
  allocations, account flags, compute budget and expected signatures before signing.
- Added a single-process progress lock. The initial parallel SMS/recall invocation
  was an orchestration mistake; future stages are sequential. Its generic failures
  did not prove a file collision. SQL inspection confirmed no SMS challenge or recall
  link was created then, and verified progress was preserved. The lock guard was
  independently tested to preserve an active lock and leave progress unchanged.
- Local Node HTTPS calls timed out while verified-TLS IPv4 curl requests succeeded.
  The operator test transport now uses curl with no redirects, automatic retries or
  insecure TLS. Headers/bodies use temporary mode-0600 files under ignored keys and
  never enter process arguments or logs. This is HTTP-client evidence, not browser proof.
- The final read-only audit hit RPC 429; the failure is retained. A paced read-only
  audit subsequently verified all five receipts and fixture balances without any
  transaction resubmission.

## Test commands and actual results

Latest affected results, with repeated runs kept separate rather than added together:

| Command / check                                                                                                                                                 | Exit       | Actual result                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `pnpm exec vitest run tests/unit/hosted-payment-review.test.ts tests/unit/worker.test.ts`                                                                       | 0          | 16 passed.                                                                                |
| `node scripts/test-db.mjs tests/db/finality.test.ts` before fix                                                                                                 | 1          | 2 failed, 2 passed; reproduced the receipt bug.                                           |
| Same focused finality command after fix                                                                                                                         | 0          | 4 passed.                                                                                 |
| `node scripts/test-db.mjs tests/db/finality.test.ts tests/db/operations.test.ts tests/db/payouts.test.ts tests/db/reservations.test.ts tests/db/worker.test.ts` | 0          | 27 passed on disposable loopback PostgreSQL, not hosted SQL.                              |
| Local worker verifier with `--local-worker-only --allow-test-records` and separate evidence path                                                                | 0          | Real hosted SQL, two no-op jobs, recovered lease, exit 0 on SIGTERM.                      |
| `pnpm build`                                                                                                                                                    | 0          | Production API build with the reconciliation fix.                                         |
| `pnpm test:http`                                                                                                                                                | 0          | Local production HTTP smoke; no external service contacted.                               |
| `pnpm check`                                                                                                                                                    | 0          | TypeScript and formatting passed after fixes.                                             |
| `node scripts/audit-local-secrets.mjs`                                                                                                                          | 0          | Source/evidence/build secret scan passed.                                                 |
| Missing-approval and overlapping-stage guards                                                                                                                   | Expected 1 | Correctly rejected before external calls; separate guard evidence records expected exits. |

The initial focused DB run before the new regression contained 25 passing tests;
it is not an additional 25 unique cases. Authoring type errors were fixed before
financial execution. Earlier Rust/SBF and unrelated auth results were not rerun or
relabelled as fresh evidence for unchanged code.

Exact recorded command arrays, timestamps, exit codes and logs are under
`evidence/render-devnet/backend-payment-*`; the command ledger is
`evidence/backend-payment/commands.json`. Individual stage and failure artifacts
are retained under `evidence/backend-payment/` with unique filenames.

## Twilio blocker and remaining work

Subsequent isolated check: the owner's already verified destination successfully
received and verified an account OTP against the hosted API. `/api/me`, logout and
SQL session revocation passed. See the
[one-number verification report](2026-10-30-single-phone-verification.md).
This does not change the assigned recipients on the funded fixtures, establish
their delivery eligibility or prove a cashout. Textbee setup remains paused.

Actual hosted recipient-A SMS send returned **503 `otp_provider_unavailable`**.
The failed challenge remains an audit record. Read-only Twilio API queries confirmed
an active Trial account, a valid six-digit Verify service, one verified caller ID,
and neither assigned test recipient in that verified list. The owner additionally
reported that adding a Nigerian number displays a country restriction. The precise
upstream rejection code is not exposed by the redacted API response.

Twilio documents trial recipient/geographic limits and Nigeria as a supported trial
country. An account restriction or Geo permission can still prevent delivery. See
[trial restrictions](https://www.twilio.com/docs/usage/trials) and
[Verify Geo permissions](https://www.twilio.com/docs/verify/preventing-toll-fraud/verify-geo-permissions).
Twilio's read-only Alerts API returned no entries, so no precise numeric rejection
code was recovered. The owner reports that enabling country traffic still did not
allow number registration and has requested a replacement. No account upgrade, paid setting change,
country restriction bypass, alternate-provider integration or second SMS was attempted.

After that external prerequisite is resolved, the staged runner supports a bounded,
reconciled resend for A, a fresh send for B, and actual code verification. Received
codes belong only in ignored `keys/backend-payment-otp.json`, never chat. Claim
sessions and exact assigned slots must be proved before treasury claims. Provider
success/failure/retry, webhook deduplication, live claim concurrency, treasury balance
movement and actual mock payouts remain **not executed against the hosted flow**.
Local tests cover those simulated/fault-injected cases only.

Expiry/refund requires the actual deadline. The expiry fixture is funded, not expired
or refunded. Natural-expiry and post-expiry recall rejection remain unverified on
these new hosted fixtures. Recipient embedded-wallet claims and browser/Privy client
enrollment remain outside this backend-only continuation.

Original **3 users, 11 sessions and 8 OTP records** still match their pre-migration
keyed fingerprints. New test/audit records were retained. The final audit found zero
active operations, jobs, payouts or principals, but two deliberately open funded links.
It must not be described as full settlement or complete payment E2E. Muuve is not
being declared production-ready.

## Files created or changed

Backend fix: `apps/web/lib/server/reconcile.ts` and
`tests/db/finality.test.ts`.

Verification tooling: `scripts/verify-hosted-services.ts`, `scripts/test-db.mjs`,
`scripts/hosted-payment-review.ts`, `scripts/verify-hosted-payments.ts`,
`scripts/run-hosted-payments.ts`, `scripts/hosted-test-http.ts` and
`tests/unit/hosted-payment-review.test.ts`.

Documentation: this report, the approval review and continuation pointers. Evidence:
`evidence/backend-payment/` and new `evidence/render-devnet/backend-payment-*`
files. Resumable private progress and claim keys remain ignored under `keys/`;
do not delete or recreate them to work around a failed stage.

## Pause and deployment handoff

The sender session was logged out before waiting for replacement-provider setup. The
first logout transport timed out; a read-only session check showed it still active,
and a subsequent idempotent logout returned 200. The failed attempt is retained.
Resumable fixture metadata, claim keys and receipts were preserved; no worker is
left running. Do not delete that progress or create another funded fixture.

The reconciliation fix is ready for the owner to review, commit and push on main:
affected database tests, production build, HTTP smoke, type/format checks and secret
scans passed. No migration, new runtime secret, contract deployment or hosted worker
change is needed for this fix. Its hosted post-deployment retest remains pending.
