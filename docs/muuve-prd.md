# Muuve — Product Requirements Document

**Version:** 0.2 (hackathon MVP)
**Event:** Cleva x Tether Future of Payments Hackathon, UNILAG Edition
**Application deadline:** 2 November 2026
**Owner:** Pascal Chukwu (Jack)
**Status:** Draft for team review

### What changed from v0.1
- **Two ways to sign up:** continue with Cleva, or create a Muuve account.
- **Claim verification by WhatsApp or SMS:** the recipient enters their number and picks where the code goes.
- **Cash-out needs no account:** after verifying, the recipient enters a bank account and the money goes from escrow straight to naira.
- **Keeping dollars needs a Muuve account:** created with the same verified number, and the money lands there.
- **48-hour escrow:** unclaimed money returns to the sender's wallet automatically.
- **Batch payment:** one link, many recipients, each with their own amount.

---

## 1. One-liner

**You don't send money to an account. You send it to a person.**

Muuve lets someone abroad turn dollars into a **claim link** and share it in WhatsApp. The recipient opens the link, verifies their number with a code by **WhatsApp or SMS**, and either **cashes out straight to any Nigerian bank or OPay account** or **keeps it in dollars** in a Muuve account. Unclaimed money goes back to the sender after **48 hours**. One link can pay **one person or a whole family**.

---

## 2. Problem

Sending money home to Nigeria still assumes the sender has the recipient's exact bank details and that the recipient wants naira immediately.

| Pain | Who feels it | What happens today |
|---|---|---|
| Sender needs exact bank details | Sender abroad | Asks family to resend account numbers, waits, sometimes uses an old account |
| Wrong details are permanent | Sender | Mistyped account = money usually gone, long dispute |
| Paying several people is several transfers | Sender | Separate transfers, separate fees, separate chats every payday |
| Money lands as naira immediately | Recipient | Value erodes while they wait to spend it; no choice to hold dollars |
| Recipient must already be onboarded | Recipient | Many relatives (parents, older traders) never install fintech apps |

**Core insight:** the recipient should not have to prepare anything before money arrives. The sender only needs a phone number, and the recipient decides where the money goes when they claim it.

---

## 3. Solution

1. **Sender signs up** with Cleva or with a new Muuve account.
2. **Sender funds dollars** (USDT on Solana under the hood).
3. Sender creates a link for **one recipient or a batch**, entering each recipient's phone number (usually their WhatsApp number) and amount.
4. Muuve locks the total in an **on-chain escrow for 48 hours** and returns **one link**.
5. Sender **shares the link** in WhatsApp (a private chat or a family group).
6. Each recipient opens the link, **enters their number**, and receives a code by **WhatsApp or SMS**.
7. After verifying, the recipient sees their amount and chooses:
   - **Cash out** → enters bank or OPay account details → escrow releases to Muuve's licensed payout partner → **naira lands in their account**. No Muuve account needed.
   - **Keep in dollars** → **creates a Muuve account with that same number** → the USDT moves from escrow into their Muuve balance.
8. Anything unclaimed after 48 hours **returns to the sender's wallet automatically**. The sender can also recall unclaimed money earlier.

Crypto stays invisible to recipients. They never see a seed phrase, a gas fee, or a wallet address.

---

## 4. Why stablecoins (the "why not just use a remittance app" answer)

- **A link can hold money.** A bank transfer can't sit waiting for a person to show up; an on-chain escrow can, safely and verifiably.
- **Recall and auto-refund are native.** Unclaimed money returns to the sender by rule, not by dispute.
- **One link, many people.** A single escrow holds every recipient's share and releases each one separately.
- **Dollars without a dollar account.** A recipient who keeps their money holds USDT the moment they claim.
- **Cheap and instant.** Solana settlement is seconds and fractions of a cent, so small family transfers make sense.
- **Tether alignment.** USDT is the stablecoin Nigerians already use most.

---

## 5. Positioning with Cleva

Muuve is designed as an **extension of Cleva**, not a competitor.

- **Continue with Cleva:** Cleva users sign in with their Cleva account and send from their Cleva USD balance. *(Hackathon: a clearly labelled partnership preview. See §8.3.)*
- **Or create a Muuve account:** anyone without Cleva can still use Muuve.
- Cleva already moves dollars between the US and Nigeria and pays out to naira accounts. Muuve adds the **claim layer**: send to **anyone with a phone number**, to **several people at once**, with **auto-refund**.
- Every recipient who keeps dollars becomes a **new dollar-account user**.
- Cleva (licensed IMTO) is the natural **production payout and on-ramp partner**.

**Pitch framing:** "Muuve turns every Cleva balance into a link anyone can claim, and every claim into a new customer."

---

## 6. Users and personas

