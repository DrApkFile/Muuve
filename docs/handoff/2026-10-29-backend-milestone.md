# Backend milestone handoff — 29 October 2026

Historical checkpoint. See the later [Render/devnet handoff](2026-10-29-render-devnet.md)
for the completed deployment, updated test results and current external prerequisites.

## Done

Implemented the backend-only workspace, Anchor escrow, both token programs with an
explicit extension allowlist, sender-scoped links, bounded claim intents, immutable
allocations/expiry, surplus/rent recovery and on-chain operation receipts.

Implemented four Postgres migrations, RLS, immutable terms, durable operations and
attempts, transactional capacity reservations, state/event guards, OTP/session and
Privy boundaries, API handlers, payout/rate/bank/Cleva mocks, treasury resolutions,
webhook inbox/outbox, reconciliation, expiry/refund jobs and redacted monitoring.

Added operator-gated setup/devnet scripts, verified compiler installation, SBF/IDL
builds, CI workflows and a production HTTP smoke check. No frontend pages were added.

Observed successful local verification:

- 19 unit tests and 32 real-Postgres database/API tests.
- Four Rust unit tests, 12 native runtime tests; bootstrap is intentionally excluded
  from the native processor and covered by the SBF run.
- All 13 compiled-SBF runtime tests, including real upgradeable-loader bootstrap,
  both token programs, competing claim/recall, overflow and original rent beneficiary.
- TypeScript, Prettier, Rust formatting, production build, HTTP guards and IDL generation.

Evidence: [verification record](../../evidence/backend-milestone/verification.json).
Raw successful run logs accompany that record. SBF artifact/source hashes are recorded;
the public fixture program ID is not a deployment address.

## In progress

No independent implementation task is left running. External verification requires
operator configuration and actions listed below. The remote CI workflow has not run.

## Decisions made

The [owner-approved decisions](../backend-decisions.md) govern the implementation.
Priority starts with an on-chain intent, lasts at most 120 seconds, cannot renew and
never extends the 48-hour deadline. Existing links snapshot attestor/treasury terms.
Token-2022 permits extension-free mints and ImmutableOwner token accounts only.

Anchor is pinned to 0.31.1 for native CPI compatibility. SBF checks use the verified
platform-tools v1.58 compiler. Boxing account wrappers fixed measured SBF frame
overflows; the build now rejects these diagnostics even on compiler exit code zero.
Payouts require finalized execution. Immediate replacements retain the same guarded
principal identity; immediate provider retries retain the same provider key.

## Known issues / next step

Devnet readiness was blocked before any RPC request: RPC, assigned program ID, test
mint, treasury account and five public role identities were not supplied. No wallets,
devnet funds, deployment, Config initialization or live transactions were created.

The operator must provision separate keys, deploy/review the program, create the
dedicated test mint/treasury and initialize Config. Then run `pnpm test:devnet` and,
with explicit transaction consent and funded fixtures, `pnpm test:devnet:transactions`.
Expiry verification needs a genuinely aged link. Because the mint is immutable,
devnet verification of both token programs needs separate configured deployments.

Twilio delivery and live Privy wallet linking need owner-controlled service setup
and credentials. Fiat rates, bank resolution, payouts and Cleva remain explicit mocks.
Production PII encryption and real payout integrations are not claimed by this devnet
milestone. Repository-required human security review remains a release prerequisite.

See the [operator and recovery runbook](../backend-runbook.md). Do not deploy to mainnet
or retry ambiguous external transfers with a new unguarded payment identity.
