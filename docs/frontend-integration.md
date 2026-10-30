# Frontend integration — current backend handoff

Latest local implementation: [Textbee and four-minute demo setup](textbee-and-demo-expiry.md).
Textbee has been added as an SMS provider; verify its deployment before assuming
the hosted API uses it. Demo expiry needs a separate reviewed contract upgrade and
Config change. Always display the link's returned `expires_at`; existing funded
links retain their original 48-hour deadline. Account OTP success alone never grants
recipient claim authorization. The hosted payment reports below remain the evidence
for completed funding, recall and pending claim/payout stages.

Updated 30 October 2026. This guide describes what the frontend can integrate now,
what exists for later integration, and which hosted flows have actually been tested.
It does not authorize real payments or claim that the full payment lifecycle works.

## Current target and evidence

- Hosted API: `https://muuve.onrender.com`.
- Owner-confirmed Render deployment: commit `294f5e7` on `main`.
- Chain: Solana devnet only. The configured six-decimal token is a test token.
- Database: the existing hosted Supabase project, with migrations 001–006 applied.
- Payouts, rates, bank resolution and Cleva are mocks. No real NGN transfer is available.
- The worker stays local. Job progress depends on an operator running it against the
  same hosted database; the frontend must not start it or call cron endpoints.

The [hosted verification report](handoff/2026-10-30-hosted-wallet-verification.md)
contains the actual results. The older [frontend guide](muuve-frontend-guide.md)
describes intended screens and includes outdated phone-only sender login and Vercel
assumptions. Use this guide for current integration readiness, the
[wallet authentication contract](wallet-authentication.md) for login details, and
[shared schemas](../packages/shared/src/index.ts) for request validation and enums.
Do not assume the frontend files listed in the older guide already exist.

| Area                                                 | Current evidence                                                                        | Frontend action now                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Health and public JWKS                               | Actual hosted 200 responses verified                                                    | Connect service status; use JWKS for the auth integration where required.                               |
| External-wallet sender login                         | Actual hosted challenge, signature and session flow passed                              | Integrate wallet connection and exact-message signing. Sender needs no phone or OTP.                    |
| Session restore, refresh and logout                  | Actual hosted flow passed                                                               | Integrate account state and session-expiry handling.                                                    |
| Balance                                              | Actual hosted devnet balance read passed                                                | Display test-token balance; label NGN estimates as mocked.                                              |
| Sender activity/detail and public preview            | Routes exist; this phase did not verify a complete funded hosted dataset                | Wire reads and empty/error states; validate funded data during the next E2E run.                        |
| Batch creation preparation                           | Actual hosted two-slot preparation and SQL allocations verified                         | Integrate validation and explicit review/preparation in devnet testing. Preparation reserves capacity.  |
| Funding submission and recipient claims              | Source and automated tests exist; complete hosted funded flow remains unverified        | Implement against the contract behind a test/release gate; do not advertise a working payment flow yet. |
| Recipient phone verification                         | OTP routes exist; hosted uses Twilio                                                    | Integrate SMS forms, subject to authorized live testing. Do not use mock OTP on Render.                 |
| Privy embedded-wallet enrollment                     | Hosted JWT/JWKS passed; new hosted identity's Privy authorization exchange returned 404 | Complete legitimate client enrollment and verify identity ownership before enabling this path.          |
| Cashout, recall, expiry/refund and worker settlement | Implemented paths; complete hosted lifecycle remains unverified                         | Keep gated until the planned hosted payment tests pass. Cashout remains simulated.                      |

Later [backend-only verification](handoff/2026-10-30-backend-payment-verification.md)
proved hosted funding, funding replay protection and sender recall. Recipient claims
and mock cashouts remain blocked by Twilio verification. The table above describes
the earlier authentication baseline; use that newer report for payment evidence.

## Browser origin and cookie prerequisite

**Resolve the hosting arrangement before testing browser login.** All ordinary API
mutations require `Origin` to equal the backend's canonical `APP_BASE_URL`, currently
`https://muuve.onrender.com`, exactly. Authentication uses Secure, HttpOnly,
SameSite=Lax cookies with `Path=/` and no `Domain` attribute. Cookies are host-scoped.
The current router does not implement a general cross-origin CORS/OPTIONS flow.

