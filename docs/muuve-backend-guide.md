# Muuve — Backend Guide

**Version:** 0.2. Read `muuve-prd.md` first. This guide covers auth and phone verification, the Solana escrow program, data model, API, providers, and security rules.

---

## 1. Architecture

```
 Sender (web)                         Recipient (phone browser)
      │                                         │
      ▼                                         ▼
 ┌──────────────────── apps/web (Next.js on Vercel) ─────────────────────┐
 │  UI routes                  /api/* route handlers (this guide)        │
 │                               │          │           │                │
 │                     OTP provider    Supabase     Providers            │
 │                     (Twilio Verify:  Postgres    (rates, banks,       │
 │                      SMS + WhatsApp)              payouts)            │
 │                               │                                       │
 │        Server keys: fee payer · attestor · treasury · auth JWT key    │
 └───────────────────────────────┼───────────────────────────────────────┘
                 │               ▼
          Privy (embedded    Solana (devnet for demo)
          wallets, custom    muuve_escrow program + USDT mint
          auth via our JWT)
```

| Concern | Choice |
|---|---|
| Runtime | Next.js route handlers, Node runtime (not Edge) |
| DB | Supabase Postgres, **server-only** access with the service role key. RLS on, no client access. |
| Phone verification | **Our own**, via Twilio Verify (`sms` and `whatsapp` channels) behind an `OtpProvider` interface |
| Sessions | Our own signed, httpOnly cookies (account session and claim session) |
| Wallets | Privy embedded Solana wallets using **custom auth**: Privy trusts a JWT we issue after our OTP. Confirm the current Privy custom-auth docs before wiring. |
| Chain | Solana devnet, test USDT mint (6 decimals). Mainnet USDT mint `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` (verify before any mainnet work). |
| Program | Anchor, `programs/muuve_escrow` |
| Jobs | Scheduled calls to `/api/cron/*` (see §5.8 for plan limits) |
| Validation | Zod schemas in `packages/shared`, used by API and UI |

One deployable. No microservices.

**Why our own OTP instead of Privy's login:** recipients need codes by **WhatsApp or SMS**, cashing out must work **without an account**, and a recipient who keeps dollars must create an account **without a second code**. Owning verification lets one verified code serve the claim and the account creation.

---

## 2. Core concepts

### 2.1 Link and slots
A **link** is one on-chain escrow with 1–10 **slots**. Each slot is one recipient's share. A single send is a link with one slot; a batch is a link with several. Phone numbers are **never stored on-chain**; the DB maps `slot_index → recipient_phone_e164`.

### 2.2 Claim key (the link secret)
- An ed25519 keypair whose **secret** lives only in the URL fragment `#k=`. All recipients of a batch share the same link and the same claim key.
- **Derived on the sender's device** so Muuve never stores it and the sender can re-share:
  1. Sender's embedded wallet signs `muuve-claim-v1:{link_id_hex}`.
  2. `seed = sha256(signature)`; `claimKeypair = Keypair.fromSeed(seed)`.
  3. Client sends only `claim_pubkey` to the backend.

### 2.3 Attestor
A server keypair registered in the program `Config`. The backend co-signs a claim **only** when:
- the caller holds a valid **claim session** for this link and a phone number,
- that phone belongs to exactly one slot on this link, and the slot is `funded` and not expired,
- the destination is the one allowed for the chosen path (§3.2): the caller's own linked wallet for **keep**, or the treasury for **cash-out** with a recorded payout.

The attestor signs the whole transaction message, so the slot index and destination are locked in. Claim needs **claim key + attestor**: the link alone or the server alone can't claim.

### 2.4 Fee payer
Pays all transaction fees and rent so nobody needs SOL. Separate keypair. Alert below 1 SOL on devnet.

