# Backend milestone: Render readiness and verified devnet deployment

Latest update: [Supabase is connected, migrated and verified](2026-10-29-supabase-verified.md).
Its database connection blocker is resolved; Render and live Privy verification remain.

Later update: the [Supabase pooler continuation](2026-10-29-supabase-pooler.md)
records the supplied pooler URI, verified TLS configuration and current database
authentication failure. The missing-pooler-URI statements below are historical.

This records the backend/deployment checkpoint for 29 October 2026. It supersedes the external-blocker
and test-count statements in the earlier backend handoff; its historical evidence
has been preserved. Work remains backend only. No hosted Render deployment, live
bank payout or combined hosted API/Privy/payment end-to-end result is claimed.

## Done

The existing backend at commit `8a94358` already contained the Anchor escrow,
transactional Postgres state machine, API handlers, session/OTP boundaries, payout
mocks and reconciliation. This continuation inspected that implementation, added
deployment and worker infrastructure, tightened authentication/configuration,
extended tests, provisioned local keys and actually deployed and exercised devnet.
Changes remain in the working tree; no commit or push was performed.

### Files created or changed

| Area                       | Important files                                                                                                                                                                                                                      | Result                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication and secrets | `apps/web/lib/server/auth.ts`, `secrets.ts`, `config.ts`; `scripts/bootstrap-local.mjs`, `verify-auth.ts`                                                                                                                            | ES256/P-256 PKCS8 signing, public JWKS, strict claims and KID checks, protected file loading, stable identities and missing-key restore guards.                          |
| Continuous worker          | `apps/web/lib/server/worker.ts`, `jobs.ts`, `db.ts`; `scripts/worker.ts`; `supabase/migrations/005_worker_leases.sql`                                                                                                                | Two-second polling, bounded backoff, maintenance/job ownership leases, heartbeat and stale-owner fencing, graceful shutdown and crash recovery.                          |
| Render                     | `render.yaml`, `.node-version`, `scripts/render-build.mjs`, `start-api.mjs`, `validate-render.mjs`, `config/render.schema.json`                                                                                                      | Separate API and worker, pinned Node/pnpm, verified monorepo commands, Render port binding, health endpoint and limited secret sharing.                                  |
| Chain safety and identity  | `apps/web/lib/server/solana/chain.ts`, `Anchor.toml`, `packages/shared/idl/muuve_escrow.json`                                                                                                                                        | Correct complete devnet genesis hash, bounded RPC timeout, stable deployed program ID and regenerated IDL. Contract behavior was not silently changed during deployment. |
| Devnet operations          | `scripts/operator.ts`, `deploy-devnet.ts`, `paced-deployment.ts`, `create-test-mint.ts`, `init-config.ts`, `fund-test-sender.ts`, `devnet-integration.ts`, `verify-devnet-evidence.ts`, `verify-expiry.ts`, `devnet-status.ts`       | Paced resumable upload, explicit network checks, durable signatures, stable mint/funding identity, actual lifecycle verification and a deadline-gated expiry follow-up.  |
| Database and providers     | `scripts/migrate.ts`, `database-status.ts`, `provider-readiness.ts`                                                                                                                                                                  | Project/TLS/session-pooler guard, schema and permission inspection, read-only external credential checks.                                                                |
| Tests                      | `tests/unit/{auth-jwt,privy,worker,local-keys,loader-layout,security}.test.ts`, `tests/db/{worker,payouts}.test.ts`, `tests/api/auth.test.ts`, `tests/helpers.ts`, `programs/muuve_escrow/tests/loader_layout.rs`, `tests/fixtures/` | Authentication negatives, key preservation, loader ABI, worker replicas/shutdown, OTP/session and payout recovery coverage.                                              |
| Verification and setup     | `scripts/record-check.mjs`, `audit-local-secrets.mjs`, `smoke-api.mjs`, `build-idl.mjs`, `test-db.mjs`; `.env.example`, `.gitignore`, `.prettierignore`, `package.json`, pnpm configuration/lockfile, CI workflow                    | Recorded evidence, protected secrets/build artifacts, disposable database tests and reproducible commands.                                                               |
| Handoff                    | `wallets.md`, `config/devnet-public.json`, `docs/render-deployment.md`, `docs/devnet-operations.md`, `docs/backend-runbook.md`, `README.md`, `CLAUDE.md`                                                                             | Copyable public identities, environment matrix, owner-authorized operator workflow and recovery instructions.                                                            |