A frontend running at a different localhost, preview, Vercel or custom-domain origin
cannot simply fetch this API and expect login to work. `credentials: "include"`
alone does not solve origin checks, CORS or cross-site cookie restrictions. Browser
JavaScript cannot choose an arbitrary `Origin` header.

The frontend must use a reviewed same-origin arrangement, or coordinate a separate
backend origin/cookie/CORS design. Any proxy must deliberately preserve the security
boundary and cookie behavior; rewriting Origin alone is not a complete design.
Do not disable origin checks, loosen cookies, or change hosted `APP_BASE_URL` merely
to bypass this prerequisite. Canonical URL changes also affect login messages and JWT
issuer verification. No browser deployment arrangement was verified by the Node-based
hosted tests.

Once that prerequisite is satisfied, use relative `/api/...` URLs with
`credentials: "include"`, JSON request bodies for POST, and `cache: "no-store"`
for session-sensitive reads. Let the browser send cookies and Origin. Never read or
copy HttpOnly cookies into application storage or an Authorization header.

## Integrate sender wallet login first

An external-wallet sender connects the wallet from which they will fund payments.
Connecting alone does not authenticate them; the server-issued message proof does.

1. Read the selected wallet's Solana public address. Require Ed25519 message-signing
   support; there is no wallet-login fallback that accepts an address alone.
2. Call `POST /api/auth/wallet/challenge`:

   ```json
   { "wallet_address": "<selected Solana public address>" }
   ```

   Response: `{ challenge_id, message, expires_at }`. The response also sets the
   HttpOnly challenge cookie. Retain the response in memory for this login attempt.

3. Ask the selected wallet to sign **exactly** `new TextEncoder().encode(message)`.
   Do not trim, rebuild, prefix, JSON-encode or otherwise change the returned message.
   This is a login proof, not a transaction or permission to move tokens.
4. Base58-encode the raw 64-byte signature returned by the wallet adapter. Some
   adapters wrap those bytes in a result object; extract the actual signature first.
   Do not send base64, hex or the whole adapter result.
5. Call `POST /api/auth/wallet/login` from the same browser cookie context:

   ```json
   {
     "challenge_id": "<UUID from challenge response>",
     "signature": "<base58 signature>"
   }
   ```

   Response: `{ user }`. The server sets the account cookie. Do not send a phone,
   message, user ID or alternative wallet in this request; schemas reject extra keys.

6. Use `GET /api/me` to restore or confirm account state.

The public user shape is `{ id, display_name, auth_origin, wallet_address }`.
New wallet-only users currently have display name `Wallet sender` and auth origin
`wallet`. `/api/me` does not expose a verified-phone flag. Do not infer recipient
phone verification from this response, a wallet association, or successful login.

Challenges last five minutes and are single-use. Request a fresh one after expiry,
wallet change or exhausted verification attempts. Disable duplicate login buttons
while a request is pending. Issuance allows three challenges per wallet per ten minutes
and twenty per IP per hour; five failed proofs exhaust a challenge. Do not auto-create
new challenges in a render loop or automatically retry wallet signing after rejection.

If the user changes connected wallets, clear the frontend's cached account data and
complete logout/new login before acting as the new wallet. Existing sessions do not
change identity when a wallet connector changes its selected account.

### Session lifecycle

