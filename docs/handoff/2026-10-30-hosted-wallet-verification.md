# Actual hosted wallet verification — 30 October 2026

Later backend-only funding and recall results are recorded in the
[backend payment verification report](2026-10-30-backend-payment-verification.md).
The authentication results below remain the earlier baseline; its no-transaction
statements describe that earlier verification phase.

## Done

**The hosted wallet-only login, sessions, JWT/JWKS and negative authorization cases
passed against Render and the intended migrated Supabase database.** The new hosted
identity's Privy enrollment remains incomplete: real Privy authorization exchange
returned 404 for that identity. Full funded payments and mock cashouts remain untested.

- API: `https://muuve.onrender.com`.
- Deployment/source: main commit `294f5e73a007928888f083902dd3d4c6dcf4e903`
  (`updated migrations and updated the privy`). Local main and remote main match.
  The owner checked Render's Live deployment and confirmed this commit. The API
  does not expose a build SHA; the commit association is dashboard-confirmed rather
  than an independent runtime attestation. No public GitHub Render status was available.
- SQL: Supabase project `yirelxmcveyxcqofzayq`, certificate-verified Session pooler,
  six migrations, including approved migration 006.
- Solana: devnet; current program `147uqUCHmuUgziXH31v352QycgSuxLgZfzN2MYE67Sxe`,
  configured dedicated six-decimal test mint and treasury passed a fresh readiness check.
- Source changes in this verification: a CLI test tool, local evidence and documentation.
  No deployed API code, runtime secrets, program or worker was changed by this agent.
  Work stayed on main. The owner performed the source push and Render deployment.

## Actual hosted authentication results

The verifier uses the existing private devnet test sender only to sign the exact
server-issued UTF-8 login message. It does not construct application session cookies,
insert user/wallet/session records directly, or print private keys or login proofs.
Cookies are obtained from the real HTTPS responses and held in ignored mode-0600
private files. This is a real HTTP/API integration test using a Node client and real
wallet key; browser-extension UI and cross-origin browser behavior are not covered.

| Scenario                                                                              | Actual result                                                                                                                                              |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Healthy API and public JWKS                                                           | HTTP 200; expected devnet/mocked-payout response and public-only key.                                                                                      |
| Anonymous `/api/me`                                                                   | 401.                                                                                                                                                       |
| Challenge issue                                                                       | 200; canonical domain/URI, devnet, exact five-minute lifetime and Secure/HttpOnly/SameSite=Lax cookie.                                                     |
| SQL correlation                                                                       | The challenge row appeared in the intended Supabase project; stored origin, message, wallet and cookie hash matched the HTTPS response.                    |
| Missing challenge cookie                                                              | 401 `invalid_wallet_challenge`.                                                                                                                            |
| Foreign origin                                                                        | 403 `invalid_origin` for challenge issuance and signature submission.                                                                                      |
| Wrong wallet signature                                                                | 401 `invalid_wallet_signature`.                                                                                                                            |
| Changed message signed by the right wallet                                            | 401 `invalid_wallet_signature`.                                                                                                                            |
| Exact message signed by the right wallet                                              | 200; actual account/session created, funding wallet matches and session has no verified phone.                                                             |
| `/api/me` with the real session                                                       | 200, expected user/wallet.                                                                                                                                 |
| Replayed consumed challenge                                                           | 401. Durable attempts were three: two rejected signatures and one successful proof.                                                                        |
| Actual hosted bridge JWT                                                              | Signature verified against hosted JWKS; ES256, issuer, audience, UUID subject, KID and five-minute lifetime matched.                                       |
| Wallet session presented to recipient claim/share and claim-intent routes without OTP | 401; no fabricated claim cookie or phone proof was used. Actual funded-slot membership remains a later payment-flow test.                                  |
| Refresh                                                                               | 200; old cookie returned 401 and replacement returned 200 for the same identity.                                                                           |
| Natural challenge expiry                                                              | Waited beyond the actual five-minute deadline, checked server-side SQL time and submitted its exact valid proof: 401. No challenge deadline was shortened. |
| Logout                                                                                | 200; revoked cookie rejected by `/api/me` and `/api/auth/privy-token` with 401.                                                                            |

