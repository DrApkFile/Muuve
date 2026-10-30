# Hosted wallet rollout: migration verified, owner deployment pending

## Current status after owner approval

The owner explicitly approved migration 006. It was applied to the intended hosted
Supabase development project and independently verified. The owner can now commit
and push main to deploy the API. This agent has not committed, pushed or triggered
Render, and has not modified/deployed the worker or changed the Solana program.

Actual execution: `wallet-rollout-hosted-migration`, exit 0, logged
`Applied 006_wallet_login.sql`. Both post-application checks exited 0:
`wallet-rollout-hosted-schema` and `wallet-rollout-hosted-preservation`.

Verified on the hosted database:

- Six migration records and the approved 006 checksum.
- New challenge table with the intended schema and validated constraints.
- All four challenge indexes valid and ready; 51 indexes across the application schema.
- RLS enabled and PUBLIC table/schema privileges blocked.
- Nullable phone columns protected by the new user/session/principal identity checks.
- Existing row counts and private keyed fingerprints unchanged: 3 users, 11 sessions,
  8 OTP challenges, zero links, recipient slots and principals.
- No customer deletion, reset, backfill or row rewrite occurred.

Evidence: `evidence/wallet-rollout/after.json`, migration/schema/preservation command
records and logs under `evidence/render-devnet/wallet-rollout-hosted-*`.
The preservation check compares the immediate pre/post-migration snapshots; later
legitimate authentication activity changes the row set and must not be mistaken for
migration damage if someone reruns that historical comparison.

Hosted wallet login, deployed build identity and API error retests remain pending the
owner's source push and Render deployment. Full funded payment E2E is still unverified.

## Done: preflight before approval

Work remains on **main**. The owner will push/deploy the API; this agent will not
publish source, trigger Render, modify a hosted worker or deploy a Solana program.
Migration 006 had not been applied during the preflight below. No shared-environment
writes were performed until the explicit approval recorded above.

Read the full wallet handoff, API/security contract, root instructions, migration,
auth/session/claim/link/schema changes, previously fixed errors, test and deployment
scripts. Added `scripts/verify-wallet-rollout.ts`, a read-only before/after verifier
that validates the exact intended project and certificate-verified TLS, compares
migration checksums, checks new-constraint compatibility and captures private keyed
fingerprints for record-preservation verification. It never prints row contents,
phone numbers, credentials, cookies, JWTs or keys.

### Fresh test evidence

| Command                                                                             | Exit | Result                                                                           |
| ----------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------- |
| `pnpm test`                                                                         | 0    | 62 passed; 58 database/API cases skipped here and run below.                     |
| `pnpm test:db`                                                                      | 0    | 58 passed; disposable loopback PostgreSQL only.                                  |
| `pnpm check`                                                                        | 0    | TypeScript and repository Prettier passed.                                       |
| `pnpm check:render`                                                                 | 0    | Blueprint schema/commands/environment references passed.                         |
| `node --env-file=.env.local --import tsx scripts/verify-wallet-rollout.ts --before` | 0    | Intended hosted Supabase target, TLS and pre-migration checks passed, read-only. |
| `git diff --check`                                                                  | 0    | No whitespace errors.                                                            |

Exact commands, timestamps and logs are in `evidence/render-devnet/wallet-rollout-*`.
The app source is unchanged from the previously built/tested wallet implementation;
this preflight adds verification tooling and documentation only. Earlier successful
Privy signatures remain earlier live evidence and were not rerun or attributed to
this preflight. No new dependency or runtime secret is introduced.

### Actual hosted read-only observations

- Intended project: **yirelxmcveyxcqofzayq**.
- Session pooler: `aws-0-eu-west-1.pooler.supabase.com:5432`, database `postgres`.
- TLS encryption and certificate authorization succeeded. Local/API/worker exports
  identify the same SQL credentials and target, allowing only the local CA path difference.
- Migrations 001–005 exist and their checksums match repository SQL.
- Migration 006 is absent; `muuve.wallet_auth_challenges` is absent.
- Existing rows: **3 users, 11 sessions, 8 OTP challenges, 0 links, 0 recipient slots,
  0 principals**. Counts and keyed fingerprints are saved for post-migration comparison.
- Existing rows violating the proposed identity constraints: **zero** in all three
  affected tables. No backfill, customer-record deletion or record rewrite is needed.
- Render health and JWKS returned 200 on retry; the initial health request timed out
  after 45 seconds. The cause of that timeout is unverified. Record both outcomes;
  do not infer full service reliability from the successful retry.
- Config exports specify devnet, mocked payouts, Twilio and canonical origin
  `https://muuve.onrender.com`. Exported values alone do not prove every remote setting.

Evidence: `evidence/wallet-rollout/before.json` and `hosted-readonly.json`.

## Migration 006: reviewed and approved impact

Reviewed SQL: `supabase/migrations/006_wallet_login.sql`.

```text
SHA-256 cb438d6608c2212a22bbbf3c96c8a6dec19f77e19d71dadc5abcc8adb5c378b1
```

| Existing object                 | Exact change and retained requirement                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `muuve.users.phone_e164`        | Drop column-level NOT NULL. Existing phone values and the UNIQUE constraint remain.                                                                                                                                  |
| `muuve.users.auth_origin`       | Replace its CHECK to accept `wallet` alongside `muuve` and `cleva_preview`. Existing origin values are unchanged.                                                                                                    |
| `muuve.users_identity_required` | Add CHECK: wallet-origin accounts require a wallet address; other origins require a non-null phone. Existing wallet uniqueness remains.                                                                              |
| `muuve.sessions.phone_e164`     | Drop column-level NOT NULL. Add `sessions_identity_required`: account sessions require a user ID; claim/proof sessions still require a non-null phone. Existing phone-auth sessions retain their values.             |
| `muuve.principals.owner_phone`  | Drop column-level NOT NULL. Add `principal_recipient_phone_required`: escrow-claim principals retain a required phone; wallet-source principals may omit it. The existing wallet-source user-ID requirement remains. |

