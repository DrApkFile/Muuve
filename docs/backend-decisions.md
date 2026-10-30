# Owner-approved backend milestone

The owner's 28 October 2026 decisions override conflicting v0.2 guide examples.
No frontend is included. Chain integration is devnet only; deployment, provisioning,
funding and live-service credentials are operator responsibilities.

## Contract security specification

- Config initialization requires both the designated admin's signature and the
  deployed program's upgrade authority, proved through the executable program and
  its canonical upgradeable-loader ProgramData account. Arbitrary first callers fail.
- Admin, attestor, fee payer, treasury owner and test-mint authority are distinct.
- Config's mint and token-program identity are immutable. Six decimals are required;
  a freeze authority is rejected. The claim window is exactly 172800 seconds.
- Both legacy SPL Token and Token-2022 are supported. Token-2022 mint extensions:
  **none**. Token-account extensions: **ImmutableOwner only**, including extension-free
  accounts. Transfer fees/hooks, permanent delegates, confidential/nontransferable,
  freeze/default-state, memo/CPI guards, interest/scaled amounts, close authority,
  metadata and all unknown extensions are rejected. This deliberately bounded
  allowlist preserves exact principal and closure semantics; it is not blanket
  support for every Token-2022 feature. Revalidate on every token operation.
- Config rotation affects future links. Each Link snapshots attestor, treasury,
  mint, token program and expiry. Operators retain old attestor keys and monitor old
  treasuries until their links and payouts settle. Rotation is not revocation.
- Link seeds: `["link", sender_pubkey, link_id_16_bytes]`; Config: `["config"]`.
  API routes use an opaque database UUID, not a bare sender-local link ID. Sender
  create requests identify the sender through the account session. Chain links
  retain both sender and sender-local ID. Duplicate IDs across senders are valid.
- Slots have immutable positive allocations, 1–10 entries, checked u64 sum and
  configured slot/link limits. `open_slots` counts funded principal, including intents.
  Principal is never increased by donations. No recipient PII enters chain state/events.
- Claims require the snapshotted attestor and claim-key signatures; recipients are
  authorized off-chain. Attestor compromise plus a shared claim key is a trust risk.
- Claims and recalls require `now < expires_at`. Only expire refunds funded slots
  at/after expiry. Terminal slots never transfer principal twice.
- Refund destination is the original sender's ATA for the snapshotted mint/program.
  Final settlement sweeps surplus there, emits a surplus event and closes the vault
  to the original stored rent payer. The Link receipt remains allocated.
- Allocations/statuses are public on-chain. API privacy excludes phone numbers,
  labels and other slots, but does not promise chain-level amount confidentiality.

## Recipient priority: objective start and bounded protection

An HTTP request, OTP verification or a prepared signature cannot order competing
on-chain transactions. Priority starts only when `start_claim` is confirmed on-chain.
An earlier successful recall wins; the API never promises priority before confirmation.

`start_claim(slot, intent_id, expected_version, destination, to_treasury)` requires
claim-key + snapshotted-attestor signatures, a funded slot, correct destination and
`now < expires_at`. It records an intent ID, destination, mode and incremented version.
The first intent sets `priority_until = min(now + 120 seconds, expires_at)`.
Subsequent authorized intents can change the destination/mode but **never extend**
that original deadline. Compare-and-increment version prevents stale intent replay.

During `[first_intent_time, priority_until)`, sender recall rejects that slot;
recall-all skips protected slots and rejects when no eligible slots remain. After
the protection expires, a funded slot may still be claimed before link expiry,
but recall competes normally. Expiry is never delayed. Final claims bind the current
intent ID/version and exact destination/mode, invalidating obsolete prepared claims.
This adds an explicit intent prepare/submit API before final claim preparation.

## Instruction accounts and signers