The genuine new hosted sender is Muuve user `b913dc4f-fe0e-4cd9-9d53-e3b492ae6b07`,
funding wallet `BrMxuBfhPhXfyzpX8Hpnv1xo6W6nMyomKh8gXt4acT85`. This is distinct from
the prior local Privy test identity. The sender supplied **no phone or OTP**.

### Approved real session-expiry test

A separate account session was created through another actual wallet challenge/login
and accepted by hosted `/api/me`. With explicit owner approval, changed **only** its
`expires_at` to the past using the reviewed SQL and verified exactly one updated row.
The session ID was `0f2cd97f-f01d-4e33-b4f7-9a31121aa008`.

The unchanged cookie still passed cryptographic JWT verification, but Render rejected
both `/api/me` and `/api/auth/privy-token` with 401. This proves the actual hosted
**database session-expiry guard**, independently of token tampering or logout.
Other session rows were verified unchanged within that transaction. Cookie data was
then cleared. This is an approved controlled-expiry fixture, not a naturally elapsed
30-day session and not a fabricated session.

Evidence: `session-expiry-fixture.json`, `expire-test-session-review.sql` and
`session-expiry-verified.json` under `evidence/wallet-hosted/`. The reviewed SQL is an
executed test artifact, not an instruction to expire additional sessions.

## Earlier API error fixes: deployed retests

- **Missing operation:** actual authenticated GET returned JSON 404 `not_found`,
  replacing the previously observed empty 500.
- **Genuine foreign operation:** first prepared a real link operation through the
  hosted API. Its owner received 200. A second actual wallet-authenticated identity
  received JSON 404 for that same existing operation. This is not a nonexistent-ID test.
- **Unowned Privy wallet:** actual hosted `/api/auth/wallet` returned JSON 403
  `wallet_not_owned`, replacing the previous generic 500. Funding-wallet association
  remained unchanged afterward.
- Error responses contained only `error` and `request_id`; tested credentials and raw
  upstream details were absent.
- **Provider outage/transport mapping to 503:** covered by the existing unit regression
  cases, but a genuine hosted provider outage was not induced. No credential, DNS,
  configuration or authorization control was weakened to force that case.

## Real batch preparation and safe cleanup

Prepared a batch through hosted `/api/links/prepare` after checking the existing test
balance. Two fixed allocations, **500000 and 1000000 base units**, were persisted in
order with the intended private recipient phones. Total: 1500000 base units.
This also supplied the genuine operation for the ownership-isolation test above.

- Link: `9887fa84-94f2-4688-8372-507155598cf1`.
- Operation: `a49a616a-0064-4f86-97c9-a0b6909cbdba`.
- Sender signature on the prepared funding transaction was absent and remained absent.
- No submit endpoint, global cron/worker endpoint, payout endpoint, faucet or mint
  operation was called. The verifier rejects financial-submission paths explicitly.
- After actual blockhash expiry, the scoped existing local reconciliation function
  checked real devnet state and marked this unsubmitted creation failed. The link
  became `cancelled`, its capacity reservation `released`. That reconciliation used
  hosted SQL/real RPC **from a local process**, not hosted cron or a running worker.
- Final read found no on-chain account at the test link PDA and no create signature.
  The two slots were never funded and remain pending under the cancelled parent.
  They were not claimed, refunded or presented as settled payments.
- Sender balance remains **2000000 test-token base units**. No new blockchain transaction
  was submitted, and there are no new explorer transaction links to report.

Do not submit or reuse this expired preparation. A funded continuation needs a fresh
sender-local link ID, operation and valid blockhash.

## Privy: verified versus blocked

The existing dedicated Privy test identity and wallet were recognized via real Privy
server records. That wallet is `E8SaZ7LFCppUr4HoBF2cGTWtEfkzftVmnBzRA37C1fue` and
belongs to the earlier **local integration identity**, not the new hosted sender.
Its resumable private metadata was preserved unchanged.

The new hosted sender's real JWT verified locally against the actual hosted JWKS.
However, a genuine Privy SDK authorization exchange with that **host-issued token**
returned **404**. A direct lookup also found no corresponding Privy custom-auth user.
This is recorded as **blocked**, not as successful Privy authentication. No fake
Privy user, cross-identity wallet link or fabricated hosted account was created.
Earlier successful local-identity Privy signatures are not relabeled as this test.

