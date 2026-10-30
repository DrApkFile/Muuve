# Privy client enrollment and hosted payment E2E — preflight

The owner subsequently authorized backend-only continuation without a frontend and
approved the bounded devnet test budget. See the
[backend payment verification report](2026-10-30-backend-payment-verification.md).
The client discovery results below remain unchanged; no substitute browser was built.

## Done

Reviewed the 30 October hosted verification baseline, payment continuation plan,
wallet authentication contract, owner decisions, rollout records and real-Privy
evidence. Inspected the current workspace, API entry point, wallet ownership handler,
workspace packages and dependencies. Searched nearby project sources for a Muuve
browser application and Privy React client integration.

Initial checkout: clean `main`, commit
`cee381f3ec11f7e556f06518bae1ccc9b26c0b43`. This is the local source identity;
the last baseline's owner-confirmed Render build was `294f5e7`. The current hosted
build was not independently checked in this preflight.

**Phase A is blocked by the missing actual browser client.** No application or wallet
integration was implemented, and no live authentication, database, provider, worker
or blockchain operation was executed in this continuation.

### Client discovery evidence

- `apps/web/app` contains only `api/[...path]/route.ts`. It exports GET and POST
  handlers to the backend router. No browser page or layout was found.
- Application code under `apps/web/lib/server` is backend code. There is no client
  wallet connector, Privy browser provider, embedded-wallet enrollment component or
  browser funding/claim signing flow to extend.
- Root dependencies include `@privy-io/node`, but not `@privy-io/react-auth`.
  React and Next dependencies alone do not establish an implemented browser client.
- Workspace configuration includes `apps/*` and `packages/*`; the source inventory
  contains the API application and shared package, with no separate browser package.
- A bounded search under `/home/kingghidorah/Documents/projects`, excluding generated,
  dependency and backup directories, found no matching Muuve browser source. The
  case-insensitive search for `muuve|@privy-io/react-auth` in package manifests,
  JSX/TSX and HTML matched only this repository's two package manifests.
- No Muuve-named candidate appeared in the immediate home, Documents, Desktop or
  Downloads directory entries. This is a bounded discovery result, not proof that
  no client exists elsewhere or remotely.

The old frontend guide's proposed directory tree is a specification, not an existing
client. Node HTTP verifiers and the earlier disposable-SQL Privy verifier are not
browser clients and cannot satisfy browser integration acceptance criteria.

## In progress / blocked stages

| Stage                                               | Result in this continuation                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A: actual client discovery                          | Blocked: no actual client located. Repository path/URL and deployed frontend origin requested.       |
| B: actual hosted identity Privy enrollment          | Not attempted; historical hosted identity exchange 404 remains unresolved, not newly retested.       |
| C: actual browser login and cookie tests            | Not run; browser application and its hosting arrangement are unavailable.                            |
| D: fresh funded batch preparation                   | Not run; no new reservations, link or operation created. Old cancelled preparation remains unusable. |
| E: funding, claims, mock cashout, recall and expiry | Not run; no transaction signed/submitted and no payout initiated.                                    |
| Local worker and hosted reconciliation              | Not run; no global jobs or cron endpoints invoked.                                                   |

Existing backend results remain exactly the historical baseline. No earlier local
Privy identity success is attributed to the hosted identity. No new transaction
signatures, explorer receipts, payout results or hosted database results exist for
this continuation. Automated behavior suites were not rerun because no implementation
changed; formatting/type checks for these documentation artifacts are recorded separately.

## Decisions made

Followed the owner's explicit Phase A stop condition rather than creating a substitute
client or simulating a browser. Only documentation and local evidence were added.
No dependency installation, migration, deployment, key generation, SMS, provider
enrollment, financial preparation, faucet or token transfer was performed. Stayed on
`main`; original verification/failure artifacts and private resumable metadata were
not modified.

The API still enforces the canonical Origin and host-scoped Secure/HttpOnly/SameSite=Lax
cookies. A frontend on a separate origin needs a reviewed hosting/cookie arrangement;
no Origin rewrite, CORS relaxation or hosted configuration change was performed.

The sender's existing external funding wallet must remain associated with its Muuve
identity. The current `/api/auth/wallet` route rejects a different wallet with
`wallet_already_linked` after ownership verification. Sender Privy enrollment must
not be implemented by overwriting that funding wallet. An external-wallet sender
can fund without an embedded wallet. A recipient choosing keep needs that recipient's
own legitimate enrollment and independent matching phone verification.

## Known issues / next step

Required input: **the actual frontend repository's local path or repository URL,
and its deployed browser origin if available**. No credentials are requested.

After access is available, inspect that repository's instructions, current changes,
SDK versions, wallet provider and auth/session implementation. Report exact proposed
files and changes before extending its legitimate custom-JWT enrollment and exact-message
wallet login. Preserve identity ownership and existing backend security boundaries.
Browser verification then precedes the fresh funded run described in
[the payment E2E plan](../hosted-payment-e2e-plan.md). Explicit approval is still
required before signing/submitting token-moving transactions or other gated shared
environment actions. No full payment E2E or production-readiness claim is made.

Related references:

- [Hosted verification baseline](2026-10-30-hosted-wallet-verification.md).
- [Frontend integration contract](../frontend-integration.md).
- [Preflight command and discovery record](../../evidence/privy-client/2026-10-30-preflight.json).
