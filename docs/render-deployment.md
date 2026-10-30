# Render API and background worker deployment

This repository deploys a backend-only Next.js Node service and a separate continuous
Node worker. Solana is devnet only. Fiat payouts, rates, bank resolution and Cleva are
mocks. Local tests, devnet execution and hosted Render execution are separate evidence.

## Services and exact commands

Use the repository root (`.`), not `apps/web`, as Render's Root Directory. The root
owns the package manifest, pnpm lockfile, shared package and worker scripts. The start
script explicitly selects `apps/web` and binds `0.0.0.0` to Render's `PORT`.

| Setting            | API web service                     | Background worker                      |
| ------------------ | ----------------------------------- | -------------------------------------- |
| Blueprint name     | `muuve-api`                         | `muuve-worker`                         |
| Runtime            | Node 24.19.0                        | Node 24.19.0                           |
| Package manager    | pnpm 12.15.0                        | pnpm 12.15.0                           |
| Root Directory     | `.`                                 | `.`                                    |
| Build Command      | `node scripts/render-build.mjs api` | `node scripts/render-build.mjs worker` |
| Start Command      | `node scripts/start-api.mjs`        | `node --import tsx scripts/worker.ts`  |
| Health check       | `/api/health`                       | No HTTP listener                       |
| Shutdown allowance | 120 seconds                         | 120 seconds                            |

The build script checks the pinned Node version, uses matching installed pnpm or
bootstraps that exact version through `npm exec`, installs the frozen lockfile with
development tools retained, and runs type checking. The API also runs `pnpm build`.
The worker uses `tsx` at runtime, so do not prune it from the deployment install.
Dependency hooks are explicitly allowlisted: esbuild only; optional native bigint
and websocket addons are disabled. Their JavaScript fallbacks are used.

`render.yaml` selects Starter services and disables automatic deployments. Creating
these services can incur Render charges; no service or billing authorization is
created by adding the Blueprint. Review plans before creating it. Do not use a
sleeping/free web service as a replacement for a continuously running worker.

