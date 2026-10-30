# Wallet-only login and live Privy verification — 30 October 2026

## Done

**Privy now accepts Muuve's JWT and signs valid Solana messages/transactions.**
Wallet-only sender login is implemented and tested locally. Migration 006 is now
verified on hosted Supabase after owner approval; the API source still awaits the
owner's push/deployment. The full hosted payment lifecycle remains incomplete. All timestamps in raw evidence are UTC (29 October late evening);
this report uses the owner's Lagos date, 30 October.

Work is on `main`, based on `81d9992`. The temporary feature branch was deleted at
the owner's request; all uncommitted changes were preserved. Existing uncommitted owner and
prior deployment changes were preserved. The initial implementation performed no commit, push, Render deployment, shared
SQL migration or Solana program change. The later approved migration is recorded
in the follow-up below.

### Backend implementation

- `apps/web/lib/server/wallet-auth.ts`: durable five-minute Ed25519 login challenges,
  origin/devnet binding, separate hashed browser cookie, positive signature proof,
  issuance/attempt limits, atomic consumption/user/session/audit creation and replay
  protection under concurrent requests.
- `apps/web/lib/server/router.ts`: `POST /api/auth/wallet/challenge` and
  `POST /api/auth/wallet/login`, preserving exact-Origin checks and existing errors.
- `apps/web/lib/server/auth.ts`: wallet-only account sessions carry a null phone;
  phone proof/claim sessions retain required phones. Refresh/logout still work and
  logout clears the challenge cookie.
- `apps/web/lib/server/claims.ts`: explicit non-null phone requirement for claim
  authorization. A wallet login cannot authorize recipient claims by itself.
- `apps/web/lib/server/links.ts`: self-payment detection uses the authoritative stored
  user phone, including when that existing account logged in through its wallet.
- `packages/shared/src/index.ts`: strict challenge/login request schemas.
- `supabase/migrations/006_wallet_login.sql`: nullable phones only where wallet-only
  identity is valid, mandatory phones for phone users/recipient proofs, and new indexed
  private challenge table with RLS/PUBLIC restrictions. Applied to disposable local
  test clusters only; historical migration files are unchanged.

Tests/tooling/docs:

- `tests/api/wallet-auth.test.ts`: 15 new API/real-Postgres cases, including tampering,
  replay/concurrency, cookie binding, expiry, attempts, limits, phone-privilege isolation,
  refresh/logout, self-payment and wallet-source quote compatibility.
- `tests/unit/wallet-auth.test.ts`: 6 crypto cases covering exact UTF-8 bytes, wrong
  signer, malformed signatures and a trivial low-order identity forgery.
- `tests/helpers.ts`: test reset includes the challenge table; nullable account phones
  are selected with SQL null-safe equality. Destructive tests remain loopback-only.
- `tests/db/worker.test.ts`: separates bounded process readiness from the unchanged
  queue-progress deadline after one intermediate timing failure. Business assertions
  and shutdown checks remain mandatory; worker production code was not changed here.
- `scripts/verify-privy-live.mjs` / `.ts`: explicitly opted-in live provider test,
  disposable SQL, stable resumable test identity, real JWKS/Privy records/signatures,
  controlled negative authorization tests and no transaction broadcast.
- `docs/backend-decisions.md`, `docs/wallet-authentication.md`, `wallets.md`: owner
  requirement, API/security/rollout contract and public test wallet details.

### Actual verification results

| Command                                                  | Observed result                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                              | **62 passed**, 58 DB/API cases skipped here and executed below.                                                                 |
| `pnpm test:db`                                           | **58 passed** in the final run; migrations 001–006 applied to a disposable local cluster, then cluster stopped/deleted.         |
| `pnpm check`                                             | TypeScript + repository Prettier passed in the final run.                                                                       |
| `pnpm build`                                             | Production Next API build passed.                                                                                               |
| `node --env-file=.env.local scripts/smoke-api.mjs`       | Local production HTTP health/JWKS/unauthorized-route smoke passed. This does not exercise positive new wallet routes on Render. |
| `pnpm check:render`                                      | Blueprint schema, service commands and secret separation passed.                                                                |
| `node scripts/audit-local-secrets.mjs`                   | Source/evidence/build-artifact secret scan passed.                                                                              |
| `node scripts/verify-privy-live.mjs --operator-approved` | Final run passed all **7 live/local boundary checks** described below.                                                          |
| `git diff --check`                                       | Passed.                                                                                                                         |

Exact wrapped commands, exit codes, durations and logs are in
`evidence/render-devnet/wallet-auth-*` and `wallet-privy-*`; the consolidated inventory
is `evidence/privy-wallet/commands.json`. Rust/SBF source was unchanged and those suites
were not rerun for this auth-only change. Their earlier results remain historical,
not newly attributed to this task.

One intermediate DB run passed 57 cases and hit the worker subprocess's old ten-second
startup-plus-progress deadline. After separating explicit startup readiness from job
processing, the full suite passed 58/58. Early local editing/type/format errors were
fixed before final checks; no failed command is relabeled as successful.

### Real Privy results

The verifier performed actual wallet login against the new **local handler and real
local PostgreSQL**, using the existing dedicated devnet test sender's private key.
A stable pre-existing local account fixture allowed retries to reuse one dedicated
Privy identity; no valid application session was fabricated. It then obtained the
Muuve bridge JWT through the authenticated API handler.

