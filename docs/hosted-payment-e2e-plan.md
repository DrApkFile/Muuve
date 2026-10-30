# Hosted payment E2E continuation — prepared, not executed

Wallet-only sender HTTP login now passes against the live API. Migration 006 is verified.
The fresh authentication evidence is in `docs/handoff/2026-10-30-hosted-wallet-verification.md`.
This document prepares the next run; it does not authorize or claim funding, principal
release, payout dispatch or a new contract deployment.

## Inputs and explicit gates

- Keep API `https://muuve.onrender.com`, Supabase project `yirelxmcveyxcqofzayq`, Solana
  devnet, the existing program/mint/treasury, six-decimal test tokens and mock payouts.
- Use the dedicated `keys/devnet/test-sender.json`, whose public funding wallet is
  recorded in `wallets.md`. Do not replace keys or delete `keys/privy-live-test.json`.
- Existing sender balance was freshly verified as **2000000 base units**. The proposed
  primary batch uses 500000 + 1000000 = 1500000, leaving 500000 before any later fixture.
  Recheck balances and rent/fee needs at execution time. Do not mint or request funds
  automatically if balances are insufficient.
- The existing on-chain operator guard names are `OPERATOR_APPROVED_DEVNET=1` and
  `MUUVE_RUN_DEVNET_TRANSACTIONS=1`. A hosted funded-run controller must enforce them,
  verified devnet genesis/config and a specific approved test budget before submission.
  The authentication tool's `--operator-approved-auth-test` is not that funding consent.
- No funded hosted-run controller has been executed. `scripts/devnet-integration.ts`
  is the existing **raw contract** runner and needs at least seven prefunded test tokens
  for a fresh full run. Do not rerun it blindly with the current two-token sender balance
  or count its results as hosted API E2E.
- Obtain real phone verification only for the two authorized eligible recipients in
  ignored `keys/hosted-test-phones.json`. The external-wallet sender needs no SMS.
  Keep OTPs/phones/cookies/claim secrets out of chat and evidence. Respect actual Twilio
  delivery, rate and environment policy; do not substitute local mock OTP on Render.

## Required recipient wallet/client prerequisite

The new hosted Muuve sender is distinct from the earlier local Privy test user. A real
Privy authorization exchange for that hosted identity currently returns 404. Do not
copy fixture IDs, attach another user's wallet or directly insert wallet associations.
An external-wallet sender can prepare/sign funding without a Privy embedded wallet.

For the **recipient keep** path, complete the legitimate Muuve phone/account login and
Privy custom-JWT enrollment under that recipient's actual hosted Muuve UUID. The client
must create/select the owned Solana embedded wallet and use existing `/api/auth/wallet`
to establish the server-verified association. Its phone/account and link claim sessions
must refer to the same verified recipient phone. The browser connector/consumer is
outside this backend repository; no UI is added here. Missing enrollment is a blocker,
not permission to manufacture a user, phone proof or wallet record.

## Use the existing API and exact transaction messages

1. Authenticate the sender through `/api/auth/wallet/challenge` and
   `/api/auth/wallet/login`; keep the actual issued cookie. Current test sessions were
   logged out/expired, so do a fresh supported login.
2. Use a fresh sender-local 16-byte link ID and the project's client-held claim key.
   Only its public key goes to `/api/links/prepare`. Prepare the two distinct fixed
   allocations above with the authorized private recipient phones. Verify sender,
   amounts, slot count, mint/program and capacity reservation in SQL.
3. Sign the exact returned funding transaction with the sender wallet; never alter its
   message, destinations or allocations. Submit through `/api/links/submit` using the
   returned durable operation ID and a stable idempotency key. Poll
   `/api/operations/{operation_id}` and verify actual finalized chain state/signature,
   vault and token balances before proceeding. A 200/transaction signature alone is
   not proof of successful execution.
4. Verify each phone through `/api/auth/otp/send` (purpose `claim`, SMS, actual link UUID)
   and `/api/auth/otp/verify`. `/api/claims/{id}/share` must show only that eligible share.
   Verify unauthorized/wrong-link access after actual proof without exposing membership
   through pre-verification responses.