The current `git status` is the authoritative complete changed-file list. Private
keys and `.env.local` are ignored, not source artifacts.

### Authentication and local configuration

Generated a private P-256 key in unencrypted PKCS8 PEM and corresponding public key,
plus stable UUID KID `ed86a909-f90c-4a96-bb04-6e9b7a9697fe`. Files are protected with
mode 0600 and key directories with 0700. Existing keys are preserved on repeat setup;
if a recorded identity loses its private key, provisioning refuses replacement.
Back up the ignored `keys/` directory securely before moving machines.

The local configuration uses `AUTH_JWT_PRIVATE_KEY_FILE`. Render accepts the actual
multiline PEM through `AUTH_JWT_PRIVATE_KEY`; configure exactly one loading method.
JWT issuer is canonical `APP_BASE_URL`, audience is the Privy app ID, subject is the
Muuve UUID, algorithm is ES256 and lifetime is five minutes. KID agrees with JWKS.
Local signing and verification through `/api/auth/jwks` passed. Invalid signature,
algorithm, issuer, audience, KID, time and subject cases are covered by tests.
Wallet ownership is checked through Privy server records, rather than a submitted
wallet address; live Privy wallet creation/linking is not verified.

Supplied external credentials are stored only in the ignored local environment.
Read-only Privy privileged API and Twilio Verify checks passed without printing
user records, creating wallets or sending SMS. Privy reports custom JWT auth disabled.
Local OTP remains mock and WhatsApp remains disabled. Rotate credentials disclosed
in conversation before publishing; enter replacements directly in local/hosted settings.

### Actual Solana devnet results

| Item                       | Verified value                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Program                    | `147uqUCHmuUgziXH31v352QycgSuxLgZfzN2MYE67Sxe`                                            |
| Upgrade authority          | `8QdwEAfREtpycxbCLEm8YhAC8CE5D941sqEmrXLx5HnD`                                            |
| Deployment signature       | `ba7R5Yw4CiZms7DT8hU3XikCt5GHrMywRNpgLuGNMhpvTPGnYwbbmgrrdzSQuJoaoFzsXXKJaRkXFyq6GHCSoCy` |
| Dedicated six-decimal mint | `H9d97DiVPydaxKTWFxVYfAg3FLSsicqx9u2boCoMksQJ`                                            |
| Treasury token account     | `29vE2HKDM5MLmDytaFQXDCp4ejSBam8FrGqZhTC85XuC`                                            |
| Config PDA                 | `9qa5jB5TrW1TBB9rk2t422cUTSoWTWJWoQYPgbZryy22`                                            |
| Artifact SHA-256           | `af668ad308f2e0cb8d018e8b6b770422af13a1a66c121876381c0ec273582680`                        |

The executable bytes and actual upgrade authority were read back from devnet.
Config roles, mint, token program, treasury, limits and exact 172800-second window
match configuration. This deployed mint uses **legacy SPL Token** with no freeze
authority. Both token programs pass local compiled-SBF tests; Token-2022 has not
been deployed/tested on devnet. Its supported extension allowlist remains narrow:
no mint extensions, and extension-free/ImmutableOwner token accounts only.

The initial bulk CLI upload failed after partial buffer writes. The retry inspected
that same authority-controlled buffer, uploaded only missing bytes with bounded RPC
backoff, checked the full finalized binary and completed deployment. A pinned Rust
SDK test independently checks the TypeScript loader instruction encoding/accounts.
No deployment identity, buffer funds or funded fixture was discarded after timeout.

Contract integration recorded **10 finalized transactions** and **17 negative
simulation observations** (including repeats during safe resume). These are different
evidence classes, not 27 finalized transactions. Verified single and fixed-allocation
batch creation, intent priority, independent wallet/treasury claims, sender recall,
duplicate broadcast recovery and terminal vault closure. Negative simulations check
claim key, attestor, index, duplicate claim, destination, sender authorization,
protected recall and premature expiry against the deployed program.

Exactly seven dedicated test tokens were minted. Finalized distribution is sender
2, recipient 2, treasury 2 and expiry vault 1. No real money moved. See the canonical
[deployment receipt](../../evidence/devnet/deployment.json),
[raw integration run](../../evidence/devnet/2026-10-29T08-27-04.679Z.json) and
[account/signature audit](../../evidence/devnet/lifecycle-verification.json).