Validate locally with `pnpm check:render`. The checked-in schema is the official
`https://render.com/schema/render.yaml.json`, retrieved 2026-10-29. Validation checks
YAML, the official schema, script paths, environment references and worker secret
separation. It does not replace authenticated Render API/dashboard validation or
prove a hosted deploy. Reference: [Render Blueprint specification](https://render.com/docs/blueprint-spec).

## Local provisioning and secret handling

`pnpm setup:local` creates missing stable devnet keypairs, a P-256 ES256 private key
in unencrypted PKCS8 PEM, a matching public key, a UUID key identifier, local session
secrets and `.env.local`. Private files are mode 0600 and key directories are 0700.
It preserves existing values and refuses inconsistent identities; it never silently
rotates a deployed configuration. Back up the ignored key directory securely before
deployment. Deleting it destroys local control of the corresponding authorities.
On a new machine, restore those files first: a saved public identity with a missing
private key causes provisioning to fail rather than generate a replacement.

The application accepts `AUTH_JWT_PRIVATE_KEY_FILE` locally, or
`AUTH_JWT_PRIVATE_KEY` containing the actual multiline PKCS8 PEM in Render. Set one,
not both. Solana `*_SECRET` variables accept a JSON array of exactly 64 integer bytes;
local `*_SECRET_FILE` alternatives load protected files. Do not paste a file path
into a JSON secret variable. `AUTH_JWT_KID` must match the generated key ID in signing
and JWKS. Public identities are in `config/devnet-public.json` and `wallets.md`.

Never upload `.env.local`, the key directory, deployment/admin secrets, test-sender
keys, claim keys or a compiled local environment as repository files. In Render,
configure secret values in its environment settings. The private JWT signing key
and Privy application secret must never have a `NEXT_PUBLIC_` prefix. The Privy app
ID is public. Rotate external credentials previously disclosed in conversation.

For local commands, load the root file explicitly:

```sh
node --env-file=.env.local --import tsx scripts/verify-auth.ts
node --env-file=.env.local node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1
node --env-file=.env.local --import tsx scripts/worker.ts
```

## Supabase PostgreSQL

The intended project reference is `yirelxmcveyxcqofzayq`. Use the database connection
string, not `NEXT_PUBLIC_SUPABASE_URL`, a publishable key or a service-role API key.
The application uses `pg` and real SQL transactions; no Supabase browser variables
are required. Passwords containing reserved URL characters must be percent-encoded.
Do not let shell expansion change a dollar sign in a password.

The direct hostname may resolve to IPv6 and was unreachable from this machine.
Supabase documents Render as an IPv4-only environment. Open Supabase **Connect**,
choose the database **Connection string**, and select **Session pooler**. Copy its
actual hostname/region and username (`postgres.<project-ref>`); do not invent the
region. Session pooling uses port 5432. See [Supabase network compatibility](https://supabase.com/kb/troubleshooting/supabase--your-network-ipv4-and-ipv6-compatibility-cHe3BP).

Use certificate-verified TLS (`sslmode=verify-full`). Install the provider CA if your
environment requires it; do not fix TLS errors with `rejectUnauthorized:false`.
The owner-supplied pooler required Supabase's public CA. This repository now includes
the official certificate at `config/certs/supabase-prod-ca-2021.crt`, with download
provenance beside it. For local and Render `DATABASE_URL`, append
`sslmode=verify-full&sslrootcert=config/certs/supabase-prod-ca-2021.crt` using the
appropriate `?` or `&` separator. Both services start from the repository root, so
that relative path resolves consistently. Do not put a private key in this file.
See the [certificate provenance and renewal notes](../config/certs/README.md).
Use the direct connection if IPv6 is available, otherwise the session pooler for
migrations. Transaction pooling is not the documented migration path: the runner
uses a session advisory lock. `MUUVE_DATABASE_PROJECT_REF` enables a project/host guard.

After putting the connection in `.env.local`, run:

```sh
MUUVE_ALLOW_MIGRATIONS=1 node --env-file=.env.local --import tsx scripts/migrate.ts
node --env-file=.env.local --import tsx scripts/database-status.ts
```

The runner never resets tables. It locks migration execution and verifies prior
checksums. The verifier checks migration names, schema tables, RLS, constraints,
indexes and PUBLIC access. Tables are in `muuve`; use an owner/BYPASSRLS server role.
Use a separately managed migration role if you restrict the runtime role further.

`pnpm test:db` uses a separate disposable loopback database and never tests by
truncating the hosted project. Test fixtures refuse an external database hostname.
Do not set `MUUVE_TEST_DB=1` against a hosted connection. Hosted verification is
read-only apart from the explicitly authorized migration command and normal API work.

The owner's Supabase project was subsequently connected, migrated and verified.
For an explicitly authorized development database, a separate smoke check can create
dedicated synthetic records without resetting shared tables:
`node --env-file=.env.local scripts/smoke-hosted-backend.mjs --allow-test-records`.
It runs the production API on loopback with mock OTP and a local worker, verifies
sessions/JWTs and a no-op queue job, and refuses existing payment work. It leaves
test records and sends no SMS or payout. See the
[verified database handoff](handoff/2026-10-29-supabase-verified.md) for exact evidence.

## Render environment matrix

The Blueprint prompts for API secrets and references only necessary values in the
worker. Do not link an unrestricted environment group containing operator secrets.

| Variables                                                                     | API               | Worker        | Notes                                                                           |
| ----------------------------------------------------------------------------- | ----------------- | ------------- | ------------------------------------------------------------------------------- |
| `NODE_VERSION`, `NODE_ENV`                                                    | Yes               | Yes           | 24.19.0 and production.                                                         |
| `APP_ENV`, `APP_BASE_URL`                                                     | Yes               | No            | `preview`; exact stable HTTPS origin, no trailing slash.                        |
| `DATABASE_URL`                                                                | Yes               | Yes           | Actual Supabase SQL connection with verified TLS.                               |
| `SESSION_SECRET`                                                              | Yes               | No            | Blueprint generates a random value.                                             |
| `CRON_SECRET`                                                                 | Yes               | No            | Authenticates optional manual maintenance endpoints.                            |
| `MOCK_WEBHOOK_SECRET`                                                         | Yes               | Yes           | Same value for webhook verification and worker delivery.                        |
| `SOLANA_CLUSTER`, `SOLANA_RPC_URL`                                            | Yes               | Yes           | devnet only; actual genesis is checked.                                         |
| `SOLANA_RPC_URL_FALLBACK`                                                     | Optional          | Optional      | Add to both if used; it must also be devnet.                                    |
| `MUUVE_PROGRAM_ID`, `USDT_MINT`, `TOKEN_PROGRAM_ID`, `TREASURY_TOKEN_ACCOUNT` | Yes               | Yes           | Must match deployed Config, not merely the local manifest.                      |
| `CLAIM_WINDOW_SECS`                                                           | Yes               | Yes           | Exactly `172800`.                                                               |
| `FEE_PAYER_SECRET`, `ATTESTOR_SECRET`, `TREASURY_SECRET`                      | Yes               | Yes           | Separate role keys.                                                             |
| `TEST_MINT_AUTHORITY_SECRET`                                                  | Yes               | Yes           | Devnet funding; worker also needs it to replace interrupted funding operations. |
| `ATTESTOR_KEYRING`, `TREASURY_KEYRING`                                        | When rotating     | When rotating | Historical key arrays until old liabilities are terminal.                       |
| `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET`                                | Yes               | No            | The app ID alone is public.                                                     |
| `AUTH_JWT_KID`, `AUTH_JWT_PRIVATE_KEY`                                        | Yes               | No            | Stable KID and actual multiline PKCS8 PEM.                                      |
| `OTP_PROVIDER`, `WHATSAPP_OTP_ENABLED`                                        | Yes               | No            | Twilio on Render; WhatsApp false initially.                                     |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`        | When enabling OTP | No            | Add directly in Render; absent credentials return unavailable.                  |
| `PAYOUT_PROVIDER`                                                             | Yes               | Yes           | `mock`.                                                                         |
| `RATE_PROVIDER`, `MOCK_NGN_PER_USD`                                           | Yes               | No            | `mock`, `1520`; mock quoting applies its documented spread.                     |
| `TRUSTED_PROXY`                                                               | Yes               | No            | False until forwarded-IP overwrite and origin isolation are verified.           |
| `WORKER_POLL_MS`                                                              | No                | Yes           | `2000`; accepted range 1000–5000 ms.                                            |

The public role-manifest variables and operator consent flags are for local setup/
verification scripts, not normal hosted API requirements. Do not put admin, upgrade,
program, mint-account, test-sender, test-recipient or claim-key secrets into Render.

Local mock OTP requires `APP_ENV=local` and devnet. Render startup rejects that mode.
Do not set Render to local merely to bypass Twilio setup. You can deploy the service
with Twilio selected and finish dashboard credentials later; OTP stays unavailable.

## Create the Render deployment

1. Commit/push the reviewed code without keys or environment files. Connect that
   repository to Render and create a Blueprint from `render.yaml`.
2. Review the two services and paid plans. Enter the prompted secrets through Render.
   For `APP_BASE_URL`, use the service's actual assigned stable HTTPS URL or your
   configured custom domain. Do not guess a hostname from the requested service name.
3. Apply/verify Supabase migrations before starting the worker. No build/start or
   Blueprint hook automatically migrates the shared database.
4. Confirm the API binds Render's `PORT` and `/api/health` returns 200. This is a
   liveness check, not a complete database or blockchain readiness check.
5. Verify `/api/auth/jwks` publishes only the expected public EC key and KID.
6. Start the worker and confirm its heartbeat/job progress in logs and the database.
   It uses Postgres queues; no Redis or additional Render database is required.
7. Run authenticated API tests against the deployed HTTPS origin. No hosted URL,
   successful deployment or external-wallet linkage is inferred from a local build.

Render workers run continuously and do not listen for HTTP requests. This supports
the seconds-level queue polling; minute-based cron is not used as its replacement.
Reference: [Render background workers](https://render.com/docs/background-workers).

## Worker behavior and recovery

The worker processes queued jobs every two seconds under normal operation. Slower
maintenance runs in a separate lane so RPC maintenance does not block queue polling.
Reconciliation and expiry are due every five minutes, failed-payout recovery every
15 minutes, and monitoring every minute. Distributed maintenance leases and per-job
ownership tokens/renewal prevent concurrent healthy replicas taking the same work.
On database/network partition, a stale process cannot overwrite a newer lease's
result. External effects still rely on provider idempotency and on-chain receipts.

Failures back off to at most 30 seconds. Job attempts and quarantine are durable.
SIGTERM stops new work, drains current work and closes the database. After 110 seconds
the process exits unsuccessfully if draining cannot finish; leases recover on restart.
Do not terminate by deleting queue rows or releasing uncertain principal reservations.
The authenticated cron endpoints remain for explicit recovery; do not configure a
second continuous scheduler alongside this worker unnecessarily.

## Troubleshooting: operator environment rejected before port binding

### Prepared local upload files

The owner-requested `.env.render-api` and `.env.render-worker` files are generated
locally, Git-ignored and mode 0600. They contain actual runtime values from the
verified local configuration. Local private-file alternatives are replaced by their
contents; deployment/admin/test-sender settings are excluded. The worker file contains
only its own required settings and excludes Privy, Twilio, session and JWT secrets.

The owner supplied `https://muuve.onrender.com`; that exact origin is populated in
the API file's `APP_BASE_URL`. No hostname was guessed from the service name or ID.
The worker does not need that variable. Keep `.env.local` unchanged.

For these exports, `DATABASE_URL` references
`/etc/secrets/supabase-prod-ca-2021.crt`. In **Environment → Secret Files**, add a file
named **supabase-prod-ca-2021.crt** with the contents of the public certificate at
`config/certs/supabase-prod-ca-2021.crt`. Add it to each service using an export.
This works with the existing application code and does not require uploading local
private-key files or waiting for the CA to be committed into the repository.

Remove the old manually imported environment entries and inappropriate linked groups
before using **Add from .env**. Importing the replacement file adds/updates its keys;
it does not clean up unrelated old operator variables automatically. Import the API
file into the API service and the worker file into the worker, then save and deploy.
Never commit or share these two secret-bearing files.

### Diagnose the startup rejection

If startup reports `Operator keys are forbidden in the Render API environment`,
at least one non-empty local-only variable was imported into the hosted service.
The updated API error names those variables without printing their values; the
worker emits a redacted `worker.operator_environment_rejected` event with the names.
The guard deliberately remains enabled.

In the Render service's **Environment** settings, remove every configured variable
whose name starts with `OPERATOR_` or `DEVNET_TEST_`, plus `TEST_MINT_SECRET` and
`TEST_MINT_SECRET_FILE`. Check linked environment groups too; remove the entries
there or unlink an inappropriate local-development group. A string such as `false`
still counts as configured, so delete the entry rather than changing it to false.

For the current local configuration, these names are local-only:

```text
OPERATOR_ADMIN_SECRET_FILE
OPERATOR_DEPLOYMENT_SECRET_FILE
DEVNET_TEST_SENDER_SECRET_FILE
DEVNET_TEST_CLAIM_SECRET_FILE
DEVNET_TEST_RECIPIENT
TEST_MINT_SECRET_FILE
```

`OPERATOR_APPROVED_DEVNET`, if separately configured, is also local-only. The exact
remote list cannot be inferred from the old generic error; inspect variable names
in the dashboard or use the improved error after deploying this update.

Keep runtime `FEE_PAYER_SECRET`, `ATTESTOR_SECRET`, `TREASURY_SECRET` and
`TEST_MINT_AUTHORITY_SECRET` as specified in the environment matrix. Use actual JSON
secret values on Render; local `keys/...` file paths do not exist in a normal checkout.
For JWT signing use the actual PKCS8 PEM in `AUTH_JWT_PRIVATE_KEY` with its stable KID.

Set `APP_ENV=preview`, `OTP_PROVIDER=twilio`, `WHATSAPP_OTP_ENABLED=false` and
`APP_BASE_URL` to the service's actual canonical HTTPS origin. Local mock OTP is
deliberately unavailable on Render. Save and deploy the corrected environment, then
check `/api/health`. With only environment changes, Render's **Save and deploy**
reuses the existing build. Deploy the updated source separately if you want its new
variable-name diagnostics. See [Render environment settings](https://render.com/docs/configure-environment-variables).

The `No open ports detected` line follows the early process exit. The start command
already binds `0.0.0.0` and Render's `PORT`; changing the port does not resolve a
configuration rejection that occurs before Next starts.

## Privy dashboard actions

Current official instructions require requesting access to **Custom authentication**
under **Integrations > Built-in**, then opening **User management > Authentication >
JWT integration**. Configure the **JWKS Endpoint** as
`https://YOUR_ACTUAL_API_HOST/api/auth/jwks` and the **JWT ID Claim** as `sub`.
Choose client-side **Authentication environment** for the documented wallet flow:
the caller obtains `/api/auth/privy-token` and authenticates through the Privy client
SDK. Enable both environments only if you also implement a server-side consumer.
No frontend is added in this milestone; the backend bridge retains that documented
token contract. The live app-settings check found custom JWT authentication disabled.
Source: [Privy JWT setup](https://docs.privy.io/authentication/user-authentication/jwt-based-auth/setup).

The repository signs ES256 tokens with issuer equal to `APP_BASE_URL`, audience equal
to the Privy app ID, subject equal to the authenticated Muuve user UUID, a five-minute
lifetime and the stable KID. Local verification checks these claims and rejects wrong
signatures, issuer, audience, expired tokens and malformed subjects. These diagnostic
tokens never replace the application's database-backed session authorization.
Configure embedded Solana wallet access for your app. Actual wallet linking checks
Privy server records and cannot be completed by posting an arbitrary wallet address.
This repository does not include a frontend or browser wallet-creation flow.

## Twilio actions

Obtain Account SID and a rotated Auth Token from your Twilio account console; create
or select a Verify Service and copy its `VA...` Service SID. Add all three to the API
environment and use `OTP_PROVIDER=twilio`. Keep WhatsApp disabled until configured.
Do not test real delivery until the owner explicitly authorizes a recipient number.
Local mock tests send no SMS and never establish live Twilio delivery evidence.
The supplied credentials were saved only in ignored local configuration. Read-only
Privy privileged API and Twilio Verify service checks passed; no user record was
printed, no wallet was created through Privy, and no SMS was sent. Run
`node --env-file=.env.local --import tsx scripts/provider-readiness.ts` to repeat.
Rotate conversation-disclosed credentials before publishing the service.

## Verification commands

```sh
pnpm check
pnpm test
pnpm test:db
pnpm test:program -- --test-threads=1
pnpm check:render
pnpm build
pnpm test:http
node --env-file=.env.local --import tsx scripts/verify-auth.ts
node scripts/audit-local-secrets.mjs
```

On this checkout the cached Rust registry is `.cache/cargo`, and verified SBF tooling
is `.cache/platform-tools-v1.58`. Use the installed cache without global reconfiguration:

```sh
CARGO_HOME="$PWD/.cache/cargo" SBF_TOOLCHAIN_ROOT="$PWD/.cache/platform-tools-v1.58" \
  node --env-file=.env.local scripts/build-sbf.mjs
CARGO_HOME="$PWD/.cache/cargo" pnpm test:sbf
```

Local, hosted database, devnet and Render verification must be reported separately.
Do not represent a mock fiat payout as a bank transfer or a local test as deployment.