5. Start bounded claim priority through `/api/claims/{id}/intent/prepare` and
   `/api/claims/{id}/intent/submit` with path `keep` or `cashout`. The client signs with
   the claim key, which remains client-side. Verify the real on-chain intent/version,
   destination and priority window. Do not equate an HTTP request with on-chain priority.
6. Wallet claim uses `/api/claims/{id}/keep/prepare` and `keep/submit`, including the
   matching actual account/claim sessions. Verify the exact permitted destination,
   finalized release, recipient ATA balance, independent remaining slot and SQL state.
   Duplicate/tampered/wrong-wallet/wrong-key attempts must not release principal twice.
7. Cashout uses the configured mock bank directory, `/api/claims/{id}/cashout/quote`,
   `cashout/prepare` and `cashout/submit`. Verify quote freshness, stable payout identity,
   exact configured treasury destination and finalized token receipt before dispatch.
   A mock provider success is explicitly **not** an NGN bank transfer.
8. Run one managed local `scripts/worker.ts` process against the **same hosted database**.
   Follow the existing worker verifier's configuration pattern: minimal worker export,
   with only DATABASE_URL's CA path changed for the local certificate. Do not point at
   an isolated local database or use `/etc/secrets/...` where that file does not exist.
   Use bounded 1–5 second polling, existing leases/idempotency, redacted events and
   SIGTERM shutdown. Do not deploy or modify a hosted worker.
9. Verify provider attempts, durable job/webhook deduplication, principal state and
   aggregate batch status. Use the existing mock/fault cases for success, failure,
   timeout and retry. Provider ambiguity must retain the same logical principal/key;
   no uncontrolled second payment or second escrow release is permitted.
10. Exercise a genuine HTTP/RPC timeout only under the bounded test controller: persist
    the original signature/message/lifetime and reconcile on-chain status/effects before
    any replacement can execute. Preparation may occur immediately; submission must
    retain the existing no-double-principal guards.

## Recall, expiry and budgets

Use separate approved fixtures, preserving fixed allocations. With 500000 base units
left after the main batch, small recall fixtures (for example two 100000-base-unit
slots) can test sender-only recall-one/recall-all and return those test tokens before
funding a small new expiry fixture. Recheck the actual budget; these are proposed
amounts, not executed transfers. Test unauthorized recall, bounded recipient priority,
exact pre-expiry boundary and final vault/surplus/rent handling.

A hosted expiry fixture must be created/funded through the real hosted flow and age
for its actual 48-hour deadline. The separate raw contract fixture already recorded in
`wallets.md` matures **31 October 2026 at 09:39:30 Lagos**; testing it with
`scripts/verify-expiry.ts` proves contract/devnet expiry, not hosted API orchestration.
Never shorten Config, edit a link deadline or fabricate SQL receipts to pretend that
hosted expiry ran. Keep that later natural-expiry evidence separate.

## Do not reuse the authentication preparation

The auth verification prepared link `9887fa84-94f2-4688-8372-507155598cf1` solely to
exercise genuine foreign-operation access. It was never funded; after blockhash expiry
its operation became failed, its parent link cancelled and capacity released. Its two
slots were never funded. Do not submit its old transaction or reuse its operation ID.
The next funded run needs a fresh preparation and blockhash.

## Evidence and cleanup

For every actual submission record the operation ID, request fingerprint, message
hash, blockhash/lifetime, signature, finalized outcome and devnet explorer link. Record
fixed per-slot changes and provider attempts separately. Keep local/fault-injected,
actual hosted, real devnet and mocked-payout evidence distinguishable.

Do not log phones, OTPs, cookies, JWTs, private keys, full bank details or URL-fragment
claim secrets. Retain durable test/audit rows and reconcile every pending operation;
do not reset/drop/truncate the hosted database. Mark any missing real client identity,
phone proof, funding approval, provider boundary or natural deadline as blocked.
