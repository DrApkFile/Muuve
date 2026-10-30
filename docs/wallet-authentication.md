# Wallet-only sender authentication

The sender can prove control of a Solana funding wallet without a phone or SMS.
Recipient verification still uses OTP and exact link/slot membership. These backend
routes add no frontend, wallet connector, unrestricted signing proxy or real payout.

## API contract

All mutations require an exact `Origin` equal to canonical `APP_BASE_URL`. Use HTTPS
and cookies; existing Secure/HttpOnly/SameSite=Lax session behavior is preserved.

1. `POST /api/auth/wallet/challenge` with `{ "wallet_address": "<Solana public key>" }`.
   The server returns `{ challenge_id, message, expires_at }` and sets the
   `muuve_wallet_challenge` cookie. Sign the exact UTF-8 bytes of `message` using the
   selected wallet's Ed25519 `signMessage` capability. This is a login message,
   not a blockchain transaction or an approval to transfer funds.
2. `POST /api/auth/wallet/login` with `{ "challenge_id": "<UUID>", "signature":
"<base58-encoded 64-byte signature>" }`, including that same browser cookie.
   The server derives wallet/user identity from the stored challenge, consumes it
   atomically and issues the normal account session. The response is `{ user }`.
3. `GET /api/me` and existing sender link/balance/funding/recall APIs use that account
   cookie. Transactions still require the funding wallet's actual signature over the
   exact server-prepared message. A login signature cannot submit a payment.
4. `GET /api/auth/privy-token` can issue the existing five-minute ES256 bridge JWT.
   Its subject is the Muuve user UUID, issuer is canonical `APP_BASE_URL`, audience is
   `NEXT_PUBLIC_PRIVY_APP_ID`, and the stable KID matches `/api/auth/jwks`.
5. Existing refresh/logout APIs work for a wallet-only session. Logout clears the
   wallet challenge cookie as well as account/claim/proof cookies.

Return error bodies use the existing `{ error, request_id }` format. Missing/wrong
origin returns 403; malformed body/unsupported wallet returns 400; missing, expired,
consumed or exhausted challenge and wrong signature return 401; issuance limits
return 429. No client-supplied phone, user ID, message or alternative wallet is
accepted in login verification.

## Security and identity boundaries

- Challenges use a cryptographic nonce, sender address, origin, devnet, issue/expiry
  times and request UUID. Expiry is five minutes; verification uses database time
  and accepts only `now < expires_at`.
- The separate random browser cookie is stored as SHA-256 in SQL. A challenge and
  signature copied into another browser are insufficient without that cookie.
- Row locking makes verification/consumption/session issuance/audit atomic. Failed
  signatures commit their attempt counter; five failures exhaust a challenge.
- Transactional advisory locks enforce at most three challenges per wallet in ten
  minutes and twenty per IP per hour, including concurrent requests.
- Forwarded IP is used only with the existing `TRUSTED_PROXY=true` policy. Otherwise
  requests share the conservative local fallback bucket; do not enable proxy trust
  until the deployment's forwarded-header behavior is reviewed.
- A wallet-origin user has no phone. A wallet login to an existing phone account also
  issues a session with no verified phone. Neither can serve as recipient phone proof.
  Recipient keep still requires both an eligible OTP claim session and an account
  session for that same verified phone. Cashout retains its existing OTP/claim-key/
  attestor/treasury authorization requirements.
- Existing wallet associations identify existing accounts. There is no automatic
  merging by a submitted phone or Privy ID, and no automatic funding-wallet switch.
  Self-payment rejection uses the stored user phone when one exists.
- `users.wallet_address` remains the funding wallet. A separately provisioned Privy
  embedded test wallet is a separate public address. The live verifier does not replace
  the funding wallet, export an embedded private key or add a server authorization key.
- Phone numbers, OTPs, browser cookies, JWTs, challenges and login signatures must not
  be logged. New audit events contain only the user UUID and event type.
