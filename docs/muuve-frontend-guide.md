# Muuve — Frontend Guide

**Version:** 0.2. Read `muuve-prd.md` first. This guide covers how the web app is built, every screen and state, the design system, and the rules every screen follows.

---

## 1. Stack

| Concern | Choice |
|---|---|
| Framework | **Next.js (App Router)** + React + TypeScript (strict) |
| Styling | **Tailwind CSS** with design tokens as CSS variables |
| Motion | **GSAP** for hero and celebration moments; CSS transitions elsewhere |
| Auth | **Our own** phone OTP (WhatsApp or SMS) via `/api/auth/*`; sessions are httpOnly cookies set by the server |
| Wallets | **Privy** embedded Solana wallets with custom auth (token from `/api/auth/privy-token`) |
| Solana | `@solana/web3.js`, `@coral-xyz/anchor` (IDL types), `@solana/spl-token` |
| Data | TanStack Query against our `/api/*` routes |
| Forms | React Hook Form + Zod (shared schemas from `packages/shared`) |
| Phone input | `libphonenumber-js`; always send E.164 |
| Icons | Lucide |
| Deploy | Vercel |

The frontend never talks to the database, never holds server secrets, and never reads auth cookies (they're httpOnly). Ask the API.

---

## 2. Repo layout

```
muuve/
├─ apps/web/
│  ├─ app/
│  │  ├─ (marketing)/page.tsx            # landing
│  │  ├─ start/page.tsx                  # choose: Continue with Cleva / Create Muuve account
│  │  ├─ start/cleva/page.tsx            # partnership preview
│  │  ├─ start/verify/page.tsx           # phone → channel → code (shared by both paths)
│  │  ├─ start/name/page.tsx             # display name → create account → wallet
│  │  ├─ login/page.tsx                  # existing users: phone → code
│  │  ├─ (app)/home/page.tsx             # balance + actions
│  │  ├─ (app)/fund/page.tsx             # demo / Cleva-preview funding
│  │  ├─ (app)/send/page.tsx             # single send
│  │  ├─ (app)/send/batch/page.tsx       # batch send
│  │  ├─ (app)/send/[id]/page.tsx        # share screen
│  │  ├─ (app)/activity/page.tsx         # links + received money
│  │  ├─ (app)/activity/[id]/page.tsx    # link detail, per-recipient status, recall
│  │  ├─ (app)/cashout/page.tsx          # cash out held dollars
│  │  ├─ c/[id]/page.tsx                 # PUBLIC claim page (lightweight)
│  │  └─ api/...                         # backend (see backend guide)
│  ├─ components/
│  │  ├─ ui/       # GlassCard, Button, Input, Sheet, Toast, Stepper, ChannelPicker, OtpInput
│  │  ├─ money/    # AmountDisplay, RateQuote, StatusPill, ExpiryCountdown
│  │  └─ flows/    # SignupFlow, SendFlow, BatchFlow, ClaimFlow, CashoutFlow
│  ├─ lib/
│  │  ├─ api.ts          # typed fetch client (credentials: 'include')
│  │  ├─ solana.ts       # connection, tx (de)serialization
│  │  ├─ privy.ts        # lazy Privy loader + custom-auth login + wallet linking
│  │  ├─ claim-key.ts    # derive (sender) and parse (recipient) the claim key
│  │  ├─ split.ts        # split-equally in base units
│  │  └─ format.ts       # money, phone, durations
│  └─ styles/tokens.css
├─ programs/muuve_escrow/
└─ packages/shared/      # Zod schemas, enums, limits, IDL
```

---

## 3. Screens

| Route | Who | Purpose | Key components |
|---|---|---|---|
| `/` | Everyone | Pitch line, how it works, **Get started** | Hero, HowItWorks |
| `/start` | New user | Two cards: **Continue with Cleva** / **Create a Muuve account**; link to log in | ChoiceCard |
| `/start/cleva` | New user | Partnership preview (§5) | PreviewBadge, Explainer, Continue |
| `/start/verify` | New user | Phone → WhatsApp or SMS → code | PhoneField, ChannelPicker, OtpInput |
| `/start/name` | New user | Display name → create account → create wallet | NameField |
| `/login` | Returning | Phone → channel → code | same as verify |
| `/home` | Signed in | Balance, **Send**, **Batch payment**, **Add money**, **Cash out**, reminders | BalanceCard, ActionRow, ReminderBanner |
| `/fund` | Signed in | "Add test dollars" or "Fund from Cleva balance (preview)" | FundSheet |
| `/send` | Sender | Amount → recipient → note → review | AmountPad, PhoneField, NoteField, ReviewCard |
| `/send/batch` | Sender | Count → rows → review (§6) | Stepper, RecipientRow, SplitSheet, BatchReview |
| `/send/[id]` | Sender | One link, share | LinkCard, ShareWhatsAppButton, CopyButton, ExpiryCountdown |
| `/activity` | Signed in | Links sent + money received | LinkRow, StatusPill |
| `/activity/[id]` | Sender | Per-recipient status, **Recall** one / **Recall all unclaimed**, **Share again** | RecipientStatusList, RecallSheet |
| `/cashout` | Account holder | Cash out balance to bank/OPay | BankPicker, AccountField, RateQuote |
| `/c/[id]` | Public | **Claim** (§4) | see claim steps |

### 3.1 Slot status → UI (sender view)

| `slot.status` | Label | Tone |
|---|---|---|
| `funded` | Waiting · returns in {h}h | amber |
| `cashing_out` | Cashing out… | amber |
| `cashed_out` | Cashed out | green |
| `kept` | Kept in dollars | green |
| `recalled` | Recalled | neutral |
| `returned` | Returned to you | neutral |

`pending` slots are never shown. A link row shows a summary: "2 of 3 claimed · 1 waiting".

### 3.2 Payout status → UI

| `payout.status` | Label |
|---|---|
| `quoted` | Rate locked · {countdown} |
| `transferring` | Releasing your money… |
| `processing` | Sending naira to {bank} |
| `paid` | Paid ✓ · ref {provider_ref} |
| `failed` | We couldn't send to that account. Your money is safe. |
| `resolved` | By resolution: Sent to another account / Kept in dollars / Returned to your balance / Returned to the sender |

All enums and limits come from `packages/shared`. **Never hardcode status strings in components.**

---

## 4. The claim page (`/c/[id]`)

The most important screen. Hajiya Aisha opens it on a mid-range Android phone, maybe on 3G, maybe for the first time. Uncle Sani might open it from a family group.

### 4.1 Rules
1. **Light first load.** No aurora canvas, no GSAP, no Privy on first render. Route budget **150 KB JS**. Load Privy **only** on the Keep path.
2. **Large type, one action per screen.** Body ≥ 18px, tap targets ≥ 48px.
3. **No crypto words.** Never show: wallet, USDT, Solana, gas, address, signature, seed, escrow. Say "dollars", "your Muuve balance", "cash out".
4. **Read the secret from the fragment only.** Take `k` from `window.location.hash`, keep it in memory, then remove it from the URL bar with `history.replaceState`. Never put it in query strings, analytics, logs, error reports or storage.
5. **Server-render the preview** (sender name, note, amount for single links, expiry) so first paint and WhatsApp's link preview are instant.
6. **Never show other recipients.** On a batch link, no counts, names, numbers or amounts before or after verification, except the user's own share.
7. **Friendly terminal states** for: number not on this payment, already received, cancelled by sender, returned to sender, link not found.

### 4.2 Steps

| # | Step | What happens |
|---|---|---|
| 1 | `ClaimPreview` | Single: "Musa sent you $80". Batch: "Musa sent you money". Note, expiry ("Available for 41 more hours"), **Continue** |
| 2 | `PhoneStep` | "Enter the number Musa sent this to." Phone field (+234 default) and two big chips: **WhatsApp** / **SMS** (WhatsApp hidden if disabled). **Send code** |
| 3 | `OtpStep` | 6-digit code, auto-advance, **Resend** after 30s, **Use SMS instead** link when WhatsApp was chosen |
| 4 | `ShareStep` | Fetch `/api/claims/:id/share`. Shows **"Your share: $120"** and two cards: **Cash out to bank or OPay** / **Keep in dollars**. If `not_on_payment`: terminal state with **Try another number** |
| 5a | `CashoutStep` | Bank picker (OPay, PalmPay, Moniepoint, Kuda first) → 10-digit account → resolved account name (must be visible before Confirm) → rate quote with 60s lock → **Confirm** |
| 6a | `CashoutStatus` | Polls the payout: Releasing → Sending → **Paid ✓**. On `failed`: **Try another account** (back to 5a with `retry_of`) or **Keep in dollars** (to 5b) |
| 5b | `KeepStep` | If an account exists for this number (verify set the session): skip to claim. Otherwise "To keep dollars, create your Muuve account": verified number shown **locked**, name field, **Create account**. No second code |
| 6b | `KeepClaim` | Lazy-load Privy → custom-auth login → wallet created → `POST /api/auth/wallet` → prepare/sign/submit `keep` → done |
| 7 | `Result` | Celebration (GSAP allowed here). Cash out: naira amount + reference. Keep: new balance + **Open Muuve** |

---

## 5. Sign-up

### 5.1 `/start`
Two equal glass cards:
- **Continue with Cleva** — "Already use Cleva? Send from your Cleva balance."
- **Create a Muuve account** — "New here? Sign up with your phone number."

Plus "Already have a Muuve account? **Log in**".

### 5.2 `/start/cleva` — partnership preview
- Top badge: **Partnership preview**.
- Copy: "With a Cleva partnership, you'd approve Muuve here and send straight from your Cleva USD balance. For this demo, we'll set up your account with your phone number and give you a preview balance."
- **Continue** → `/start/verify?origin=cleva_preview`.
- **Hard rules:** no Cleva logo or copied Cleva design, and **no fields for a Cleva email, password, PIN or code**. Nothing on this screen should look like a real Cleva login.

### 5.3 `/start/verify` → `/start/name`
1. Phone field (country selector, US and NG first), channel chips (**WhatsApp** / **SMS**), **Send code**.
2. Code → `POST /api/auth/otp/verify` (`purpose: 'account'`). Existing user → `/home`. New → `/start/name`.
3. Name → `POST /api/auth/signup` with `origin` → wallet setup (§8.1) → `/home`.

---

## 6. Batch payment (`/send/batch`)

### 6.1 Steps
1. **How many people?** Stepper 2–10 (large +/− buttons).
2. **Recipients:** one `RecipientRow` per person: phone (with country), amount, optional private label ("Mama"). On supported Android browsers, offer a contact picker (`navigator.contacts`) as a progressive enhancement.
3. **Split equally:** sheet asks for a total and divides it (§6.2). Amounts stay editable after.
4. **Note** (optional, shared by everyone on the link).
5. **Review:** every row, total, balance after, and "Anything not claimed in 48 hours returns to you."
6. **Confirm** → create link → `/send/[id]`.

### 6.2 Split equally (`lib/split.ts`)
- Work in base units (strings → `bigint`).
- `each = total / n`; `remainder = total % n`; add 1 base unit to the first `remainder` rows.
- Display with `formatUsd`. Never use floats.

### 6.3 Validation (inline, per row)
- Valid number for the chosen country.
- **No duplicates** (highlight both rows: "This number is already on the list").
- Not the sender's own number.
- Amount > 0 and ≤ per-person limit.
- Total ≤ per-link limit and ≤ balance; show the remaining balance live.

### 6.4 Share screen for batches
- One link card, the list of recipients below it (labels or masked numbers) so the sender knows who it's for.
- **Share on WhatsApp** opens the chooser so the sender can post to a family group or send to each person.

---

## 7. Design system

Dark, cinematic liquid glass for the landing page and signed-in app; a **calmer, lighter variant** on the claim page.

### 7.1 Tokens (`styles/tokens.css`)

```css
:root {
  --bg: #07070b;
  --bg-elev: #0e0e15;
  --glass-fill: rgba(255, 255, 255, 0.06);
  --glass-border: rgba(255, 255, 255, 0.14);
  --glass-specular: rgba(255, 255, 255, 0.35);

  --text: #f4f4f7;
  --text-muted: #a3a3b2;
  --text-faint: #6b6b7b;

  --aurora-violet: #7c5cff;
  --aurora-pink: #ff5ca8;
  --aurora-cyan: #3fd6ff;
  --aurora-amber: #ffb547;

  --money: #4ade80;
  --pending: #ffb547;
  --danger: #ff5c5c;
  --whatsapp: #25d366;      /* channel chip accent only */

  --radius-card: 24px;
  --radius-control: 14px;
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
}
```

### 7.2 Glass card

```css
.glass {
  background: var(--glass-fill);
  backdrop-filter: blur(12px) saturate(140%);
  -webkit-backdrop-filter: blur(12px) saturate(140%);
  border: 0.5px solid var(--glass-border);
  border-radius: var(--radius-card);
  box-shadow: inset 0 1px 0 var(--glass-specular);
}
@supports not (backdrop-filter: blur(1px)) {
  .glass { background: var(--bg-elev); }
}
```

- Never heavy blur or solid fills on cards.
- Background: animated aurora blobs (~72px blur) + grain + vignette on a `<canvas>`. **Off on `/c/[id]`** and when `prefers-reduced-motion: reduce`.

### 7.3 Typography
- **Space Grotesk**: headings, hero amounts.
- **JetBrains Mono**: data (amounts in lists, rates, references, masked numbers, countdowns).
- System font stack for body text on the claim page.
- Amounts use `font-variant-numeric: tabular-nums`.

### 7.4 Motion
- Transitions 200–300ms with `--ease-out`.
- GSAP only for: landing hero, link-created moment, claim success, payout `paid`.
- Respect `prefers-reduced-motion` everywhere.

### 7.5 Accessibility
- Text on glass ≥ 4.5:1 contrast (test over the brightest aurora color).
- Keyboard reachable with visible focus.
- OTP: `autocomplete="one-time-code"`, `inputmode="numeric"`.
- Phone: `type="tel"`, `autocomplete="tel"`.
- Channel chips are a radio group with labels, not color alone.

---

## 8. Wallets and transactions

### 8.1 Wallet setup (after account creation or login)
1. `GET /api/auth/privy-token` → Privy custom-auth login.
2. Privy creates or loads the embedded Solana wallet.
3. If the user has no linked wallet yet, `POST /api/auth/wallet { wallet_address }`.
4. Users never see any of this. Show "Setting up your account…" at most.

### 8.2 Prepare → sign → submit
1. `POST …/prepare` returns a base64 transaction already signed by the fee payer (and the attestor for claims).
2. Add the one client signature:
   - **Sender wallet** for create link, recall and wallet cash-outs.
   - **Claim key only** for claims (cash-out and keep). The recipient's wallet is only a destination.
3. `POST …/submit` with the signed transaction and an `idempotency_key` (generate once per attempt, reuse on retry).
4. Trust the state the API returns, not local assumptions.

Never build or modify a transaction on the client from user input.

### 8.3 Claim key (`lib/claim-key.ts`)

**Sender side (create and re-share):**
1. `link_id_hex` = 16 random bytes (`crypto.getRandomValues`).
2. Embedded wallet signs `muuve-claim-v1:{link_id_hex}`.
3. `seed = sha256(signature)` → `Keypair.fromSeed(seed)`.
4. Send only `claim_pubkey` + `link_id_hex` to `/api/links/prepare`.
5. To share or re-share, derive again and build `#k=`. Nothing is stored.

**Recipient side:**
- Parse `#k=` (base58 secret key), keep it in a module variable or ref (never storage or serializable state), use it only to sign the prepared claim, clear it after success.

---

## 9. Sharing

Use `navigator.share` when available, with **Share on WhatsApp** (`https://wa.me/?text=`) as the primary button.

| Kind | Message |
|---|---|
| Single | `Musa sent you $80 on Muuve 💸 Open it and verify your number to receive it. Available for 48 hours: {url}` |
| Batch | `Musa sent you money on Muuve 💸 Open it, verify your number and get your share. Available for 48 hours: {url}` |

- `{url}` = `https://muuve.app/c/{id}#k={secret}`.
- The Open Graph image for `/c/[id]` shows the sender's first name and, for single links only, the amount. Never batch details.

---

## 10. State and data

- TanStack Query keys: `['me']`, `['balance']`, `['links']`, `['link', id]`, `['claim-share', id]`, `['payout', id]`.
- Poll `['link', id]` every 5s on the link detail page while any slot is `funded` or `cashing_out`.
- Poll `['payout', id]` every 2s while non-terminal.
- `ExpiryCountdown` computes from `expires_at`; refetch when it hits zero.
- All responses parsed with the shared Zod schemas.
- No global client store unless a real need appears.

---

## 11. Errors and edge cases

| Situation | UI |
|---|---|
| Wrong code | Inline "That code isn't right." Show the provider's limit message in plain words if attempts run out |
| WhatsApp code not arriving | After 30s: **Resend** and **Send by SMS instead** |
| Number not on this payment | "This number isn't on this payment. Check with the sender." + **Try another number** |
| Already received (same number) | Show the outcome: "You cashed this out on Tue · ₦182,400" or "This is in your Muuve balance" |
| Recalled | "The sender cancelled this payment." |
| Returned after 48h | "This money went back to the sender. Ask them to send it again." |
| Quote expired | Re-quote automatically and highlight the new amount |
| Account doesn't resolve | "We couldn't find that account. Check the number and bank." |
| Payout failed | "We couldn't send to that account. Your money is safe." + **Try another account** / **Keep in dollars** |
| Network or RPC failure on submit | "Still confirming…" + retry with the same `idempotency_key` |
| Batch duplicate number | Highlight both rows |

All copy is human and non-technical. Technical details go to the console in dev only.

---

## 12. Performance budgets

| Route | JS budget | LCP target (mid-range Android, 4G) |
|---|---|---|
| `/c/[id]` before Keep | 150 KB | < 2.0s |
| `/c/[id]` Keep path | +Privy, loaded on demand | — |
| `/` | 250 KB | < 2.5s |
| App routes | 300 KB | < 2.5s |

Run Lighthouse before every demo build.

---

## 13. Definition of done (per screen)

- [ ] Matches the PRD flow and the states in §3.
- [ ] Uses tokens; no hardcoded colors.
- [ ] Works at 360px with no horizontal scroll.
- [ ] Loading, empty, error and terminal states designed.
- [ ] Reduced motion respected.
- [ ] No crypto words on recipient screens.
- [ ] Amounts go through the shared helpers; no floats.
- [ ] Batch screens never reveal other recipients to a recipient.
- [ ] Claim page tested on a real Android phone on a throttled connection, with both WhatsApp and SMS codes.