### 2.5 Treasury
A server-held wallet whose USDT token account receives escrow releases for cash-outs, sends naira through the payout provider, and can send USDT onward (to a recipient's new wallet or back to the sender) when a payout fails.

### 2.6 Claim window
**48 hours** (`172_800` seconds) from link creation, set by the program from `Config`. After that, anyone can call `expire()` and every unclaimed slot returns to the sender.

---

## 3. Solana program: `muuve_escrow`

### 3.1 Accounts

```rust
pub const MAX_SLOTS: usize = 10;

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub attestor: Pubkey,
    pub usdt_mint: Pubkey,
    pub treasury_token_account: Pubkey, // USDT account that receives cash-out releases
    pub max_slot_amount: u64,           // base units, e.g. 500_000_000 = $500
    pub max_link_amount: u64,           // e.g. 1_000_000_000 = $1,000
    pub claim_window_secs: i64,         // 172_800 (48h)
    pub bump: u8,
}
// seeds: [b"config"]

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default)]
pub enum SlotStatus { #[default] Empty, Funded, Claimed, Recalled, Expired }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default)]
pub struct Slot { pub amount: u64, pub status: SlotStatus }

#[account]
pub struct Link {
    pub link_id: [u8; 16],
    pub sender: Pubkey,        // refunds go to the sender's USDT ATA
    pub rent_payer: Pubkey,    // fee payer; gets vault rent back on close
    pub claim_pubkey: Pubkey,
    pub created_at: i64,
    pub expires_at: i64,       // created_at + config.claim_window_secs
    pub slot_count: u8,
    pub open_slots: u8,        // slots still Funded
    pub total: u64,
    pub slots: [Slot; MAX_SLOTS],
    pub bump: u8,
}
// seeds: [b"link", link_id]
// vault: USDT ATA owned by the Link PDA
```

### 3.2 Instructions

| Instruction | Signers | Rules | Effect |
|---|---|---|---|
| `init_config` | admin | once | creates `Config` |
| `update_config` | admin | — | rotate attestor / treasury / limits |
| `create_link(link_id, claim_pubkey, amounts: Vec<u64>)` | sender, rent_payer | `1 ≤ len ≤ 10`; each `0 < a ≤ max_slot_amount`; checked sum `≤ max_link_amount`; mint matches | init `Link` + vault; `expires_at = now + claim_window_secs`; transfer total sender → vault; slots `Funded` |
| `claim_to_wallet(slot_index)` | claim key, attestor, rent_payer | slot `Funded`; `now < expires_at` | init recipient ATA if needed; vault → recipient ATA; slot `Claimed` |
| `claim_to_treasury(slot_index)` | claim key, attestor, rent_payer | as above; destination **must equal** `config.treasury_token_account` | vault → treasury; slot `Claimed` |
| `recall_slot(slot_index)` | sender | slot `Funded` | vault → sender ATA; slot `Recalled` |
| `recall_all()` | sender | ≥ 1 slot `Funded` | every `Funded` slot → sender; `Recalled` |
| `expire()` | anyone | `now ≥ expires_at`; ≥ 1 slot `Funded` | every `Funded` slot → sender; `Expired` |

After any instruction, if `open_slots == 0`, close the vault (rent → `rent_payer`). Keep the `Link` account as an on-chain receipt for the hackathon.

Use `checked_add` / `checked_sub` everywhere. Validate `slot_index < slot_count`.

### 3.3 Errors
`InvalidSlotCount`, `InvalidAmount`, `LinkTooLarge`, `WrongMint`, `BadSlotIndex`, `SlotNotFunded`, `LinkExpired`, `NotExpired`, `NothingToRefund`, `BadClaimKey`, `BadAttestor`, `NotSender`, `WrongTreasury`, `MathOverflow`.

### 3.4 Events
`LinkCreated { link_id, sender, total, slot_count, expires_at }`
`SlotClaimed { link_id, slot_index, destination, to_treasury: bool }`
`SlotRecalled { link_id, slot_index }`
`LinkExpired { link_id, refunded_slots: u8, amount }`

### 3.5 Program tests (must pass before API work depends on them)
- [ ] single-slot create → `claim_to_wallet`; ATA created; vault closed
- [ ] 3-slot create → claim slot 0 to wallet, slot 1 to treasury → slot 2 still `Funded`; vault open
- [ ] `claim_to_treasury` with a non-treasury destination → `WrongTreasury`
- [ ] wrong claim key → `BadClaimKey`; missing/wrong attestor → `BadAttestor`
- [ ] claiming the same slot twice → `SlotNotFunded`
- [ ] slot index ≥ slot_count → `BadSlotIndex`
- [ ] claim at/after `expires_at` → `LinkExpired`
- [ ] `recall_slot` by sender refunds only that slot; by anyone else → `NotSender`
- [ ] `recall_all` refunds every funded slot and closes the vault
- [ ] `expire` before 48h → `NotExpired`; after → refunds funded slots only, closes vault
- [ ] `expire` when nothing is funded → `NothingToRefund`
- [ ] 0 slots / 11 slots → `InvalidSlotCount`; zero or over-limit amount → `InvalidAmount`; total over limit → `LinkTooLarge`
- [ ] wrong mint → `WrongMint`
- [ ] `expires_at` equals `created_at + 172_800` (warp the clock in tests with `bankrun` or a test validator time warp)

---

## 4. Data model (Supabase Postgres)

```sql
create type auth_origin as enum ('muuve','cleva_preview');

create table users (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text unique not null,
  display_name text not null,
  auth_origin auth_origin not null default 'muuve',
  wallet_address text unique,              -- null until Privy wallet is linked
  privy_user_id text unique,
  created_at timestamptz default now()
);

create table otp_requests (                  -- rate limiting + audit; no codes stored
  id bigserial primary key,
  phone_e164 text not null,
  channel text not null check (channel in ('sms','whatsapp')),
  purpose text not null check (purpose in ('account','claim')),
  link_id_hex char(32),
  ip inet,
  status text not null,                      -- 'sent' | 'verified' | 'failed'
  created_at timestamptz default now()
);
create index on otp_requests (phone_e164, created_at desc);

create type link_status as enum ('pending','open','settled');
create type link_kind   as enum ('single','batch');

create table links (
  id uuid primary key default gen_random_uuid(),
  link_id_hex char(32) unique not null,
  sender_user_id uuid not null references users(id),
  kind link_kind not null,
  claim_pubkey text not null,
  note text check (char_length(note) <= 120),
  total_base_units numeric(20,0) not null check (total_base_units > 0),
  slot_count smallint not null check (slot_count between 1 and 10),
  status link_status not null default 'pending',
  create_sig text,
  expires_at timestamptz,                    -- copied from chain after create confirms
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index on links (sender_user_id, created_at desc);
create index on links (status, expires_at);

create type slot_status as enum
  ('pending','funded','cashing_out','cashed_out','kept','recalled','returned');

create table link_slots (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references links(id) on delete cascade,
  slot_index smallint not null check (slot_index between 0 and 9),
  recipient_phone_e164 text not null,
  label text check (char_length(label) <= 40),   -- sender-private, e.g. "Mama"
  amount_base_units numeric(20,0) not null check (amount_base_units > 0),
  status slot_status not null default 'pending',
  claimed_by_user_id uuid references users(id),  -- set for 'kept'
  claim_sig text, recall_sig text, return_sig text,
  claimed_at timestamptz,
  unique (link_id, slot_index),
  unique (link_id, recipient_phone_e164)
);

create type payout_source as enum ('escrow_claim','wallet');
create type payout_status as enum
  ('quoted','transferring','processing','paid','failed','resolved');
create type payout_resolution as enum
  ('retried','kept_in_dollars','returned_to_wallet','refunded_to_sender');

create table payouts (
  id uuid primary key default gen_random_uuid(),
  source payout_source not null,
  user_id uuid references users(id),             -- null for no-account cash-outs
  link_slot_id uuid references link_slots(id),   -- set for escrow_claim
  recipient_phone_e164 text not null,
  amount_base_units numeric(20,0) not null,
  rate_ngn_per_usd numeric(14,4) not null,
  amount_ngn_kobo numeric(20,0) not null,
  quote_expires_at timestamptz not null,
  bank_code text,
  account_number char(10),
  account_name text,
  status payout_status not null default 'quoted',
  resolution payout_resolution,
  retry_of uuid references payouts(id),
  transfer_sig text,          -- escrow → treasury, or wallet → treasury
  resolution_sig text,        -- treasury → wallet / sender
  provider text not null,
  provider_ref text,
  failure_reason text,
  failed_at timestamptz,
  idempotency_key text unique,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table events (
  id bigserial primary key,
  entity_type text not null,   -- 'link' | 'slot' | 'payout' | 'user'
  entity_id uuid not null,
  type text not null,          -- 'slot.cashed_out', 'link.expired', ...
  payload jsonb not null default '{}',
  created_at timestamptz default now()
);
```

Every status change goes through one function per entity (`transitionLink`, `transitionSlot`, `transitionPayout`) that checks the transition is allowed and writes an `events` row in the same DB transaction.

### 4.1 Allowed transitions

```
link:  pending → open → settled            (settled = no slot left 'funded' or 'cashing_out')

slot:  pending → funded → cashing_out → cashed_out
                        │             ↘ kept        (payout failed, recipient chose keep)
                        │             ↘ returned    (payout failed, 48h no action → sender)
                        ├→ kept
                        ├→ recalled
                        └→ returned                 (48h expiry)

payout (escrow_claim):  quoted → transferring → processing → paid
                                                     ↘ failed → resolved (retried | kept_in_dollars | refunded_to_sender)
payout (retry):         quoted → processing → paid | failed      (treasury already holds the USDT)
payout (wallet):        quoted → transferring → processing → paid
                                                     ↘ failed → resolved (returned_to_wallet, automatic)
```

---

## 5. API

JSON in and out. Every body validated with Zod. Sessions are httpOnly cookies (§6).

**Transaction pattern (prepare → sign → submit):**
1. `…/prepare` builds the transaction, sets the fee payer, adds server signatures (fee payer; attestor for claims), stores a hash of the message, and returns `{ tx: base64 }`.
2. The client adds its signature: sender wallet for create/recall/wallet payouts; **claim key** for claims.
3. `…/submit` with `{ tx, idempotency_key }` checks the message bytes match the stored hash, sends, waits for `confirmed`, updates the DB, returns new state.

### 5.1 Auth

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/auth/otp/send` | `{ phone_e164, channel: 'sms'\|'whatsapp', purpose: 'account'\|'claim', link_id_hex? }` | `{ sent: true, channel }` |
| POST | `/api/auth/otp/verify` | `{ phone_e164, code, purpose, link_id_hex? }` | see below |
| POST | `/api/auth/signup` | `{ display_name, origin: 'muuve'\|'cleva_preview' }` | `{ user }` + account session |
| GET | `/api/auth/privy-token` | — | `{ token }` short-lived JWT for Privy custom auth |
| GET | `/api/auth/jwks` | — | public JWKS Privy uses to verify our JWT |
| POST | `/api/auth/wallet` | `{ wallet_address }` | links the Privy wallet after verifying it with Privy's server API |
| POST | `/api/auth/logout` | — | clears sessions |
| GET | `/api/me` | — | user, auth origin, wallet status |

`otp/verify` results:
- `purpose: 'account'`, existing user → sets **account session**, returns `{ user }`.
- `purpose: 'account'`, new number → sets a **phone proof** cookie, returns `{ needs_signup: true }`.
- `purpose: 'claim'` → sets a **claim session** for this link + phone, returns `{ verified: true }`. If a user already exists with this phone, also sets the account session.

`signup` accepts **either** a phone proof cookie **or** a claim session as proof of the number, so a recipient who chooses **Keep in dollars** never gets a second code.

Rules for `otp/send`:
- `whatsapp` only if `WHATSAPP_OTP_ENABLED=true`; otherwise 400 `channel_unavailable`.
- For `purpose: 'claim'`, **always** send the code (subject to rate limits) whether or not the number is on the link. Membership is revealed only after verification, so nobody can probe which numbers are on a batch.
- Rate limits in §7.

### 5.2 Funding and balance

| Method | Path | Notes |
|---|---|---|
| GET | `/api/balance` | USDT balance + naira estimate |
| POST | `/api/fund/demo` | **Devnet only.** Mints test USDT, max $200/day/user |
| POST | `/api/fund/cleva-preview` | **Devnet only.** Same as demo funding, labelled "Cleva balance (preview)"; only for `auth_origin = 'cleva_preview'` |

Both hard-fail unless `SOLANA_CLUSTER=devnet`.

### 5.3 Links (sender, account session)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/links/prepare` | `{ link_id_hex, claim_pubkey, note?, recipients: [{ phone_e164, amount_base_units, label? }] }` | `{ link, tx }` — link + slots inserted as `pending` |
| POST | `/api/links/submit` | `{ link_id_hex, tx, idempotency_key }` | `{ link }` — `open`, slots `funded`, `expires_at` from chain |
| GET | `/api/links` | — | sender's links with slot summaries |
| GET | `/api/links/:id` | — | link + slots (phone, label, amount, status) + timeline + `reminder_due` |
| POST | `/api/links/:id/recall/prepare` | `{ slot_index? }` | `{ tx }` — one slot, or all funded slots if omitted |
| POST | `/api/links/:id/recall/submit` | `{ tx, idempotency_key }` | `{ link }` |

Rules: 1–10 recipients; `kind = 'single'` if one, else `'batch'`; valid E.164 numbers; **no duplicates**; sender's own number not allowed; per-slot ≤ $500; link total ≤ $1,000; sender's outstanding (open slots) ≤ $1,000; total ≤ balance. `reminder_due = true` when the link is ≥ 24h old and any slot is still `funded`.

### 5.4 Public preview (no auth)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/public/links/:id` | `{ kind, sender_first_name, note, status, expires_at, amount_base_units? }` |

`amount_base_units` only for `single`. Never returns phone numbers, labels, slot counts or amounts for batches, claim pubkey, or IDs. `pending` → 404. Rate-limited by IP.

### 5.5 Claims (claim session for this link)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/claims/:id/share` | — | `{ slot_index, amount_base_units, status, payout? }` or 404 `not_on_payment` |
| POST | `/api/claims/:id/cashout/quote` | `{ retry_of? }` | `{ quote_id, rate_ngn_per_usd, amount_ngn_kobo, expires_at }` (60s) |
| POST | `/api/claims/:id/cashout/prepare` | `{ quote_id, bank_code, account_number }` | `{ payout, tx }` — `claim_to_treasury` signed by fee payer + attestor |
| POST | `/api/claims/:id/cashout/submit` | `{ payout_id, tx, idempotency_key }` | `{ payout }` → `processing` |
| POST | `/api/claims/:id/cashout/retry` | `{ quote_id, bank_code, account_number, idempotency_key }` | `{ payout }` — new payout from treasury after a failure; no chain tx |
| POST | `/api/claims/:id/keep/prepare` | — (also needs account session, same phone, wallet linked) | `{ tx }` — `claim_to_wallet`; **or** `{ done: true }` if the slot is in a failed cash-out (server sends treasury → wallet) |
| POST | `/api/claims/:id/keep/submit` | `{ tx, idempotency_key }` | `{ slot }` → `kept` |

`cashout/prepare` checks, in order: claim session valid and bound to this link; slot found for the session phone and `funded`; link not expired; quote valid and for this slot's amount; account name re-resolved. Then it inserts the payout (`source = 'escrow_claim'`), builds `claim_to_treasury(slot_index)`, and co-signs.

`keep/prepare` checks: claim session + account session both present with **the same phone**; user has a linked wallet; slot `funded` (or `cashing_out` with a `failed` payout). Destination = that user's wallet, set server-side.

On cash-out submit confirmation: slot → `cashing_out`, payout → `processing`, call `PayoutProvider.createPayout`. Webhook `paid` → payout `paid`, slot `cashed_out`.

### 5.6 Banks and wallet payouts (account holders)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/banks` | — | list, with OPay, PalmPay, Moniepoint, Kuda first |
| POST | `/api/banks/resolve` | `{ bank_code, account_number }` | `{ account_name }` (needs account or claim session) |
| POST | `/api/payouts/quote` | `{ amount_base_units }` | quote (source `wallet`) |
| POST | `/api/payouts/prepare` | `{ quote_id, bank_code, account_number }` | `{ payout, tx }` — wallet → treasury |
| POST | `/api/payouts/submit` | `{ payout_id, tx, idempotency_key }` | `{ payout }` |
| GET | `/api/payouts/:id` | — | payout (owner by account session, or by claim session phone) |
| POST | `/api/webhooks/payout` | provider payload | verify signature → `paid` / `failed` |

Wallet payout `failed` → treasury returns USDT to the user's wallet immediately → `resolved` / `returned_to_wallet`.

### 5.7 Failed escrow cash-out
- Payout `failed`: set `failed_at`; slot stays `cashing_out`; claim page shows **Try another account** / **Keep in dollars**.
- **Retry:** new quote with `retry_of` → `cashout/retry` → new payout from treasury; old payout → `resolved` / `retried`.
- **Keep:** account created → treasury sends USDT to the new wallet → old payout `resolved` / `kept_in_dollars`; slot `kept`.
- **No action for 48h after `failed_at`:** cron sends treasury → sender wallet; payout `resolved` / `refunded_to_sender`; slot `returned`.

### 5.8 Cron

| Path | Every | Job |
|---|---|---|
| `/api/cron/expire` | 5 min | links `open` with `expires_at ≤ now` and funded slots → call `expire()` → slots `returned`, link `settled` |
| `/api/cron/failed-payouts` | 15 min | escrow payouts `failed` for ≥ 48h → treasury → sender; resolve |
| `/api/cron/reconcile` | 5 min | re-check chain for `pending` links > 2 min old, `transferring` / `processing` payouts; fix drift |

Protect with `CRON_SECRET`. Vercel's cron frequency depends on the plan; if yours can't run every 5 minutes, trigger these routes from GitHub Actions `schedule`, Supabase `pg_cron` + `pg_net`, or another scheduler. The 24-hour sender reminder needs no job: it's computed on read (`reminder_due`).

---

## 6. Sessions

| Cookie | Set by | Contents | Lifetime |
|---|---|---|---|
| `muuve_session` | `otp/verify` (account, existing user), `signup` | `user_id`, `phone` | 30 days, rolling |
| `muuve_phone_proof` | `otp/verify` (account, new number) | `phone` | 15 min, single use by `signup` |
| `muuve_claim` | `otp/verify` (claim) | `link_id_hex`, `phone` | 20 min |

All are signed JWTs (`SESSION_SECRET`), `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`. Mutating routes check `Origin`. A claim session only works for the link it was issued for.

**Privy custom auth:** after an account session exists, the frontend calls `/api/auth/privy-token`, logs into Privy with it, Privy creates the embedded Solana wallet, and the frontend posts the address to `/api/auth/wallet`. The backend confirms with Privy's server API that the wallet belongs to that Privy user before saving it.

---

## 7. Security rules (non-negotiable)

1. **Server-only secrets:** `FEE_PAYER_SECRET`, `ATTESTOR_SECRET`, `TREASURY_SECRET`, `TEST_MINT_AUTHORITY_SECRET`, `AUTH_JWT_PRIVATE_KEY`, `SESSION_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `PRIVY_APP_SECRET`, `TWILIO_*`, `CRON_SECRET`, provider keys. Never `NEXT_PUBLIC_`.
2. **Five separate keypairs:** admin, attestor, fee payer, treasury, test mint authority.
3. **Never log** the `#k=` secret, OTP codes, full phone numbers, or account numbers. Use `maskPhone()` / `maskAccount()`.
4. **Destinations are server-decided.** Claim destination (user's wallet or treasury) and refund destination (sender) never come from the request body.
5. **Attestor preconditions (§2.3) are checked in one function**, `assertCanAttestClaim()`, used by every claim route. No inline copies.
6. **Message-byte check** on every submit (hash stored at prepare, keyed by idempotency key).
7. **Idempotency** on every submit, payout creation and retry.
8. **OTP rate limits:** 3 sends per phone per 10 min, 10 per phone per day, 20 per IP per hour; Twilio Verify enforces attempt limits on codes. Never store codes.
9. **No membership leaks:** claim OTP is sent for any number; `share` returns `not_on_payment` only after verification; public preview hides batch details.
10. **Cleva preview never collects Cleva credentials.** No fields for Cleva email, password, PIN or code anywhere in the app.
11. **Devnet guards:** demo funding, Cleva-preview funding, test mint authority and the mock OTP provider refuse to run unless `SOLANA_CLUSTER=devnet` (and, for mock OTP, `APP_ENV=local`).
12. **Demo limits:** 10 slots, $500 per slot, $1,000 per link, $1,000 outstanding per sender, $200/day demo funding.
13. **Phone data:** plaintext for the hackathon; production = encryption at rest + HMAC column for lookups.

---

## 8. Providers (behind interfaces)

```ts
type OtpChannel = 'sms' | 'whatsapp';
interface OtpProvider {
  send(phoneE164: string, channel: OtpChannel): Promise<void>;
  check(phoneE164: string, code: string): Promise<boolean>;
}
interface RateProvider {
  getRate(): Promise<{ ngnPerUsd: string; source: string; asOf: Date }>;
}
interface BankDirectory {
  listBanks(): Promise<Bank[]>;
  resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string }>;
}
interface PayoutProvider {
  createPayout(p: PayoutRequest): Promise<{ providerRef: string }>;
  verifyWebhook(req: Request): Promise<PayoutWebhookEvent | null>;
}
interface ClevaGateway {             // production: real partnership API
  getLinkedBalance(userId: string): Promise<string>;
}
```

| Provider | Hackathon | Production |
|---|---|---|
| OTP | `TwilioVerifyOtpProvider` (SMS + WhatsApp). `MockOtpProvider` (code `000000`) for **local dev only** | Same, with an approved WhatsApp sender |
| Rates | `MockRateProvider`: rate from env, 1% spread | Licensed partner feed |
| Banks | Static list + deterministic mock resolver | Partner / NIP name enquiry |
| Payouts | `MockPayoutProvider`: `processing` → `paid` after 4–8s via internal webhook; account numbers ending `0000` fail | Licensed partner (pitch: Cleva) |
| Cleva | `MockClevaGateway`: balance = devnet test USDT, labelled "preview" | Cleva partnership API |

**WhatsApp codes:** Twilio Verify's WhatsApp channel needs a WhatsApp sender connected to your Twilio account, and Meta reviews businesses (crypto and financial services face restrictions). Start the sender setup now. If it isn't approved by demo day, set `WHATSAPP_OTP_ENABLED=false` and the UI shows SMS only.

---

## 9. Environment variables

```
APP_ENV=local                    # local | preview | production
APP_BASE_URL=https://muuve.app
SOLANA_CLUSTER=devnet
SOLANA_RPC_URL=
SOLANA_RPC_URL_FALLBACK=
MUUVE_PROGRAM_ID=
USDT_MINT=
TREASURY_TOKEN_ACCOUNT=
FEE_PAYER_SECRET=
ATTESTOR_SECRET=
TREASURY_SECRET=
TEST_MINT_AUTHORITY_SECRET=
CLAIM_WINDOW_SECS=172800         # must match the on-chain Config
SESSION_SECRET=
AUTH_JWT_PRIVATE_KEY=            # signs Privy custom-auth JWTs
AUTH_JWT_KID=
NEXT_PUBLIC_PRIVY_APP_ID=
PRIVY_APP_SECRET=
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
OTP_PROVIDER=twilio              # twilio | mock (local only)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_VERIFY_SERVICE_SID=
WHATSAPP_OTP_ENABLED=false
PAYOUT_PROVIDER=mock
RATE_PROVIDER=mock
MOCK_NGN_PER_USD=1520
CRON_SECRET=
```

`.env.example` committed with empty values; real `.env*` files gitignored.

---

## 10. Scripts

| Script | Purpose |
|---|---|
| `scripts/create-test-mint.ts` | 6-decimal test USDT mint on devnet |
| `scripts/create-treasury.ts` | Treasury wallet + USDT token account |
| `scripts/init-config.ts` | `init_config` with attestor, treasury, limits, 48h window |
| `scripts/fund-fee-payer.ts` | Airdrop / top up the fee payer |
| `scripts/seed-demo.ts` | Demo users (one Cleva-preview sender), a pre-funded 3-person batch link, and a link 1 minute from expiry for testing |

---

## 11. Testing

| Layer | Tool | Must cover |
|---|---|---|
| Program | `anchor test` (localnet) | Everything in §3.5 |
| API | Vitest + test schema | Transition rules; `assertCanAttestClaim` (wrong phone, wrong link, expired, already claimed, keep with mismatched account phone); OTP rate limits; no membership leak; idempotency; message-byte check; devnet guards; failed-payout paths |
| E2E | Playwright on devnet (mock OTP in local runs) | Muuve sign-up; Cleva preview sign-up; single send → cash out; batch of 3 → cash out + keep + recall; number not on payment; failed payout → retry; failed payout → keep; expiry return |

CI runs program + API tests on every PR; E2E before each demo build.

---

## 12. Demo-day runbook

1. Fee payer ≥ 2 SOL; treasury funded with test USDT for retry/keep paths; both RPCs healthy.
2. Real SMS codes tested on two Nigerian numbers that morning; WhatsApp flag set to match sender approval.
3. `seed-demo.ts` run; backup pre-funded batch link ready.
4. Mock payout delay 4s.
5. Backup screen recording of the full flow on the laptop.