New table `muuve.wallet_auth_challenges`:

- UUID primary key, funding-wallet public address, SHA-256 browser-cookie hash,
  canonical origin and exact signed message, request IP, creation/expiry times,
  optional consumption time and failed-attempt counter.
- Required identity/message/IP/timestamp fields are NOT NULL. Counter defaults to
  zero and is constrained to 0–5. Cookie hash is exactly 64 lowercase hex characters.
- Expiry must be after creation and at most five minutes later.
- Three explicit indexes: `(wallet_address, created_at)`, `(ip, created_at)` and
  `(expires_at)`, plus the implicit primary-key index: four total.
- RLS enabled; all PUBLIC table privileges revoked. Existing `muuve` schema PUBLIC
  restrictions remain. The privileged runtime database role still relies on the API's
  per-user authorization; enabling RLS is not a new per-customer policy for that role.

Recipient phone security is retained by the database constraints and the application:
wallet login issues an account session with no verified phone, even for an existing
phone user; claim authorization requires a phone-backed claim session; keep requires
matching verified account/claim phones. The new sender session cannot supply that
phone proof. These negative cases passed the fresh database/API suite.

There are no DELETE, UPDATE, TRUNCATE, DROP TABLE, customer INSERT, phone backfill or
identity-merging operations. Existing phone users, bank/payout records, allocations,
keys and chain configuration are not rewritten. Only a new empty table, constraints,
indexes and the migration-ledger record are added, alongside the described nullability
and auth-origin changes.

The migration runner serializes migrations with its advisory lock, checks earlier
checksums and applies migration 006 plus its ledger insert in one transaction. On
failure that transaction rolls back. ALTER TABLE obtains locks and validates the
CHECK constraints, so brief API blocking is possible; no zero-downtime guarantee is
made. PostgreSQL documents those [locking and validation semantics](https://www.postgresql.org/docs/current/sql-altertable.html).

### Approved command — now executed successfully

This is the exact documented procedure, with only migration 006 currently pending:

```sh
MUUVE_ALLOW_MIGRATIONS=1 MUUVE_DATABASE_PROJECT_REF=yirelxmcveyxcqofzayq \
  node --env-file=.env.local --import tsx scripts/migrate.ts
```

Approval covers this reviewed migration against the intended **development** Supabase
project. Recheck the pending migration set/hash immediately before execution; any new
unreviewed migration is outside this approval. It does not authorize database resets,
program transactions, payouts or hosting changes.

### Post-application verification — both commands passed

```sh
node --env-file=.env.local --import tsx scripts/database-status.ts
node --env-file=.env.local --import tsx scripts/verify-wallet-rollout.ts --after
```

Verify six migration records, the reviewed 006 checksum, the new table, the three
changed column-nullability flags, validated identity/challenge constraints, four valid
and ready indexes, RLS/PUBLIC restrictions, and unchanged existing-record fingerprints.
Inspect any mismatch; do not edit existing records to manufacture a match. This
verification must complete before the owner pushes/deploys the new API source.

## In progress: hosted verification and push timing

**Migration verification is complete; the owner can now commit/push main.** Include
the new wallet-auth source and migration files as well as the reviewed API error fixes.
No source was committed or pushed by this agent. Wait for the resulting Render build
to become live before starting the hosted authentication tests.

The repository Blueprint declares `autoDeployTrigger: off` for the API. The existing
Render dashboard may differ; its actual setting is not accessible here. The owner's
intended automatic deployment requires the API service linked to **main** with an
enabled Auto-Deploy setting. Render documents [On Commit and After CI Checks Pass](https://render.com/docs/deploys).
This agent will not change that setting or create/deploy a worker. Preserve the
existing service, secrets, certificate Secret File, monorepo commands and port binding.

After owner deployment, capture the deployed commit/build identity and health before
running hosted wallet challenge/login, exact-message signing, cookie/session/JWT/JWKS,
refresh/logout, replay, tampering, wrong signer and recipient-phone authorization tests.
Let a new dedicated challenge expire naturally for the hosted expiry rejection;
do not shorten an existing row's deadline. Account sessions last 30 days; actual
natural session expiry cannot be claimed from refresh/logout rejection or a local
expiry fixture. Record any case that needs an approved fixture as blocked.

The existing Privy integration-test identity was created for a **local SQL fixture**.
Do not insert that UUID into hosted users, attach its wallet to a different user,
or fabricate a Privy record to satisfy an ownership test. Establish the actual hosted
identity through the real wallet-login route and compare real Privy records. A browser
wallet client remains outside this repository; missing client steps must be reported.

Missing-operation and unowned-wallet errors can be retested with an authenticated
hosted session. A genuine foreign operation is required to prove foreign-operation
isolation; a nonexistent UUID is only the missing-record test. Provider-failure mapping
is verified locally with injected SDK failures. Do not break hosted credentials or
change provider configuration to manufacture a hosted 503.

## Decisions made

All work stays on main. The owner controls push/deployment. The shared migration followed
the owner's explicit Phase 2 approval. Kept the SQL file/hash
unchanged and all auth/origin/phone/claim-key/provider/devnet safeguards intact. Payouts
remain mocked and the worker remains local. No principal release is authorized here.

## Known issues / next step

Waiting for the owner to commit/push main and confirm the resulting Render deployment
is live. Then verify actual hosted wallet authentication and the earlier error fixes.
No hosted wallet-login success or funded payment E2E success is claimed yet.