| Instruction              | Required signers                   | Account constraints                                                                                              |
| ------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| init_config              | admin, deployment authority, payer | canonical executable program/ProgramData; upgrade authority; Config PDA; validated mint/program and treasury ATA |
| update_config            | stored admin                       | Config PDA; validated new treasury; immutable mint/program/window                                                |
| create_link              | sender, configured fee/rent payer  | Config; sender-local Link PDA; sender ATA; Link vault ATA; mint/program                                          |
| start_claim              | stored claim key, Link attestor    | Link PDA; slot bounds/funded; expected version; valid destination                                                |
| claim_to_wallet          | claim key, Link attestor, payer    | current intent; destination ATA; Link vault; sender refund ATA; recorded rent recipient                          |
| claim_to_treasury        | claim key, Link attestor, payer    | above; exact snapshotted treasury ATA                                                                            |
| recall_slot / recall_all | original sender, payer             | pre-expiry; unprotected funded slots; original sender ATA; recorded rent recipient                               |
| expire                   | transaction payer                  | deadline reached; remaining funded slots; original sender ATA; recorded rent recipient                           |

All transfers use checked decimals/mint/program constraints. Canonical PDAs sign CPIs.
Only positive recorded principal is released per slot; closed/terminal receipts cannot
be reinitialized. Arithmetic and index failures must return errors, never panic.

## Operations, finality and safe immediate retries

Every preparation returns a server UUID operation ID, committed before broadcast,
bound to actor, immutable fingerprint, source principal and exact message bytes.
Store blockhash, last-valid height, signatures and every replacement relationship.
Reservations count at preparation under a per-sender database lock.

Payout dispatch waits for **finalized**, successful chain execution and verified
principal movement. Submitted/confirmed/finalized/business states are separate.
Already-issued signatures cannot be revoked by later session expiry.

On chain submission timeout, prepare a replacement immediately. Claims/recalls/expiry
use the same slot state/intent; create uses the same PDA. Non-escrow token transfers
(wallet payouts, treasury refunds, funding) must not submit a second distinct transfer
while an original can land: prepare immediately but hold submission until verified
failure or blockhash expiry plus finalized reconciliation. An unknown outcome is
never presented as failure. Replacement preparation does not free reservations.

On provider timeout retry immediately with the **same logical payout identity and
provider idempotency key**. Record each attempt. If deduplication/status verification
is unavailable, quarantine; do not create an uncontrolled second payment.

Batch settlement requires every slot and associated payout/principal resolution to
be terminal. Retry, keep and refund acquire the same principal lock. Persist intents
and events atomically; inbox/outbox workers reconcile external actions after crashes.

## Verification gates

Contract negative cases precede backend chain dependence. Include both token programs,
mint/account extension rejection, all claim/recall/expiry boundaries, intent races,
sender-local IDs, bootstrap takeover, rotations, donations, rent and arithmetic.
Local native/runtime tests are not devnet deployment evidence. Devnet expiry needs
an actually aged 48-hour fixture; never shorten Config to manufacture evidence.
Security-sensitive code remains subject to the repository's human review requirements.

## Wallet-only sender login (owner clarification, 30 October 2026)

Senders may authenticate by proving control of their funding wallet without providing
or verifying a phone. Add a server-generated Ed25519 sign-message challenge, bound to
canonical APP_BASE_URL, Solana devnet, a unique nonce, a five-minute deadline and an
HttpOnly/Secure/SameSite=Lax browser cookie. Persist and consume challenges atomically;
limit issuance by wallet/IP and failed signature attempts. Concurrent/replayed proofs
must create at most one account session per challenge. Never accept a client-defined
message, user ID, phone or funding destination as identity evidence.

Wallet login issues an account session with **no verified phone**, even if the wallet
already belongs to a phone account. Recipient claim/proof sessions still require OTP
and link membership; wallet-only sessions cannot authorize keep/claim as that phone.
Existing phone accounts are not automatically merged by claimed phone or Privy ID.
An existing wallet association identifies its existing user; a new wallet creates a
wallet-origin user with no phone. Wallet ownership checks for embedded Privy wallets
remain enforced independently. No arbitrary-transaction signing API is introduced.

Database changes are an additive migration, tested on disposable PostgreSQL only until
operator approval to migrate hosted Supabase. Preserve all historical migration hashes.
Privy live verification uses an explicitly opted-in dedicated test identity and a
Privy-managed test wallet. Test message/transaction signing without broadcasting,
exporting a wallet key, adding a server signer or changing Privy dashboard settings.
A local API/SQL proof is recorded separately from hosted API authentication evidence.