| Request                     | Body             | Behavior                                                                                                                     |
| --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/me`               | None             | `{ user }`; 401 means no usable account session.                                                                             |
| `POST /api/auth/refresh`    | No body required | `{ refreshed: true }`; rotates the cookie and revokes the previous session. Requires a still-valid account session.          |
| `POST /api/auth/logout`     | No body required | `{ logged_out: true }`; clears account, claim, phone-proof and challenge cookies. Clear frontend account/payment caches too. |
| `GET /api/auth/privy-token` | None             | `{ token }`; short-lived Privy bridge token, not a replacement for the API account cookie.                                   |

Account sessions last up to 30 days, but revocation and database expiry are checked
on every authenticated request. On 401, clear stale account state and offer login;
an expired session cannot be recovered by repeatedly calling refresh. Serialize
refresh requests to avoid unnecessary concurrent session rotation.

## Read APIs and sender preparation

| Request                              | Authentication                   | Response/use                                                                                                                                                         |
| ------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                    | Public                           | `{ service: "muuve-backend", chain: "devnet", payouts: "mock" }`. This alone is not a database or settlement check.                                                  |
| `GET /api/balance`                   | Account                          | `{ amount_base_units, estimated_ngn_kobo, rate_ngn_per_usd, mock_rate: true }`. Requires a linked funding wallet.                                                    |
| `GET /api/links`                     | Account                          | `{ links }`, newest first, at most 100. Rows include ID, kind, total, status, expiry, claimed-slot count and slot count. No pagination contract exists.              |
| `GET /api/links/{id}`                | Owning sender account            | `{ link }`, including own slots and timeline. Recipient phone data here is sender-only; never reuse this response for recipient views.                               |
| `GET /api/public/links/{id}`         | Public, rate-limited             | Preview: kind, sender first name, note, status and expiry; amount only for a single-slot link. No batch recipient list or count. Pending/cancelled links return 404. |
| `GET /api/operations/{operation_id}` | Authorized account/claim session | Latest prepared transaction/lifetime/signature plus operation `state`. Missing and foreign operations return 404.                                                    |

For `POST /api/links/prepare`, use the owning sender session and the shared
`schemas.create` contract:

```json
{
  "link_id_hex": "<32 lowercase hex characters: fresh random 16-byte sender-local ID>",
  "claim_pubkey": "<public key of the client-held claim signing key>",
  "note": "Optional shared note, at most 120 characters",
  "recipients": [
    {
      "phone_e164": "<valid normalized E.164 recipient number>",
      "amount_base_units": "500000",
      "label": "Optional sender label, at most 40 characters"
    },
    {
      "phone_e164": "<different valid E.164 recipient number>",
      "amount_base_units": "1000000"
    }
  ]
}
```

This illustrative payload needs real validated public keys, IDs and authorized test
numbers before use. Support 1–10 unique recipient phones and fixed positive allocations.
Use integer decimal strings/BigInt throughout: `1000000` base units equals one test
dollar. Never use floating-point arithmetic for allocation totals. Shared limits and
server/on-chain checks apply; do not assume client validation establishes eligibility
or available balance. Fixed allocations must survive independent claims unchanged.

Response: `{ link, operation_id, tx, signature, blockhash, last_valid_block_height }`;
an existing preparation may also include `state`. `tx` is base64 serialized Solana
transaction data. The API link UUID (`link.id`) is used in HTTP paths; it is different
from `link_id_hex`, which is unique per sender. Do not derive URLs from the latter.

Preparation is a durable write and reserves outstanding capacity. Call it only after
explicit review, keep the operation ID, and reuse the same link ID and identical input
for a retry. Changing input under that ID returns a conflict. Do not call preparation
on page mount, create new IDs on every timeout, or assume closing a dialog cancels it.
There is no exposed cancel-preparation endpoint. Expired preparations need reconciliation.

### Transaction integration contract — gated pending hosted funded verification

For future approved devnet submission, deserialize the exact returned transaction,
add only the required client signature(s), preserve server signatures and serialize it
back to base64. Do not change blockhash, instructions, amounts, account order or
destinations. The server verifies the submitted message against its stored preparation.
Login signing and transaction signing are separate wallet actions.

`POST /api/links/submit` accepts exactly:

```json
{
  "operation_id": "<prepared UUID>",
  "tx": "<base64 exact transaction with required signatures>",
  "idempotency_key": "<stable 8–128 character key for this submission>"
}
```

Keep the logical operation/idempotency identity on retries. Poll the existing operation
with bounded backoff; HTTP 200, a prepared `signature`, `submitted`, `confirmed`,
`unknown`, `held` or `awaiting_rpc` is not final settlement. `finalized` and `failed`
are terminal operation states. Link, slot and payout status must still be read for
their own lifecycle. On uncertain outcomes, reconcile the existing operation rather
than blindly signing/broadcasting another payment. Use only server-managed replacement
messages after their state permits submission; do not refresh the blockhash yourself.

Do not present a link as funded/shareable merely because preparation succeeded.
Use the actual confirmed application state and server-provided expiry. Do not invent
a 48-hour countdown from browser preparation time. The funded hosted continuation is
specified in [the payment E2E plan](hosted-payment-e2e-plan.md).

## Recipient flow to wire behind the verification gate

The recipient enters the number assigned by the sender, proves ownership by OTP, then
chooses cashout or keep. **Cashout requires neither a wallet nor a Muuve account.**
Sender wallet login is never recipient phone proof. Batch membership is determined
by the backend after verification, not by a client-submitted slot index.

1. Load only `/api/public/links/{id}` for the preview. Keep recipient-facing copy free
   of crypto terminology. Do not show other recipients or batch totals/counts.
2. Read the claim secret from the `#k=` URL fragment into memory, then remove the
   fragment with `history.replaceState`. Follow the project's claim-key format; the
   browser fragment is not automatically sent to the backend. Never send private claim
   key bytes in JSON, query strings, headers, logs, analytics or error reports. Only
   the public key and appropriate transaction signatures leave the client. Do not
   persist claim secrets in localStorage. Removing the fragment means a reload needs
   the original secure link again unless a separately reviewed design handles recovery.