Exact missing client step: authenticate the real hosted Muuve identity with Privy's
custom-JWT client flow and create/select its legitimately owned Solana embedded wallet
where that wallet mode is required. The browser client/connector is outside this
backend repository. It must also implement the allowed-origin challenge flow with
cookies and exact UTF-8 signing; this Node-client test does not prove its UI/CORS behavior.
Do not copy the local fixture UUID into hosted users or attach its wallet to another ID.

An external-wallet sender does not need that embedded wallet to prepare funding: the
actual successful batch preparation demonstrates this. The missing Privy enrollment
remains relevant to the complete embedded-wallet/recipient-keep integration.

## Final data and test evidence

Final read-only checks compared all original users, sessions and OTP rows using the
private keyed fingerprints, excluding newly authenticated test identities:

- Original **3 users, 11 sessions and 8 OTP challenges unchanged**.
- Current totals: 5 users, 15 sessions, 8 OTP challenges.
- **Zero active test sessions**, zero active jobs, zero payouts, zero principals and
  zero funding reservations. Dedicated test/audit rows were retained, not deleted.
- Test create operation failed safely, link cancelled/capacity released, no chain effect.

Actual commands and exit codes are consolidated in `evidence/wallet-hosted/commands.json`.
Key executed commands:

```sh
node --env-file=.env.local --import tsx scripts/verify-hosted-wallet.ts --start --operator-approved-auth-test
node --env-file=.env.local --import tsx scripts/verify-hosted-wallet.ts --prepare-only --operator-approved-auth-test
node --env-file=.env.local --import tsx scripts/verify-hosted-wallet.ts --privy-token-check --operator-approved-auth-test
node --env-file=.env.local --import tsx scripts/verify-hosted-wallet.ts --finish --operator-approved-auth-test
```

Start, preparation and finish exited 0. The real Privy token check exited **1**, with
provider HTTP 404, and remains a failed integration gate. TypeScript/format checks,
secret scans, hosted schema and fresh devnet readiness checks passed. Initial authoring
syntax/type issues in the new CLI were fixed before the live test; no API source
change or additional Render deployment was needed. The earlier fresh **62 unit and
58 DB/API** results remain pre-deployment automated evidence; those suites were not
rerun merely to relabel them as hosted tests.

Main evidence: `start.json`, `prepare-only.json`, `finish.json`, `privy-token-check.json`,
`session-expiry-verified.json`, `final-data-state.json` and `deployment-source.json`.
The CLI keeps progress in ignored `keys/hosted-wallet-test.json`; it refuses duplicate
preparation/start requests. All live cookies have been cleared or revoked/expired.
Never delete the separate resumable Privy metadata to force enrollment to appear passed.

## In progress / next step

The hosted wallet-auth rollout is verified at the API/SQL boundary. The new identity's
Privy enrollment and a real browser consumer remain incomplete. Follow
`docs/hosted-payment-e2e-plan.md` for the gated payment continuation. No funded hosted
claim, fiat cashout, recall/refund or complete payment E2E is claimed. Payouts remain
mocked; no production-readiness claim is made.

## Decisions made

Stayed on main and left deployment to the owner. Used only real hosted wallet proofs,
real issued cookies, real records and unmodified origin/OTP/claim-key controls. Waited
for real challenge and blockhash expiry. Obtained specific approval for the one-session
expiry fixture. Preserved original customer records and kept all keys/phone data private.

## Known issues / limitations

Privy 404 requires legitimate enrollment/client integration. Hosted upstream-outage 503
handling is untested. Browser connector behavior is untested. Full funded payment E2E
requires explicit operator transaction safeguards and actual recipient verification.
The separate existing contract expiry fixture still matures 31 October 2026 at
09:39:30 Lagos; it was not shortened or submitted in this task.

## Client enrollment continuation preflight

The next requested browser/Privy phase inspected local main `cee381f` and nearby
projects but found no actual browser application to extend. It stopped at the owner's
explicit client-availability gate, with no new live tests or financial operations.
The original results above are unchanged. See the
[client preflight report](2026-10-30-privy-client-preflight.md) for discovery scope,
required repository/origin input and the preserved sender funding-wallet boundary.