The JWT verified against the **real hosted Render JWKS**, with the expected issuer,
audience, UUID subject and KID. Actual Privy operations then proved:

1. Custom ID, embedded Solana wallet and server records agree. Its owner quorum has
   exactly the test user, threshold one, no authorization keys/nested quorums and no
   additional wallet signers. An arbitrary funding wallet fails embedded-wallet ownership.
2. Muuve's JWT authorizes a message signature, which verifies against the actual wallet.
3. The app secret alone, without user authorization, cannot sign that wallet.
4. An expired Muuve JWT is rejected by Privy.
5. A zero-lamport self-transfer transaction using a recent blockhash from verified
   Solana devnet is signed without message mutation, and its signature verifies.

**Nothing was broadcast. No SOL/test tokens were requested, minted or moved, and no
wallet private key was exported.** SDK authorization keys were used only in memory.
No live SMS or real fiat provider was used.

Dedicated Privy test wallet:

```text
E8SaZ7LFCppUr4HoBF2cGTWtEfkzftVmnBzRA37C1fue
```

It does not replace the funding sender, fee payer or treasury, and no funds were sent
to it here. Its balance was not checked. It belongs to an isolated local integration
identity, not a hosted customer. Public details are in `wallets.md`; resumable metadata
is in ignored mode-0600 `keys/privy-live-test.json`. Do not delete that file to retry.

### Failures found and corrected

- The first verifier incorrectly compared a Privy wallet's `owner_id` to the user's
  DID. `owner_id` identifies a quorum. A fresh read confirmed a one-user, threshold-one
  quorum with no extra signing keys; the verifier now checks that structure explicitly.
  This corrected the test's model without changing wallet ownership or adding a signer.
- With only **Client-side** JWT integration configured, real server-side signing
  returned HTTP 401 even though hosted JWKS verification passed. The owner then added
  **Server-side** using the same JWKS URL and ID claim `sub`. The same identity/wallet
  passed the full signing test afterward. No dashboard change was made by this agent.
- The initial failure artifacts remain in `evidence/privy-wallet/` and command logs;
  successful reruns did not erase that evidence.

Final proof: `evidence/privy-wallet/live-verification.json`. The two earlier failures
are saved separately as `initial-verifier-owner-assumption.json` and
`before-server-configuration.json`.

## In progress / hosted rollout

Initial read-only probes found **404** for the new hosted wallet challenge route
and only migrations 001–005. The later approved migration 006 is now verified;
the owner's source deployment remains pending. Those initial results are preserved
in the original evidence files.

Required rollout:

1. Review the auth/session/migration diff and approve migration 006 on the shared
   development Supabase database. The repository's agent practices require human
   approval for shared migrations; the change has been made concrete and tested.
2. Apply the existing guarded migration command in `docs/wallet-authentication.md`,
   then verify six migration records, the new table, constraints, RLS and permissions.
   No reset, truncate or customer-row rewrite is required.
3. Publish the reviewed source to the deployment branch and deploy it to the existing
   Render API service. No new environment secrets or dependencies are required for
   wallet login, and the existing local worker stays local.
4. Exercise actual hosted wallet challenge/login with the dedicated test sender,
   verify its cookie/JWT, then resume hosted fixed-allocation batch funding, eligible
   recipient OTP, wallet claim, treasury mock cashout, reconciliation and duplicate cases.

A Privy-side signing success does not prove that those hosted payment operations ran.
The existing real expiry fixture still matures 31 October 2026 at 09:39:30 Lagos; its
48-hour deadline was not changed. Real NGN payouts remain outside scope and mocked.

## Decisions made

Kept wallet-only sender identity separate from verified recipient-phone authority.
Preserved original funding-wallet identity and sender-only refund destinations; a
separate Privy test wallet never silently changes an account's funding wallet.
Kept all Origin, OTP, slot/claim-key, attestor, treasury, idempotency and devnet guards.
No frontend, wallet-signing proxy, server authorization key or mainnet path was added.
The owner-approved clarification is recorded in `docs/backend-decisions.md`.

## Known issues / next step

The local wallet backend and actual Privy signing gate pass. Shared migration 006
is now verified. The owner's source push/Render deployment and actual hosted wallet
tests remain pending; the hosted full-payment E2E objective is still incomplete. The browser wallet connector/consumer is not included
in this backend-only repository; clients must use the documented sign-message API.
Human security review remains required before real payments.

## Hosted migration follow-up — owner approved

Migration 006 has now been applied to the intended hosted development Supabase
project after explicit owner approval. All six migration records, table constraints,
indexes, RLS/PUBLIC restrictions and unchanged existing-record fingerprints were
verified. Work remains on main. The owner can now commit/push the API source; Render
deployment and hosted wallet authentication tests are still pending. See
[the rollout handoff](2026-10-30-wallet-rollout.md) and `evidence/wallet-rollout/after.json`.

## Hosted API verification follow-up

The owner deployed commit `294f5e73a007928888f083902dd3d4c6dcf4e903`; the new
wallet-only flow is now verified against the actual hosted API and Supabase, including
negative authorization, refresh/logout, natural challenge expiry and an approved
real test-session expiry. New-hosted-identity Privy enrollment still returns 404;
funded hosted payments remain untested. See
[actual hosted evidence](2026-10-30-hosted-wallet-verification.md) and
[the payment continuation plan](../hosted-payment-e2e-plan.md).