3. `POST /api/auth/otp/send` with
   `{ phone_e164, channel: "sms", purpose: "claim", link_id: "<API UUID>" }`.
   Response: `{ sent: true, channel, challenge_id }`. This does not establish membership.
4. `POST /api/auth/otp/verify` with `{ challenge_id, code: "<six-digit string>" }`.
   Successful claim verification returns `{ verified: true }` and sets a claim cookie.
   Claim sessions last 20 minutes and are bound to the verified phone and exact link.
5. `GET /api/claims/{id}/share` returns only the eligible slot:
   `{ slot_index, amount_base_units, status, payout, priority_until }`. A verified
   phone with no eligible slot receives `not_on_payment`; do not determine membership
   or reveal it before verification.
6. For claim priority, use `POST /api/claims/{id}/intent/prepare` with
   `{ path: "keep" }` or `{ path: "cashout" }`, then `/intent/submit` with the normal
   operation submission body. The client-held claim key signs the exact prepared
   transaction. Clicking a button or preparing an intent does not establish on-chain
   priority. Priority is bounded and cannot extend the link deadline.
7. Keep uses `/keep/prepare` and `/keep/submit`. It requires the matching verified-phone
   account session as well as the claim session and a legitimately associated wallet.
   Cashout uses `/cashout/quote`, `/cashout/prepare`, `/cashout/submit` and, when
   eligible, `/cashout/retry`. Follow shared schemas and server responses; do not invent
   a destination, eligible slot, quote, retry identity or principal state.

For phone-account creation, account OTP uses `purpose: "account"` without `link_id`.
Verify returns either `{ user }` or `{ needs_signup: true }`. Signup uses
`POST /api/auth/signup` with `{ display_name, origin: "muuve" }` and an existing
phone-proof/claim cookie. It is not a phone-verification bypass. Existing users may
receive an account cookie during claim OTP verification. A wallet-only session has
no verified phone even if its account previously had phone authentication; it cannot
substitute for this recipient step. Automatic wallet/phone account merging is not
implemented.

Use SMS while WhatsApp is disabled. OTP lifetime is ten minutes with at most five
verification attempts; issuance limits are three per number per ten minutes, ten per
day, and twenty per IP per hour. Do not auto-send messages on page mount or retry
delivery indefinitely. Render uses the configured real provider; local mock codes
must never be offered or accepted as the hosted flow.

## Privy boundary and mock payout presentation

The API's five-minute ES256 bridge JWT has issuer `https://muuve.onrender.com`,
audience equal to the configured public Privy application ID, and subject equal to
the authenticated Muuve UUID. Public keys are at `/api/auth/jwks`. Keep bridge tokens
in memory and fetch a fresh one when required; never log or persist them.