- The signing-key service remains a trust boundary: anyone controlling Muuve's JWT
  signing key can impersonate custom-auth identities to Privy. Do not equate custom
  authentication with removing backend trust. Human security review remains required.

## Database rollout

`supabase/migrations/006_wallet_login.sql` permits phone-less wallet accounts, account
sessions and wallet-source principals, while retaining required phones for phone users,
claim/proof sessions and escrow-claim principals. It adds `wallet_auth_challenges`
with indexes, RLS and PUBLIC access restrictions. Earlier migration hashes are unchanged.
The challenge rows support rate-limit/replay auditing; their retention policy must
retain at least the one-hour IP window. No automatic deletion job is added here.

Apply migration 006 to the approved development database before deploying the API
source. Do not deploy the wallet routes against only migrations 001–005. Existing
phone data and recipient allocations are preserved. No shared-database migration is
run by tests; `pnpm test:db` provisions a disposable loopback cluster.

After explicit operator approval, the existing migration command for this Supabase
project is:

```sh
MUUVE_ALLOW_MIGRATIONS=1 MUUVE_DATABASE_PROJECT_REF=yirelxmcveyxcqofzayq \
  node --env-file=.env.local --import tsx scripts/migrate.ts
node --env-file=.env.local --import tsx scripts/database-status.ts
```

No new runtime environment variables or dependencies are required for wallet login.
`APP_BASE_URL`, `SOLANA_CLUSTER=devnet` and `SESSION_SECRET` retain their existing
roles. The Privy bridge uses the existing app ID, app secret, JWT key and KID.

## Real Privy integration verification

The public JWKS returning 200 and a dashboard save returning 200 are prerequisites;
a successful JWT-authorized wallet signature is the acceptance test. Privy has an
authentication-environment setting: the supplied server SDK verifier needs server-side
JWT authentication configured with the same JWKS URL and ID claim `sub`. Keep client-side
configuration only where the intended browser client actually uses it. Changing that
provider configuration is an owner/dashboard action.

Review and run:

```sh
node scripts/verify-privy-live.mjs --operator-approved
```

This command loads the ignored API environment export but **overrides DATABASE_URL**
to a disposable loopback PostgreSQL cluster. It does not connect to or migrate hosted
Supabase. It uses the existing restricted `keys/devnet/test-sender.json` to perform
wallet login against the actual local handler/SQL, then verifies the resulting bridge
JWT against Render's real public JWKS. This is local API evidence, not hosted login.

The verifier persists a stable dedicated test identity in ignored mode-0600
`keys/privy-live-test.json` before provider operations. It looks up/reuses that custom
identity; only the initial run creates its Privy-managed Solana test wallet. If creation
has an uncertain outcome, a subsequent lookup must reconcile it before any new create.
Do not delete this progress file to work around a provider failure.

It checks custom ID/wallet ownership against real Privy records and a one-user owner
quorum, then tests JWT-authorized message signing, rejection without user authorization,
rejection of an expired JWT, and signing an exact zero-lamport self-transfer message
with a recent blockhash fetched from verified Solana devnet. It verifies signatures
locally and **never broadcasts** the transaction. A Privy authorization/session key is
handled by the SDK in memory; no wallet private key is requested or exported.

Results and failure stage are recorded in `evidence/privy-wallet/live-verification.json`.
No token, cookie, private key or signed transaction bytes are printed. A provider 401
is a failed integration gate, even if local JWT verification succeeds. It is not
permission to fall back to an app-held signing key or fabricate success.

Official references:
[JWT configuration](https://docs.privy.io/authentication/user-authentication/jwt-based-auth/setup),
[user authentication settings](https://docs.privy.io/controls/authorization-keys/keys/create/user/authentication),
[server request authorization](https://docs.privy.io/controls/authorization-keys/using-owners/sign/signing-on-the-server).
