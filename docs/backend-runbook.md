# Backend setup, verification and recovery

This is a backend-only Next.js Node application, an Anchor program and a Postgres
schema. No frontend flow is implemented. Rates, bank resolution and fiat payouts
are **mocks**. Twilio and Privy adapters require operator credentials and external
configuration; local tests do not establish live-service delivery or wallet ownership.

Read [binding decisions](backend-decisions.md) before changing money or authorization.

## Local checks

Use Node 24, pnpm 12.15.0, Rust and a compatible C compiler/OpenSSL build environment.
JavaScript and Rust dependencies are locked. Anchor is 0.31.1; local native runtime
tests use Solana 2.3.13. SBF tooling must be compatible with the pinned dependencies.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:db
pnpm test:program -- --test-threads=1
pnpm build
```

`test:db` requires `initdb`, `pg_ctl` and Postgres binaries. It creates a disposable
cluster under `.cache`, applies every migration, runs database/API tests and stops
and deletes only that cluster. It never connects to Supabase or a shared database.
Default `pnpm test` skips suites needing this explicit database harness.
Contract runtime tests use an in-process local validator and synthetic in-memory
signers. Their public fixture program ID is **not** a devnet deployment address.

For the actual SBF artifact, install the pinned compiler into this checkout, build
the explicit test fixture and run every runtime case against that artifact:

```sh
python3 scripts/install-sbf-tools.py
SBF_TOOLCHAIN_ROOT="$PWD/.cache/platform-tools-v1.58" pnpm build:sbf --fixture
pnpm test:sbf
pnpm build:idl
pnpm test:http
```

The installer verifies the official v1.58 SHA-256. SBF builds use its Rust 1.95
compiler and the `sbpf-solana-solana` target directly, so building does not create a
deployment keypair. The build rejects stack-frame diagnostics even if LLVM returns
exit code zero. Artifact/source fingerprints prevent testing a stale binary.
Native tests explicitly ignore the upgradeable-loader bootstrap case because a
native processor cannot impersonate an upgradeable program; `test:sbf` includes it
and uses real bytecode plus ProgramData authority proof. Operator builds omit
`--fixture` and require their assigned public program ID.

## Environment and database

`.env.example` lists configuration names. Inject real values using the deployment
secret manager; do not commit or print them. Solana secret values are JSON arrays
of 64 integer bytes. Authentication JWT private keys use PKCS8 ES256. JWKS exposes
only the corresponding public key. Never expose server secrets through public env.

Use `DATABASE_URL` for a direct server-only Supabase Postgres connection or its
transaction-capable pooler. This replaces the v0.2 guide's HTTP service-role query
approach so multi-statement financial operations use real database transactions.
Tables live in the `muuve` schema; anonymous/client access has no RLS policy.
Use an operator-managed server role with the required schema privileges and RLS
bypass/ownership. A service-role API key alone is not a Postgres connection string.
Require TLS with certificate verification for remote database connections. Local
disposable tests deliberately use loopback trust authentication only.

Apply migrations only to an approved database:

```sh
MUUVE_ALLOW_MIGRATIONS=1 pnpm db:migrate
```

The runner takes a global migration lock, verifies immutable migration checksums,
and commits each schema change together with its version record. Review migrations
before applying them to any shared instance. No application startup auto-migration.

`TRUSTED_PROXY=true` is safe only behind a proxy that overwrites the forwarded IP
header and blocks direct origin access. Otherwise leave it false; rate limits share
the conservative local bucket. Verify this property in hosting configuration.

## Devnet operator sequence

No script silently falls back to mainnet, a mainnet mint, a default program address
or a local wallet file. RPC genesis must match devnet, including fallback endpoints.

1. Provision separate admin, attestor, fee/rent payer, treasury and test-mint authority.
   Decide and record the deployment/upgrade authority. Keep admin/deployment keys
   out of the application environment. Never use real funds.
2. Assign the program public ID. Set `MUUVE_PROGRAM_ID` before building SBF and add
   the matching `[programs.devnet]` entry to `Anchor.toml`. `build.rs` allows a public
   fixture for native tests only and rejects missing IDs for SBF builds.
3. Build/review SBF and generated IDL. The program needs the upgradeable loader's
   canonical ProgramData proof for initialization. An immutable deployment without
   an upgrade authority cannot use this bootstrap path.
4. Human operator deploys **only devnet**, verifies executable program and authority.
5. Set `TOKEN_PROGRAM_ID` to legacy Token or Token-2022. Token-2022 mint extensions
   currently allowed: none. Token-account extensions: ImmutableOwner only.
6. With explicit operator consent, run `OPERATOR_APPROVED_DEVNET=1 pnpm exec tsx
scripts/create-test-mint.ts`. It creates a dedicated six-decimal, nonfreezable
   test mint under the selected token program. Record `USDT_MINT`.
7. Provision fee-payer test SOL through an operator wallet/faucet. `scripts/fund-fee-payer.ts`
   only reports the address/balance; it does not request an airdrop.
8. Run the gated `scripts/create-treasury.ts` to create the treasury ATA. Record its
   public address. This script uses the existing operator treasury key; it does not
   create a wallet.
9. Supply operator-only `OPERATOR_ADMIN_SECRET` and `OPERATOR_DEPLOYMENT_SECRET`, then
   run gated `scripts/init-config.ts`. Both legitimate authorities sign. Verify the
   initialized Config using `pnpm test:devnet`.
10. Remove operator-only keys. Start `pnpm dev` or deploy the API. Use capped funding
    endpoints only after verified wallet linking. Verify token balances and receipts.

Steps that submit transactions are never part of default tests, CI or startup.
No deployment, initialization, minting or devnet funding was authorized implicitly
by running a build or reading this runbook.

`pnpm test:devnet` is read-only readiness verification using public configuration
and the five `*_PUBLIC_KEY` role identities from `.env.example`; it needs no private
keys. Missing configuration names are reported without values. Set `MUUVE_DEVNET_LINK_PDA`
to additionally inspect a known fixture. It does not substitute for operator-run
create/claim/recall/expiry integration evidence. For expiry use an actually aged link;
local clock control is never evidence that 48 real devnet hours have elapsed.

Config has one immutable mint. Devnet verification of both supported token programs
therefore requires two separately configured program deployments and isolated test
databases, one per mint/program combination. Never rotate the mint to manufacture
coverage. Native tests use independent disposable banks for these configurations.

After explicit operator approval/provisioning, `pnpm test:devnet:transactions`
exercises real create, independent wallet/treasury claims and recall. It requires
both `MUUVE_RUN_DEVNET_TRANSACTIONS=1` and `OPERATOR_APPROVED_DEVNET=1`, explicit
`DEVNET_TEST_SENDER_SECRET`, `DEVNET_TEST_CLAIM_SECRET`, `DEVNET_TEST_RECIPIENT`,
the backend runtime configuration and at least seven pre-funded test tokens. It
never requests funds or creates wallets. Supply a genuinely aged
`MUUVE_DEVNET_EXPIRED_LINK_PDA` for expiry; without it the resulting evidence is
marked incomplete. Signatures are recorded before broadcast, and ambiguous results
require reconciliation rather than blindly rerunning. Results are written only
when this gated runner is actually invoked; no devnet evidence is pre-populated.

## HTTP interface

All browser mutation routes require exact `Origin=APP_BASE_URL` and JSON schemas.
Account/claim/proof cookies are HttpOnly, Secure, SameSite=Lax and server-revocable.
Account sessions last 30 days, claim sessions 20 minutes, signup proof 15 minutes.
OTP verification returns an opaque challenge ID; purpose/phone/link come from its
durable record, never a second client identity assertion. Mock OTP works only with
`APP_ENV=local` and `SOLANA_CLUSTER=devnet`. SMS/WhatsApp share rate limits.

Existing documented route groups are implemented under the backend catch-all route:
auth, me, balance, funding, sender links/recall, public preview, claims, banks, payouts,
webhooks and cron. Sender-local `link_id_hex` is for create requests only. All path
`:id` values and claim OTP `link_id` values are global opaque database UUIDs, avoiding
ambiguous lookups across senders. A bare local link ID never resolves a public claim.

Claim sequence:

1. Phone verification establishes the claim session for one opaque link UUID.
2. `GET /api/claims/:id/share` reveals only that phone's slot.
3. `POST /api/claims/:id/intent/prepare {path:"keep"|"cashout"}` returns an operation
   and transaction. Keep requires an account on the same phone and a verified wallet.
4. Add only the claim-key signature; submit to `/intent/submit` and wait for the
   confirmed/finalized on-chain intent. A prepared HTTP response grants no priority.
5. Prepare the final keep/cash-out transaction, add the claim-key signature and submit.
   Cash-out also requires a valid server quote and re-resolved bank destination.

Every prepare returns `operation_id`, serialized `tx`, signature and blockhash
lifetime. Submit bodies contain `{operation_id,tx,idempotency_key}`. Repeat the same
operation/key after network failures. Do not rebuild messages on the client.
`GET /api/operations/:id` returns the authorized caller's durable operation state
and latest prepared transaction. Account sessions can be renewed explicitly through
`POST /api/auth/refresh` before expiration; refresh revokes the previous session.
Quote expiry limits acceptance at prepare. Once accepted, its fixed rate/amount is
preserved through confirmation and payout rather than silently repriced.
Funding uses an `Idempotency-Key` header and `{amount_base_units}`; a verified sender
wallet is always the mint destination. Funding capacity is reserved before submission.

Recipient priority is 120 seconds from the first landed intent, capped at expiry
and never renewed. Only a landed intent can block recall. After that bounded window,
a funded slot remains claimable before expiry but competes with recall normally.
Claims and recalls both fail at the exact link deadline; expiry can then refund.

## Confirmation and recovery

Submitted, confirmed, finalized and payout states are distinct. **Only finalized
successful execution dispatches fiat.** A signature is known and stored at prepare
because the fee payer signs first; direct client RPC submission is reconcilable.

On timeout, immediately construct and persist a replacement with a fresh blockhash
and original-operation relationship. All emitted principal-moving instructions have
slot/PDA state guards or an immutable OperationReceipt. A second successful release
of the same principal is therefore rejected on-chain. Replacement preparation does
not release outstanding/funding capacity. An unrecognized legacy transfer is held;
never infer failure solely from an RPC timeout or resend an uncontrolled transfer.

Persist and inspect every original/replacement signature. Finalized state wins over
timeouts. Unknown outcomes retain reservations. If account effects exist but RPC
history cannot identify a finalized signature, keep the operation unknown and use
another verified history-capable devnet RPC; do not fabricate transaction attribution.

Payouts use one logical principal and stable provider idempotency identity. Immediately
retry a timed-out provider with the same key. A provider without safe deduplication
or authoritative status lookup requires quarantine/manual reconciliation. Never use
a new provider key merely because the previous call timed out.

Mock provider results are durable, scheduled after four seconds and delivered through
the same authenticated inbox path. Accounts ending `0000` fail. There is no real NGN
bank transfer. Webhooks require `x-muuve-timestamp` and HMAC-SHA256
`x-muuve-signature` over `${timestamp}.${rawBody}`, with a five-minute replay window
and permanent event-ID deduplication. This is the mock protocol, not a claimed
implementation of a real provider's webhook scheme.

Retry, keep and sender refund lock the same principal. Wallet payout failure returns
to the original wallet. Escrow cash-out failure permits retry/keep; after 48 hours
without action, refund only the original sender. If a retry is processing, no old
failure timer may refund its principal. Contradictory late events quarantine funds
and require investigation; do not reverse a completed payout automatically.

Rotation: Links snapshot attestor/treasury. `ATTESTOR_KEYRING` and `TREASURY_KEYRING`
are optional secret JSON arrays of historical 64-byte keys. Keep them until all old
links and treasury resolutions are terminal. Principal records retain their actual
treasury origin. Missing historical keys fail closed; do not pay an old liability
from an unrelated new treasury by silently substituting destinations.

## Scheduled work and monitoring

Use authenticated **POST** cron calls with `Authorization: Bearer <CRON_SECRET>`:

| Route                      | Suggested interval                             | Responsibility                                   |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| `/api/cron/expire`         | 5 minutes                                      | Refund expired funded slots on-chain             |
| `/api/cron/failed-payouts` | 15 minutes                                     | Due treasury resolutions                         |
| `/api/cron/reconcile`      | 5 minutes                                      | Every durable chain operation plus queued work   |
| `/api/cron/work`           | 1–5 seconds in a worker, or frequently in demo | Provider dispatch/results and outbox retries     |
| `/api/cron/monitor`        | 1–5 minutes                                    | Backlog/treasury/fee metrics and redacted alerts |

Use an external scheduler able to POST with secret headers. Job leases use database
locking/SKIP LOCKED and recover abandoned workers. Verify scheduler frequency for
the hosting plan. Refund execution is eventual after the on-chain deadline; stopping
the scheduler does not extend eligibility. Do not promise a four-second payout if
the only worker trigger is a five-minute cron.

Alert on unknown operations, quarantined principals/jobs, processing payout age,
overdue expiry, unprocessed inbox rows, job lease age, missing historical keys,
treasury liabilities exceeding spendable test tokens, and fee payer below 1 test SOL.
`/api/health` is liveness, not a claim of provider or chain readiness.
Logs are allowlisted identifiers/states only. Never attach raw request bodies,
provider payloads, cookies, transaction blobs, keys, OTPs, phones or bank details.
Restrict DB access and retention of phone/bank/IP records. Production encryption and
HMAC phone lookup remain outside this devnet milestone.

## External acceptance gates

Owner must supply a devnet program ID/deployment, separate funded keys, verified
test mint/Config/treasury and a usable RPC to demonstrate actual devnet transactions.
Twilio Verify service/approved channels and Privy custom-auth setup are separate
external gates. Real payout adapters, mainnet and real-money activity are not enabled.
The repository-required human security review is not replaced by automated tests.