JWT signature verification passed against the hosted JWKS. **The newly authenticated
hosted identity still has no corresponding enrolled Privy custom-auth user; its real
Privy authorization exchange returned 404.** Client integration must complete the
legitimate custom-JWT login/enrollment for that identity, create/select its own
Solana embedded wallet where required, then call `POST /api/auth/wallet` with
`{ wallet_address }`. The server verifies ownership through Privy records. This route
is not the external-wallet login route and cannot attach an arbitrary address.
Do not reuse another user's test UUID/wallet or fake enrollment. The external-wallet
sender can use wallet login without this embedded-wallet path.

`GET /api/banks` returns `{ banks, mock: true }`; `POST /api/banks/resolve` accepts
`{ bank_code, account_number }` and returns `{ account_name, mock: true }`. Both
require an account or claim session. These are **simulated bank data**, not real
account resolution. `GET /api/payouts/{id}` returns `{ payout }` for an authorized
actor. All payout progress depends on durable operation state and worker processing.

Use `slotStatuses` and `payoutStatuses` from the shared package, including payout
`quarantined`. A quarantined/ambiguous outcome needs reconciliation, not another
cashout request. A simulated `paid` result must be labelled as a mock payout, never
as an actual NGN bank receipt. Do not mark a whole batch complete while another slot
or payout is unresolved. Live rates, real bank resolution, real payouts and the
remaining security review are outside this milestone.

## Errors, configuration and frontend acceptance checklist

Errors use `{ error, request_id }`. Use stable error codes for UI behavior and retain
only the non-secret request ID for support. Never display raw provider exceptions.

| Status | Frontend handling                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Validate strict request shape, phone format, amounts, indices and supported channel.                                            |
| 401    | Missing/expired session or rejected challenge/signature/code; recover the appropriate login or verification step.               |
| 403    | Origin/identity/destination restriction; do not automatically bypass or retry as another identity.                              |
| 404    | Missing or inaccessible resource. Do not distinguish someone else's operation from a missing operation.                         |
| 409    | Business/state conflict, insufficient balance, expired link or mismatched preparation; refresh authoritative state.             |
| 429    | Stop automatic retries, provide a controlled retry action and respect the relevant window. No Retry-After header is guaranteed. |
| 503    | Provider/configuration temporarily unavailable; preserve any durable operation and check its status before another submission.  |
| 500    | Unexpected failure; show a generic error plus request ID, preserving uncertain operation identity.                              |

The frontend needs the approved public API routing and, if using Privy, its public
application ID. Public devnet program/mint addresses are available in
`config/devnet-public.json`; they are not secrets. No Supabase client access is needed.
Never copy the API or worker environment file into a frontend project. Database URLs,
Privy app secrets, session/JWT private keys, Twilio tokens, cron/webhook secrets and
Solana server/operator private keys belong only to the relevant server/operator.

- [ ] Resolve same-origin browser hosting and prove cookies survive challenge/login.
- [ ] Connect an authorized devnet wallet; authenticate by exact-message proof without sender OTP.
- [ ] Restore `/api/me`, handle a null/absent wallet defensively, and clear identity caches on logout/change.
- [ ] Verify expiry, wrong-signature, rejection, replay and rate-limit UI behavior.
- [ ] Show actual test balance and mock-rate labels; wire owned activity and safe preview states.
- [ ] Validate unique E.164 recipients and integer fixed allocations with shared schemas.
- [ ] Make preparation explicit and preserve operation IDs across retries; do not equate preparation with payment.
- [ ] Keep claim fragments, OTPs, phones, bank details, cookies, JWTs and signatures out of telemetry.
- [ ] Complete legitimate Privy client enrollment and actual recipient SMS testing before enabling keep.
- [ ] Keep funding/claims/mock payouts gated until the hosted funded E2E checks pass.

The latest hosted tests used a real Node HTTP client, not a browser connector. Passing
backend tests does not establish browser wallet support, frontend correctness, hosted
payment settlement or production readiness.