All eight wallet roles and copyable addresses are in [wallets.md](../../wallets.md).
Finalized snapshot at 08:45:23 UTC: deployment authority **2.01390136 SOL**, fee payer
**0.97164108 SOL**. No additional SOL is needed for completed setup. Other authorities
can co-sign using the funded fee payer; they do not need separate SOL just to sign.

### Commands actually run and observed results

| Command/check                                                                       | Result                                                                                                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check`                                                                        | TypeScript and Prettier passed.                                                                                          |
| `pnpm test`                                                                         | 48 passed; 42 database/API tests skipped here and run separately below.                                                  |
| `pnpm test:db`                                                                      | 42 passed against disposable local PostgreSQL; zero skipped/failed.                                                      |
| `pnpm test:program -- --test-threads=1`                                             | 4 unit and 12 native runtime tests passed; 1 bootstrap case intentionally ignored in native mode and passed in SBF mode. |
| Pinned Rust `cargo test ... --test loader_layout`                                   | 1 independent loader ABI test passed.                                                                                    |
| `node --env-file=.env.local scripts/build-sbf.mjs` with documented cached toolchain | Real program-ID artifact built and fingerprinted.                                                                        |
| `pnpm test:sbf` with cached Cargo home                                              | All 13 compiled-SBF tests passed.                                                                                        |
| `node --env-file=.env.local scripts/build-idl.mjs`                                  | Generated 11 instructions and 3 accounts for actual program ID.                                                          |
| `pnpm build`                                                                        | Production Next.js build passed.                                                                                         |
| `node scripts/render-build.mjs api` and `worker`                                    | Exact build commands passed locally; not evidence of hosted services.                                                    |
| `pnpm check:render`                                                                 | Two services validated against official Render JSON Schema, command paths and secret separation.                         |
| `node --env-file=.env.local scripts/smoke-api.mjs`                                  | Actual production start/PORT binding, health, public JWKS signature and auth/origin/webhook rejection checks passed.     |
| `node --env-file=.env.local --import tsx scripts/verify-auth.ts`                    | Local signing, endpoint public key and token-contract checks passed.                                                     |
| `node scripts/audit-local-secrets.mjs`                                              | Private permissions, Git exclusion and no local secret values in emitted Next artifacts passed.                          |
| Devnet deploy/mint/treasury/Config/funding/integration/readiness/audit scripts      | Completed with actual finalized transactions and public receipts.                                                        |
| Hosted migration and `database-status.ts`                                           | Blocked by `ENETUNREACH`; no hosted migration success claimed.                                                           |

Raw logs and exact commands/exit codes are in `evidence/render-devnet/`; consolidated
results are in [verification.json](../../evidence/render-devnet/verification.json).
The earlier `evidence/backend-milestone/` is historical local-fixture evidence.
Native optional bigint bindings fall back to JavaScript; Anchor emits a dependency
deprecation warning. Neither warning caused these checks to fail. Remote CI is authored
but has not been run on GitHub.

Installed/used versions: Node 24.19.0, pnpm 12.15.0, host Rust/Cargo 1.99.1,
local Agave/Solana CLI 2.3.13, platform-tools v1.58 with Rust 1.95.0-dev and
Anchor library 0.31.1. The `solana` and `anchor` commands are not on normal PATH;
the deployed workflow uses the repository's cached Solana binary and pinned
Cargo/Anchor dependencies rather than assuming a globally installed Anchor CLI.

### Database and worker evidence

All five migrations applied to an isolated loopback test database. Verification
found 17 application tables, 232 constraints and 47 indexes, RLS enabled on every
application table, and PUBLIC schema/table access blocked. Transaction/state/event,
fixed allocations, reservations, webhook deduplication, finality, timeout/replacement
and payout retry paths are exercised there. This says nothing about the current
schema in hosted Supabase, which could not be reached.

The real worker entry point was started against disposable Postgres and a loopback
RPC fixture. Queued mock work progressed and SIGTERM drained cleanly. Tests cover
concurrent replica ownership, lease expiry/recovery, stale-owner fencing and failed
job quarantine. Mock payouts cover success, failure, retry, ambiguity and reconciliation.
No continuous worker has been deployed to Render yet.

## In progress and exact remaining blockers

1. **Supabase SQL connectivity and migrations.** The configured direct endpoint is
   unreachable over IPv6 from this machine. Obtain the actual **Session pooler**
   PostgreSQL URI from Supabase → Connect → Connection string. Put it in local
   `DATABASE_URL` and Render, with username `postgres.yirelxmcveyxcqofzayq`, dashboard
   hostname/region, port 5432 and verified TLS. A browser API URL/publishable key is
   not a PostgreSQL connection. The pooler hostname cannot be derived reliably from
   the project reference. Then run the two commands below. No drop/reset is needed.
2. **Render dashboard/repository connection.** No authenticated hosting connection
   or stable HTTPS service URL is available here. Push reviewed source without
   secrets, create the `render.yaml` Blueprint, review its two Starter plans, enter
   secrets, set actual `APP_BASE_URL`, migrate the database and start both services.
   Build/start commands and the complete API/worker environment matrix are in
   [render-deployment.md](../render-deployment.md). No Vercel deployment was configured.
3. **Privy custom auth.** Credentials work, but custom JWT authentication is disabled.
   Request/enable the documented custom-auth integration, choose client-side token
   authentication for this repository's token contract, set the public HTTPS JWKS
   URL to `APP_BASE_URL/api/auth/jwks` and identity claim to `sub`. Verify the app's
   allowed origins, issuer/base URL and cookies after Render assigns its URL. These
   steps, current dashboard locations and official references are in the Render guide.
4. **Real SMS verification.** Twilio credential/service lookup passed. An explicitly
   authorized recipient number and actual delivery test remain outstanding. Local
   mock OTP works only in local mode. Render uses Twilio and deliberately rejects
   local mock authentication. No real OTP has been sent.
5. **Actual 48-hour devnet expiry.** Fixture
   `Hg9tsPmCdDBMbWcUEwepRGcNyUfxGubSaFBPYzxdFtde` expires **31 October 2026 at
   08:39:30 UTC / 09:39:30 Lagos**. It is intentionally still funded with one token.
   Run the expiry command only after that deadline. The follow-up verifies finalized
   execution, unchanged allocations, terminal states, exact sender token refund,
   vault closure and rent to the recorded beneficiary. Those post-expiry checks have
   not passed yet; time cannot be replaced with a shortened Config window.
6. **Release verification.** Combined hosted API + real Privy wallet + devnet payment
   flow, deployed worker behavior, Token-2022 devnet deployment, remote CI and human
   security review remain unverified. Real NGN payouts, rates, bank resolution and
   sensitive-data encryption/tokenization are deferred by the owner, not completed.

No command is awaiting interactive permission. External dashboard configuration and
the real expiry deadline are the remaining prerequisites, not routine approval gates.

## Commands to test your checkout

From the repository root, after setting the correct SQL connection:

```sh
MUUVE_ALLOW_MIGRATIONS=1 node --env-file=.env.local --import tsx scripts/migrate.ts
node --env-file=.env.local --import tsx scripts/database-status.ts
node --env-file=.env.local --import tsx scripts/verify-auth.ts
node --env-file=.env.local --import tsx scripts/verify-devnet.ts
node --env-file=.env.local node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1
```

In a second terminal:

```sh
node --env-file=.env.local --import tsx scripts/worker.ts
```

Local OTP signup/login/session, expiry and rate-limit assertions can be exercised
without sending SMS using `pnpm test:db`. The local API requires the migrated SQL
database for those flows; a 200 health response alone does not establish readiness.

After the actual expiry deadline:

```sh
OPERATOR_APPROVED_DEVNET=1 MUUVE_RUN_DEVNET_TRANSACTIONS=1 \
MUUVE_DEVNET_EXPIRED_LINK_PDA=Hg9tsPmCdDBMbWcUEwepRGcNyUfxGubSaFBPYzxdFtde \
  node --env-file=.env.local --import tsx scripts/verify-expiry.ts
```

If an operation times out, reconcile its recorded signature/provider identity before
submitting another principal release. Keep the same logical payout identity on
provider retries. Never discard ambiguity or unlock reservations merely on timeout.

## Decisions made

The owner approved implementation, local secret provisioning and devnet transactions
after the earlier plan-only request. No separate permission is needed for those
already-authorized operations. `docs/backend-decisions.md` remains the product source
of truth: fixed allocations; sender-scoped IDs; distinct roles; immutable mint;
snapshotted link terms; confirmed on-chain intent priority capped at 120 seconds;
claims/recalls before expiry only; finalized chain execution before payout; immediate
replacement preparation with guarded submission; stable payout retry identity.

## Known issues / next step

The first actionable operator step is the genuine Supabase Session pooler URI.
Render and Privy setup can proceed independently of the pending aged-link test.
Preserve and back up the stable private identities; do not rerun deployment or mint
funding to compensate for an unrelated database or hosting configuration problem.
