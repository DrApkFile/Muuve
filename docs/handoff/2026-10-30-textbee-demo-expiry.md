# Textbee and four-minute demo — implementation and verification

30 October 2026. Work remains on `main`, based on
`cee381f3ec11f7e556f06518bae1ccc9b26c0b43`. Existing changes were preserved. No
branch, commit, push, hosted deployment, contract upgrade, Config change, migration
against Supabase, token transfer or payout was performed in this continuation.

## Implemented locally

- `apps/web/lib/server/providers/textbee.ts`: explicit-device SMS through the official
  Textbee endpoint, cryptographic six-digit codes, salted HMAC verifiers bound to
  the phone/challenge UUID, redacted errors and no automatic resend after timeout.
  The existing session secret keys the verifier; no new signing key is needed.
- Provider selection now includes Textbee. Verification routes by the stored
  reference so pending Twilio challenges survive a switch. OTP expiry, rate limits,
  attempt limits and atomic single consumption remain database-backed. WhatsApp
  stays unavailable for Textbee.
- Anchor `set_claim_window`: only the stored admin can select 240 or 172800 seconds
  for future links. Config/Link layouts and previous instruction arguments remain
  unchanged; new errors are appended. Existing deadlines and allocations remain
  immutable snapshots. Initialization retains 48 hours.
- Backend Config validates the selected window against on-chain Config. The short
  window is allowed only in local/preview devnet configuration. Production rejects
  it. Readiness/expiry tools recognize both old and demo link snapshots.
- Environment examples, Render secret separation, generated IDL and setup/review
  tools were updated. The worker stays local; it needs no Textbee credentials.

Additional tests cover keyed verifier context substitution, malformed receipts,
provider failure/timeout, legacy routing, batch-phone isolation, replay, concurrent
verification, rate/attempt/expiry limits, demo admin authorization and exact on-chain
expiry boundaries under both supported token programs. The test fixture helper now
creates batches with fixed allocations at insertion rather than editing terms.

## Real external checks

Textbee credentials were saved in ignored, mode-0600 `.env.local` and
`.env.render-api`; neither value is published. The exported API environment selects
Textbee. **This does not change Render's actual environment.** The owner still
handles uploading reviewed configuration and pushing/deploying source.

The real provider returned HTTP 200 for the configured enabled device. A real SMS
request was accepted for the authorized private test number. The first probe's
ten-minute window elapsed before verification, so the submitted code was rejected
by the expiry guard and cleared. A single bounded fresh probe was then accepted.
Verification of that fresh probe is recorded separately when completed; provider
acceptance alone is not delivery or authentication evidence.

The SMS probe executes locally against real Textbee and never creates an API session,
writes hosted auth records or submits transactions. It must not be reported as
hosted Render OTP verification. See `evidence/textbee/` and the
`textbee-real-sms-*` command records.

Read-only devnet review confirmed current Config is still 172800 seconds. Unsigned
simulation of the new instruction returned custom error 101 against the deployed
binary. It needs the new reviewed program; changing the environment alone would
fail readiness. No authority key was loaded for these read-only reviews.

The compiled artifact is 591808 bytes, SHA-256
`2aeacaeeee96893acb856944acec0c2d1c4d501614c25c53a12ed7df8877f456`.
Program capacity needs 4912 additional bytes. The authority was verified as
`8QdwEAfREtpycxbCLEm8YhAC8CE5D941sqEmrXLx5HnD`, with sufficient balance at
review. The concrete action/rent/funding review is
[demo-expiry-approval.md](../demo-expiry-approval.md). Recheck before execution.

## Verification evidence

Exact command arrays, exit codes, timings and logs are retained under
`evidence/render-devnet/`; no failure artifacts were overwritten.

