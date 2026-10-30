# Supabase connected, migrated and verified — 29 October 2026

Later update: the owner reported a Render build success followed by an operator-env
startup rejection. See the [Render startup handoff](2026-10-29-render-startup.md).
The database verification below remains valid; hosted API health is not yet verified.

## Done

The owner's final password confirmation authenticated successfully. Saved the working
connection only in ignored mode-0600 `.env.local`, retaining the exact project Session
pooler endpoint, verified TLS and official public CA. No password is recorded here.
The prior invalid-password blocker is resolved.

Applied all five migrations to the intended Supabase PostgreSQL database:

1. `001_backend.sql`
2. `002_state_guards.sql`
3. `003_treasury_origin.sql`
4. `004_immutable_terms.sql`
5. `005_worker_leases.sql`

Replayed the migration runner successfully: existing migration checksums matched and
no migrations were reapplied. No tables were dropped or reset.

Hosted schema verification passed: **17 application tables, 47 indexes, 107 catalog
constraints and 125 NOT NULL columns**. Every application table has RLS enabled;
PUBLIC schema/table access is blocked. Supabase's `anon` and `authenticated` roles
have neither schema usage nor SELECT on the user table. The application's server
role connects successfully with `search_path=muuve,public`.

Supabase runs PostgreSQL **17.11**; local PostgreSQL is **18.6**. The earlier local
count of 232 catalog constraints includes the 125 NOT NULL constraints that PostgreSQL
18 additionally stores in `pg_constraint`. The hosted count of 107 plus 125 NOT NULL
columns accounts for that difference. See the
[PostgreSQL 18 release note](https://www.postgresql.org/docs/18/release-18.html).

## HTTP and worker verification

Added `scripts/smoke-hosted-backend.mjs`, an explicitly authorized operator smoke
check. It starts the production API on loopback and a local worker, both using the
real Supabase database. It requires local/mock/devnet configuration, verified TLS,
the project-scoped Session pooler and `--allow-test-records`.

The successful run verified:

- Mock OTP, invalid-code rejection, signup, account session and single-use proof.
- Locally issued Privy-bridge JWT verification through public JWKS, refresh rotation
  and logout revocation. It does not establish live Privy wallet linking.
- Existing-account login, expired sessions/challenges and phone OTP rate limits.
- A real worker handling a dedicated obsolete-payout no-op job, releasing all four
  maintenance leases and exiting cleanly with status zero after SIGTERM.

Next.js returns the conventional status 143 for requested SIGTERM; the smoke harness
now recognizes that API exit while still requiring a clean worker exit. Historical
harness failures were preserved under `initial-harness-*` and `api-exit-harness-*`.
Those runs exposed an invalid synthetic phone fixture and an overly strict API-exit
assertion; the corrected full run exited successfully.

No real SMS, Privy wallet creation, fiat payment or principal-release transaction
was submitted. The worker job deliberately references no actual payout. Dedicated
synthetic test accounts, revoked/expired sessions, OTP challenges, audit events and
completed no-op jobs remain as test evidence; the test does not reset shared data.

Run only against a development database where these test records are acceptable:

```sh
node --env-file=.env.local scripts/smoke-hosted-backend.mjs --allow-test-records
```

The worker portion refuses existing operations, payouts, principals or active jobs,
so it cannot silently process unrelated payment work as part of this smoke test.
Stop local API/worker test processes on completion; the harness does this itself.

## Evidence

- `evidence/render-devnet/supabase-confirmed-password.json`: verified successful login.
- `supabase-migrations.{json,log}`: five migrations applied.
- `supabase-migration-replay.{json,log}`: checksum/idempotent replay passed.
- `supabase-schema.{json,log}`: actual hosted schema and permissions.
- `supabase-platform.json`: server version, search path, NOT NULL columns and client roles.
- `supabase-http-worker-result.json`: successful HTTP/worker run and dedicated fixture IDs.
- `verification.json`: consolidated current results; earlier failed authentication
  attempts remain historical evidence.

## In progress / remaining actions

Supabase is ready for the backend. Render API/worker services have not been created
or verified remotely. Enter the working connection directly in Render's secret
configuration, including both TLS parameters documented in
[the deployment guide](../render-deployment.md).

Privy custom-JWT activation and the stable public JWKS URL still require dashboard
setup. Real SMS requires an explicitly authorized recipient number. The actual
devnet expiry fixture remains pending until **31 October 2026, 09:39:30 Lagos time**.
Fiat payouts remain mocked as approved. No combined Render/Privy/devnet payment test
or human security review is claimed by this database verification.

## Decisions made

Preserved the existing schema design and role keys. Used the owner-supplied database
credentials only for the intended project. Kept credentials and tokens out of logs.
Did not substitute browser Supabase credentials or disable certificate validation.

## Known issues / next step

Continue with the Render Blueprint and Privy dashboard configuration using the
existing [Render guide](../render-deployment.md). The local API and worker can now
use the working `.env.local` connection. Back up the ignored signing/Solana keys
before moving machines; never commit or upload that directory as repository content.