### 6.1 Musa — the sender
- 31, warehouse supervisor in Houston. Has a Cleva account.
- Every payday sends money to his mother, his younger brother and his uncle.
- Wants: one action instead of three transfers, no chasing bank details, confidence the right person gets it.

### 6.2 Hajiya Aisha — the cash-out recipient
- Musa's mother, sells foodstuffs in Kano.
- Uses WhatsApp and OPay daily; has never installed a dollar app.
- Wants: naira in her OPay, fast, with no app to install and no account to create.

### 6.3 Yusuf — the saver recipient
- Musa's brother, 200-level student at Bayero University.
- Fees due in two months; worried about the naira falling.
- Wants: to keep dollars and cash out later.

### 6.4 Uncle Sani — the one who forgets
- Opens WhatsApp once a day, sometimes less.
- Represents the 48-hour expiry case: if he doesn't claim, the money must go back to Musa safely.

---

## 7. User stories

### Sign-up and funding
- **A1.** As a new user, I can choose **Continue with Cleva** or **Create a Muuve account**.
- **A2.** As a Muuve account user, I sign up with my phone number and a code sent by **WhatsApp or SMS** (my choice), plus my name.
- **A3.** As a Cleva user, I approve Muuve on a Cleva screen and my sending balance comes from Cleva. *(Mock in hackathon.)*
- **A4.** As a sender, I can add dollars (demo: test dollars; production: Cleva balance or card via partner).

### Sending
- **S1.** As a sender, I can send to **one person**: amount, phone number, optional note.
- **S2.** As a sender, I can tap **Batch payment**, choose **how many people** (2–10), enter each **phone number and amount**, and add an optional note.
- **S3.** As a sender, I can tap **Split equally** to divide a total across the batch.
- **S4.** As a sender, I see a review with each recipient, the total, and that unclaimed money returns in **48 hours**.
- **S5.** As a sender, I get **one link** for the whole payment and can share it to WhatsApp in one tap.
- **S6.** As a sender, I can see each recipient's status: waiting, cashed out, kept in dollars, recalled, returned.
- **S7.** As a sender, I can recall money for **one recipient** or **everyone who hasn't claimed**.
- **S8.** As a sender, I see a reminder when a link is 24 hours old and someone hasn't claimed, with a **Share again** button.
- **S9.** As a sender, unclaimed money returns to my wallet automatically after 48 hours, and I'm told it happened.

### Claiming
- **R1.** As a recipient, I can open a link on any phone browser without installing anything.
- **R2.** As a recipient, I see who sent money and their note before doing anything.
- **R3.** As a recipient, I enter **my phone number** and choose to get the code by **WhatsApp or SMS**.
- **R4.** As a recipient, after entering the code I see **my amount**. On a batch link I never see other people's amounts or numbers.
- **R5.** As a recipient, I can choose **Cash out to bank or OPay** or **Keep in dollars**.
- **R6.** As a recipient cashing out, I enter my bank and account number, see the **account name** and the **exact naira amount and rate**, and confirm. No Muuve account needed.
- **R7.** As a recipient keeping dollars, I'm asked to **create a Muuve account** with the number I just verified (no second code), and the money lands in my balance.
- **R8.** As a recipient who already has a Muuve account on that number, **Keep in dollars** goes straight to my balance.
- **R9.** As a recipient, I see a clear message if my number isn't on this payment, or if my money was already claimed, recalled or returned.
- **R10.** As a recipient whose cash-out fails (wrong account, bank down), I can **try another account** or **keep in dollars** instead.

### System
- **X1.** Escrow holds money for **48 hours** from creation; anything unclaimed then returns to the sender's wallet automatically.
- **X2.** Nobody needs SOL; Muuve pays network fees.
- **X3.** Claiming needs **both** the link and a verified code to the right number. Having just one isn't enough.
- **X4.** Each phone number can appear **once** per link.

---

## 8. Scope

### 8.1 MVP (must ship for the pitch)
| # | Feature | Notes |
|---|---|---|
| M1 | Muuve sign-up | Phone + OTP (WhatsApp or SMS) + name; embedded wallet created silently |
| M2 | Continue with Cleva | Partnership preview screen (see §8.3) that leads into the same account setup |
| M3 | Funding | Demo "Add test dollars"; "Fund from Cleva balance" as a styled mock |
| M4 | Single send | Amount, phone, note |
| M5 | Batch send | 2–10 recipients, per-person amounts, split equally, one link |
| M6 | On-chain escrow | Anchor program with per-recipient slots, 48h window, claim / recall / expire |
| M7 | Share to WhatsApp | `wa.me` share with prefilled message |
| M8 | Claim verification | Enter number → choose WhatsApp or SMS → code |
| M9 | Cash out from escrow | Bank/OPay resolve, 60s rate lock, escrow → treasury → mock naira payout |
| M10 | Keep in dollars | Create Muuve account with the verified number → escrow → their wallet |
| M11 | Recall | Per recipient or all unclaimed |
| M12 | Auto-return | Scheduled job returns unclaimed money after 48h |
| M13 | Activity | Per-link, per-recipient status for senders; balance and history for account holders |
| M14 | Cash out held dollars | Account holders cash out their balance later |
| M15 | Gas sponsorship | Backend fee payer on every transaction |

