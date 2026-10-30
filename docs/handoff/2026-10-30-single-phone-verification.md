# Hosted one-number Twilio verification — 30 October 2026

The owner's already verified destination successfully completed actual hosted SMS
verification against `https://muuve.onrender.com`. Textbee was not implemented or
enabled. This run exercised account phone authentication, not a funded payment or
link-bound recipient claim.

## Verified results

- Read-only Twilio records confirmed this exact private test destination was on the
  account's verified caller-ID list before sending. No phone number is published.
- The first hosted POST timed out. A subsequent read-only Supabase query found no
  account challenge from that attempt. After checking again for an accepted request
  and verifying health, one controlled retry was allowed. The retry returned HTTP
  200 with a real challenge. No blind resend was performed.
- The owner received an SMS and supplied its code. Actual hosted verification
  returned HTTP 200. The code was removed from the ignored input file immediately
  before submission; no code or authentication token is in the evidence.
- The returned account session's signature, issuer and audience verified locally
  using the configured session secret. Its SQL session record matched the exact
  verified phone, account purpose and validity. The challenge was consumed with
  status `verified` and a non-null verification timestamp.
- Authenticated `GET /api/me` returned HTTP 200 and the expected user UUID.
- Logout returned HTTP 200. A separate audit confirmed the unique session created
  during this test was revoked in hosted Supabase, local test cookies were cleared,
  and unauthenticated `GET /api/me` returned HTTP 401. The private code file was
  empty after verification.

Supabase target: development project `yirelxmcveyxcqofzayq`, using its session
pooler with certificate-verified TLS. API/local database targets and credentials
matched without exposing credentials. Configured guards required preview mode,
Solana devnet, Twilio OTP and mocked payouts. No migration, deployment, configuration
change, transaction, token movement or payout was performed by this run.

## Commands and evidence

All commands ran from the repository root on `main`, based on
`cee381f3ec11f7e556f06518bae1ccc9b26c0b43`, with existing local changes preserved.
The health endpoint does not attest the deployed commit SHA.

| Command                                                                                   | Exit | Result                                                        |
| ----------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------- |
| `node --import tsx scripts/verify-single-phone.ts --send --operator-approved-sms`         | 1    | Initial HTTP transport timeout; retained failure evidence     |
| `node --import tsx scripts/verify-single-phone.ts --reconcile --operator-approved-sms`    | 0    | No challenge found; did not send another SMS                  |
| `node --import tsx scripts/verify-single-phone.ts --retry-unsent --operator-approved-sms` | 0    | One reconciled retry accepted, HTTP 200                       |
| `node --import tsx scripts/verify-single-phone.ts --verify --operator-approved-sms`       | 0    | Actual SMS code, account session, `/api/me` and logout passed |
| `node --import tsx scripts/verify-single-phone.ts --audit --operator-approved-sms`        | 0    | SQL revocation, logged-out 401 and code cleanup passed        |

Command timing and exit-code records are in
`evidence/render-devnet/single-phone-*.json`; redacted request and database results
are in `evidence/single-phone/`. The verification tool is
`scripts/verify-single-phone.ts`; it locks its private progress, persists send
intent before HTTP submission and requires reconciliation after an uncertain send.
Private progress and code inputs remain ignored under `keys/` with mode 0600.

Final `pnpm check` passed with exit 0 (TypeScript and repository formatting).
`node scripts/audit-local-secrets.mjs` passed with exit 0, checking private-file
permissions, Git exclusions, reviewable source/evidence and existing build artifacts.
`git diff --check` passed. These are tooling checks; no new unit-test count or
production build is claimed for this verification-only script.

## What this does not prove

This successful verified destination does not establish that Twilio will deliver
to either of the two different recipients on the existing funded batch. Their
previous failure and account/country restrictions remain separate evidence. One
verified phone is sufficient for a single-recipient cashout test; it does not prove
independent batch membership or claims by two different phones.

Account OTP cannot replace the claim-purpose OTP bound to an exact payment link.
The existing funded slots must retain their original assigned phones and amounts.
A new single-recipient funded fixture would need fresh IDs, a reviewed current
transaction and explicit approval for its additional test-token funding: the
original 1.9-token gross funding allowance has already been used. No such fixture
was created or funded here.

Browser integration, embedded-wallet ownership for recipients, treasury release,
mock payout completion and natural 48-hour expiry remain unverified by this run.
The earlier recall and funding results are recorded separately in
[the backend payment report](2026-10-30-backend-payment-verification.md).