| Record prefix                       | Command                                                                                                                                                | Result                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `textbee-expiry-first-unit`         | `pnpm exec vitest run tests/unit/textbee.test.ts tests/unit/security.test.ts`                                                                          | Exit 0                                                                                                      |
| `textbee-api-payout-database`       | `node scripts/test-db.mjs tests/api/textbee.test.ts tests/api/auth.test.ts tests/db/payouts.test.ts tests/db/finality.test.ts tests/db/worker.test.ts` | Initial failure: fixture attempted immutable terms update; guard correctly rejected it                      |
| `textbee-api-payout-database-fixed` | Same focused database command                                                                                                                          | Exit 0; 35 passed                                                                                           |
| `demo-expiry-native`                | `cargo test --locked --manifest-path programs/muuve_escrow/Cargo.toml --jobs 2 -- --test-threads=1`                                                    | Exit 0; 4 unit + 1 loader-layout + 13 runtime passed; 1 bootstrap test intentionally ignored in native mode |
| `demo-expiry-sbf-build`             | `node scripts/build-sbf.mjs` with explicit local public program configuration and pinned SBF tools                                                     | Exit 0; current non-fixture artifact built                                                                  |
| `demo-expiry-sbf-tests`             | `node scripts/test-sbf.mjs`                                                                                                                            | Exit 0; all 14 runtime tests passed against the compiled artifact, including bootstrap                      |
| `demo-expiry-idl`                   | `node scripts/build-idl.mjs` with the public deployment ID                                                                                             | Exit 0; 12 instructions, 3 accounts; IDL uses the intended devnet ID                                        |
| `textbee-expiry-full-unit`          | `pnpm exec vitest run tests/unit`                                                                                                                      | 76 passed, 3 process/test timeouts during simultaneous builds; retained failure                             |
| `textbee-expiry-full-unit-serial`   | `pnpm exec vitest run tests/unit --maxWorkers=1 --no-file-parallelism`                                                                                 | Exit 0; 79 passed; timeout limits/assertions unchanged                                                      |
| `textbee-expiry-full-database`      | `node scripts/test-db.mjs`                                                                                                                             | One query timeout under local I/O pressure; stopped this run, disposable database shut down                 |
| `textbee-expiry-build`              | `pnpm build`                                                                                                                                           | Exit 0; production API build                                                                                |
| `textbee-expiry-http`               | `pnpm test:http`                                                                                                                                       | Exit 0; local production HTTP/JWKS smoke                                                                    |
| `textbee-render-blueprint`          | `pnpm check:render`                                                                                                                                    | Exit 0; schema, commands, references and worker secret separation                                           |
| `textbee-expiry-secret-audit`       | `node scripts/audit-local-secrets.mjs`                                                                                                                 | Exit 0; private permissions, Git exclusions, source/evidence and build artifacts                            |
| `textbee-live-readiness`            | `node --import tsx scripts/verify-textbee.ts`                                                                                                          | Initial blocked exit 1: credentials absent                                                                  |
| `textbee-live-readiness-configured` | Same read-only command with local configuration loaded                                                                                                 | Exit 0; actual enabled device authenticated; no SMS in this check                                           |
| `demo-window-hosted-preflight`      | `node --import tsx scripts/set-claim-window.ts --seconds=240 --review`                                                                                 | Blocked exit 1, simulation 101: deployed binary lacks new instruction; no signature/submission              |
| `demo-expiry-upgrade-review`        | `node --import tsx scripts/review-demo-upgrade.ts`                                                                                                     | Exit 0; actual authority, capacity, rent and balance read-only review                                       |

Rust commands used the existing `.cache/cargo`; SBF build used
`.cache/platform-tools-v1.58`. No dependencies were installed. Database suites
migrated/reset only disposable loopback PostgreSQL. The initial full database run
was stopped to reduce I/O pressure; its failure is not reported as a pass. The
sequential rerun passed all 64 tests and the final type/format check passed, without
changing assertions or timeouts. All six migrations were verified in the disposable
test database; this is not a new hosted migration application.

Final records: `textbee-expiry-full-database-serial` ran
`node scripts/test-db.mjs`, exit 0, **64 passed**;
`textbee-expiry-final-check` ran `pnpm check`, exit 0.

The mock payout suite tests actual durable provider/job/webhook records in disposable
PostgreSQL, including success, failure, stable-key immediate retries, duplicate
webhooks and quarantine. Fault-injected chain checks are simulated; these results
are not actual hosted treasury transfers or NGN payments.

## Hosted continuation and gates

1. The owner reviews and pushes the API changes, uploads `.env.render-api` to the
   existing API service and confirms its live deployment. Keep the window at 172800
   for now; Textbee does not depend on a contract upgrade. Never upload `.env.local`
   or operator files. Keep the worker local.
2. Recheck real hosted Textbee claim-purpose OTP with the original two recipients of
   the funded batch. The account-login test number cannot replace their eligibility.
   Resume scoped `scripts/run-hosted-payments.ts` stages and the approved budget;
   verify finalized treasury receipt and mock payout success/failure/retry. No new
   escrow funding is needed for those existing cashouts.
3. Obtain explicit approval for the reviewed program extension/upgrade and admin
   Config change before authority actions. Coordinate API/worker window settings
   only after the approved on-chain change; verify existing link snapshots.
4. A new 0.1-token short-expiry fixture needs the separately reviewed funding addition.
   Observe its original 240-second deadline and verify refund/vault/rent/SQL effects.
   Existing 48-hour fixtures remain on their original dates and need natural expiry.

Browser integration and legitimate recipient embedded-wallet enrollment remain
outside this backend-only run. They are prerequisites for testing recipient wallet
claims, but not the phone-verified treasury cashout path. Muuve is not being declared
production-ready. See [setup](../textbee-and-demo-expiry.md),
[the original backend payment evidence](2026-10-30-backend-payment-verification.md)
and [the earlier one-number account test](2026-10-30-single-phone-verification.md).