### 8.2 Stretch (only if MVP is solid)
- Pidgin and Hausa copy on the claim page.
- Real payout partner in sandbox mode behind the same interface.
- Shareable receipt image for the sender after each claim.
- Saved recipients ("Mama", "Yusuf") for repeat batches.

### 8.3 The Cleva option in the hackathon
There's no public "Sign in with Cleva" for outside apps today, so the hackathon version is a **partnership preview**:
- The button reads **Continue with Cleva** and opens a screen labelled **"Partnership preview"** explaining what a real integration would do.
- It **never asks for a Cleva email, password, PIN or code**, and doesn't copy Cleva's logo or app design.
- Tapping Continue leads into the normal Muuve phone verification, then marks the account as a Cleva-linked demo account with a mock "Cleva balance" for funding.
- In the pitch: "With a partnership, this screen becomes a real Cleva approval, and Musa sends straight from his Cleva USD balance."

### 8.4 Non-goals
- A WhatsApp **bot** or chat-based sending. WhatsApp is only used to **share links** (from the user's own chats) and to **deliver verification codes**.
- Real card on-ramp or real naira payouts during the hackathon.
- Multi-currency (GBP, EUR, CAD). USD only.
- Yield on held balances.
- Native mobile apps. Mobile web only.

---

## 9. Key flows

### 9.1 Sign up
1. Landing → **Get started** → two cards: **Continue with Cleva** / **Create a Muuve account**.
2. Muuve: phone number → choose **WhatsApp** or **SMS** → code → name → home.
3. Cleva: partnership preview → Continue → phone verification (same as above) → home, with "Cleva balance (demo)" as the funding source.

### 9.2 Single send
1. Home → **Send** → amount → recipient phone (+234 default) → optional note.
2. Review: amount, recipient, "Returns to you if not claimed in 48 hours".
3. Confirm → escrow funded → share screen with **Share on WhatsApp** and **Copy link**.

### 9.3 Batch send
1. Home → **Batch payment** → choose how many people (2–10).
2. One row per person: phone number, amount, optional private label ("Mama"). **Split equally** helper. Running total shown.
3. Validation: valid numbers, no duplicates, each amount within limits, total ≤ balance.
4. Review: list of recipients, total, 48-hour notice.
5. Confirm → one escrow, one link → share to a family group or to each person.

### 9.4 Claim — cash out (Hajiya Aisha)
1. Opens `muuve.app/c/{linkId}#k={secret}` → "Musa sent you money" + note.
2. Enters her number → chooses **WhatsApp** → enters the code.
3. Sees **"Your share: $120"** → taps **Cash out to bank or OPay**.
4. Picks OPay → enters account number → sees her account name → sees **₦182,400 at ₦1,520 per $1, locked for 0:60** → **Confirm**.
5. Status: Releasing → Sending to OPay → **Paid ✓** with reference. Done. No account created.

### 9.5 Claim — keep in dollars (Yusuf)
1. Same as 9.4 steps 1–2 (he picks **SMS**).
2. Sees **"Your share: $80"** → taps **Keep in dollars**.
3. Screen: "To keep dollars, create your Muuve account." His verified number is shown and locked. Enters his name → **Create account**.
4. The $80 moves into his Muuve balance. He can cash out later from the app.
5. If he already had a Muuve account on that number, step 3 is skipped.

### 9.6 Failed cash-out
1. Payout fails (e.g. account closed).
2. Recipient sees "We couldn't send to that account. Your $120 is safe."
3. Options: **Try another account** or **Keep in dollars** (create account).
4. If the recipient does nothing for 48 hours after the failure, the money returns to the sender.

### 9.7 Recall
1. Sender → Activity → link → recipient row → **Recall**, or **Recall all unclaimed**.
2. Money returns to the sender's balance; that recipient now sees "The sender cancelled this payment."

### 9.8 48-hour return (Uncle Sani)
1. At 24 hours, Musa sees "Uncle Sani hasn't claimed yet" + **Share again**.
2. At 48 hours, the scheduled job returns Sani's share to Musa's wallet.
3. Sani's claim page: "This money was returned to the sender. Ask them to send it again."

---

## 10. Security model (summary)

Owner clarification: phone numbers, labels and bank details stay off-chain. Payment
allocations and slot statuses are public on-chain; recipient API privacy does not
make those values confidential. Recipient priority starts at confirmed on-chain
claim intent and is bounded; see [approved decisions](backend-decisions.md).

Claiming needs **two independent proofs**:
1. **The link secret** — the `#k=` part of the URL. It's never sent to Muuve's servers, so Muuve itself can't claim the money.
2. **A verified code to a number on the payment** — the backend co-signs a claim only for the share belonging to the number that was just verified, and only to the destination the recipient chose (their own Muuve wallet, or the payout treasury for a cash-out with a recorded bank account).

Consequences:
- Link forwarded to the wrong person → can't claim (their number isn't on the payment).
- One batch recipient → can only claim their own share and never sees anyone else's.
- Leaked database → can't claim (no link secrets stored).
- Only the sender can recall. Anyone can trigger the 48-hour return, but it only ever pays the sender.

Details in `muuve-backend-guide.md`.

---

## 11. Success metrics

### Demo (what judges see)
- A judge claims on their own phone in **under 45 seconds**, including the WhatsApp code.
- One batch link pays **three people** live on stage.
- Recall completes in **under 5 seconds**.
- Zero crypto words on recipient screens.

### Product (production)
- Share of recipients who claim within 24h and within 48h.
- **Cash out vs keep in dollars** split.
- Recipient → sender conversion (recipients who later send).
- Average recipients per batch link.
- Auto-return rate (signals links sent to people who don't respond).
- WhatsApp vs SMS code choice and delivery success rate.

---

## 12. Pitch demo script (target: 3 minutes)

1. **Hook (20s):** "Musa pays his mum, his brother and his uncle every payday. Today that's three transfers and three sets of bank details. Watch him do it with one link."
2. **Sign-in (15s):** Continue with Cleva (partnership preview) → home with balance.
3. **Batch send (35s):** Batch payment → 3 people → amounts → one link → shared to a WhatsApp group.
4. **Claim — cash out (40s):** A judge opens the link, gets the code on WhatsApp, cashes out to OPay → **Paid**.
5. **Claim — keep (25s):** Second phone keeps dollars, creates an account in one screen.
6. **Safety (20s):** Third recipient "doesn't claim" → show recall (or the 48-hour return rule).
7. **Why Cleva wins (15s):** every link is a new dollar-account customer.
8. **Close (10s):** "You don't send money to an account. You send it to a person."

---

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Hackathon may be UNILAG-only | **Confirm eligibility first** via the Luma page or organisers. |
| WhatsApp codes need an approved WhatsApp sender; Meta restricts some crypto/financial businesses | SMS always works. WhatsApp is behind a feature flag; if the sender isn't approved by demo day, the WhatsApp option is hidden. |
| "Continue with Cleva" looks like a real Cleva login | Labelled "Partnership preview", no credential fields, no copied branding. |
| 48 hours is short for some relatives | 24-hour reminder for the sender with **Share again**; auto-return means nothing is lost. |
| Naira payouts need a licence | Payouts behind a provider interface; production via a licensed partner (pitch Cleva). |
| Cash-out failure after money leaves escrow | Funds held in treasury, recipient can retry or keep; auto-return to sender after 48h. |
| Regulatory treatment of USDT in Nigeria | Position as compliance-first; reference the CBN sandbox and planned stablecoin pilots for low-value remittances. |
| Batch link shared in a big group | Only listed numbers can claim; others see "This number isn't on this payment." |
| Phishing ("fake Muuve links") | Fixed domain, sender's verified name on the claim page, education copy. |
| Demo network failure | Pre-funded links, fallback RPC, recorded backup video. |

---

## 14. Milestones

| Date | Milestone |
|---|---|
| 28 Oct | Docs v0.2 approved; repo set up |
| 29 Oct | Escrow program with slots + 48h window passing all tests on localnet |
| 30 Oct | Auth (phone OTP, WhatsApp/SMS), link create (single + batch), public preview |
| 31 Oct | Claim flows on devnet: cash out (mock payout) and keep (account creation) |
| 1 Nov | Recall, auto-return job, Cleva preview, activity; demo video recorded |
| 2 Nov | **Application submitted** with demo video and deck |
| After shortlist | Polish, stretch features, rehearse live pitch |

---

## 15. Open questions

1. Are non-UNILAG students eligible?
2. Does the application need a working demo or only a concept?
3. Do we name Cleva as a partner in the pitch, or say "a licensed partner such as Cleva"?
4. Team roles and size limits?
5. Is 10 the right maximum for a batch?
6. Can we get an approved WhatsApp sender in time, or do we demo with SMS?

---

## 16. Related docs
- `muuve-frontend-guide.md` — screens, design system, frontend architecture
- `muuve-backend-guide.md` — API, data model, Solana program, security
- `muuve-ai-agent-practices.md` — how the team uses AI coding agents on this repo
