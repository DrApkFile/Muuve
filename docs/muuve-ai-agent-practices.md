# Muuve — AI Agent Best Practices

**Version:** 0.2. How the team uses AI coding agents (Claude Code, Gemini CLI, Cursor, etc.) on the Muuve repo without shipping bugs, leaking keys, or losing a day to a confident wrong answer.

**The rule above all others:** the agent writes code, a human owns it. If you merge it, you can explain every line.

---

## 1. Source of truth

Agents work from the docs, not their own assumptions.

| Doc | Read it when… |
|---|---|
| `muuve-prd.md` | Building any feature or writing any copy |
| `muuve-frontend-guide.md` | Touching `apps/web/app`, `components`, styles |
| `muuve-backend-guide.md` | Touching `/api`, DB, providers, auth, `programs/` |
| `packages/shared` | Using any status, enum, limit or schema |
| `CLAUDE.md` (root + per-folder) | Always (loaded automatically) |

If a plan contradicts a doc, **the doc wins** until a human updates it. Change the doc first, then the code.

---

## 2. CLAUDE.md setup

```
muuve/
├─ CLAUDE.md                         # project-wide rules (template below)
├─ apps/web/CLAUDE.md                # tokens, claim-page rules, batch privacy, Cleva preview rules
├─ apps/web/app/api/CLAUDE.md        # sessions, assertCanAttestClaim, idempotency, rate limits
├─ programs/muuve_escrow/CLAUDE.md   # Anchor rules, slot model, 48h window, "never deploy"
└─ CLAUDE.local.md                   # personal notes, gitignored
```

### Root `CLAUDE.md` template

```md
# Muuve

Claim-link payments. A sender funds USDT into an on-chain escrow link with 1–10 recipient
slots (single or batch). Each recipient opens the same link, verifies their phone by
WhatsApp or SMS code, then either cashes out to a Nigerian bank (escrow → treasury → payout,
no account needed) or keeps dollars (creates a Muuve account with the same number, escrow →
their wallet). Unclaimed slots return to the sender after 48 hours. Sign-up is Muuve phone
account or "Continue with Cleva" (a partnership preview, mock only). Hackathon MVP on devnet.

## Read first
- muuve-prd.md, muuve-frontend-guide.md, muuve-backend-guide.md

## Commands
- Install: pnpm i
- Dev: pnpm dev
- Program tests: pnpm test:program   (anchor test)
- API tests: pnpm test:api
- E2E: pnpm test:e2e
- Typecheck + lint: pnpm check

## Hard rules
- Never read, print, or edit .env files. Use .env.example for names only.
- Never deploy programs or run anything against mainnet.
- Never commit keypairs (keys/, *.json keypairs, id.json).
- Amounts are integer base-unit strings (USDT = 6 decimals). No floats for money.
- Status strings and limits come from packages/shared.
- No crypto words on recipient-facing screens.
- Never log the #k= secret, OTP codes, full phone numbers or account numbers.
- Every claim route uses assertCanAttestClaim(). No inline copies of that logic.
- Batch claim screens never reveal other recipients.
- The Cleva preview never asks for Cleva credentials and never copies Cleva branding.
- Run `pnpm check` and the relevant tests before saying a task is done.
```

---

## 3. Giving an agent a task

### Size
One task = one reviewable PR, roughly **< 300 lines changed**.
- Too big: "Build the claim flow."
- Right: "Build `PhoneStep` with the WhatsApp/SMS channel chips and the disabled-WhatsApp state."
- Right: "Add `recall_slot` to the program with its success and `NotSender` tests."

### Prompt template

```
Goal: <one sentence, user-visible outcome>
Context: <doc sections and files, e.g. backend guide §5.5, frontend guide §4.2>
Constraints: <no floats, use tokens, use assertCanAttestClaim, don't touch X>
Done when: <tests pass / states render / command succeeds>
Out of scope: <what NOT to touch>
```

### Plan before code
For anything touching **the program, money math, auth/sessions/OTP, the attestor, payouts, or the claim flow**: ask for a plan first (plan mode), read it, correct it, then let it implement.

### Ask for evidence
End prompts with: *"When done, list the commands you ran and their output, and any assumption you made that isn't in the docs."*

---

## 4. Zones of trust

| Zone | Agent freedom | Human review |
|---|---|---|
| UI components, styling, copy | High | Visual check at 360px + real phone |
| Batch form, split-equally, validation | Medium | Unit tests for rounding, duplicates, limits |
| API route handlers | Medium | Every line; auth, validation, idempotency |
| Sessions, OTP, Privy custom auth | **Low** | Human approves design; tests for rate limits, cookie flags, session scoping |
| `assertCanAttestClaim`, payouts, failed-payout paths | **Low** | Human writes or reviews line by line; full test matrix |
| DB migrations | Low | Human approves; never auto-run on a shared DB |
| Money math, formatting | Low | Edge-case tests (0, max, remainders, rounding) |
| `programs/muuve_escrow` | **Very low** | Two humans; all backend guide §3.5 tests pass |
| Keys, env, deploys, CI secrets, Twilio/WhatsApp sender setup | **None** | Humans only |

---

## 5. On-chain rules

1. Agents **may** write instructions and tests, explain errors, and suggest constraints.
2. Agents **may not** run `anchor deploy` / `solana program deploy`, change `declare_id!`, touch upgrade authority, or create keypairs that get committed.
3. Every instruction change ships with **failure-case tests**, not just the happy path.
4. Ask the agent to list every account in an instruction and **who signs it and why**. If it can't explain a constraint, the constraint is probably wrong.
5. Check by hand:
   - `slot_index < slot_count` on every slot instruction.
   - `claim_to_treasury` destination equals `config.treasury_token_account`.
   - `open_slots` decrements exactly once per slot and the vault closes only at zero.
   - `checked_add` / `checked_sub` on all amounts.
   - Missing signer checks (the most common agent bug).
6. **48-hour window:** test with a clock warp (bankrun or test-validator warp). Never "test" expiry by shortening the window in production config.
7. After any program change: regenerate the IDL, copy it to `packages/shared`, re-run API tests.

---

## 6. Security habits

- **Never paste secrets into a prompt:** keys, service-role key, session secret, Twilio credentials, real OTP codes, or real phone numbers. Use placeholders like `+2348000000001`.
- Deny agents access to `.env*`, `keys/`, `~/.config/solana/`.
- Watch for checks being "fixed" by deletion. Grep diffs for removed `require!`, `constraint`, `assertCanAttestClaim`, rate limits, cookie flags, and Zod validation.
- Never let an agent add `NEXT_PUBLIC_` to a secret to fix an undefined env error.
- Never let an agent make the mock OTP provider reachable outside `APP_ENV=local`.
- Check new dependencies: exact package name (typosquats are common around Solana) and download counts.
- After any claim-flow change, grep for the `#k=` secret, OTP codes and phone numbers in logs, analytics, error reporting and test snapshots.
- After any batch change, check that no API response or screen reachable by a recipient includes other slots.

---

## 7. Reviewing agent output

- [ ] Diff limited to the task (no surprise refactors).
- [ ] `pnpm check` and relevant tests pass, and you ran them yourself.
- [ ] Uses shared schemas, enums, limits, formatters and tokens.
- [ ] No hardcoded amounts, rates, colors, URLs, program IDs, or the 48h value (use `CLAIM_WINDOW_SECS` / config).
- [ ] Loading, error and terminal states exist.
- [ ] No secrets and no sensitive data in logs.
- [ ] New assumptions written into the right doc.
- [ ] You can explain the change to a teammate in two sentences.

If it "works" but you don't know why, it isn't done.

---

## 8. Debugging with agents

- Give the **exact** error, the command, and the file.
- For Solana errors, paste the full `simulateTransaction` logs, not just the error code.
- For OTP issues, paste the provider's error code (Twilio error codes are specific), never the code itself.
- If the agent tries the same fix twice, stop it: *"List three possible causes, ranked, and what evidence would confirm each."*
- After 3 failed attempts, a human reads the code.

---

## 9. UI iteration

- Scaffold from the frontend guide's tables, then iterate visually.
- Give the agent the tokens and glass recipe explicitly; no invented colors.
- One visual concern per iteration.
- Remind the agent every time it touches `/c/[id]`: 150 KB budget, no aurora, Privy only on the Keep path, no crypto words, no other recipients.
- For `/start/cleva`: "Partnership preview" badge, no Cleva logo, no credential fields.

---

## 10. Session handoffs

At the end of every session, the agent writes (and you check) `docs/handoff/YYYY-MM-DD-<name>.md`:

```md
## Done
## In progress (files, what's left)
## Decisions made (and which doc was updated)
## Known issues / next step
```

Start the next session with: *"Read CLAUDE.md and the latest handoff note, then summarise where we are before doing anything."*

---

## 11. Git hygiene

- One branch per task: `feat/batch-split-equally`, `feat/claim-channel-picker`, `fix/payout-retry-idempotency`.
- Commit messages describe the change: `feat(claim): add WhatsApp/SMS channel choice`, not `claude changes`.
- Squash-merge to `main`; `main` always deploys and always demos.
- No force-pushes or history rewrites by agents.

---

## 12. Division of labour

| Work | Best done by |
|---|---|
| Boilerplate, CRUD routes, Zod schemas, component scaffolds | Agent |
| Test drafting, especially failure cases and the attestor matrix | Agent, human-reviewed |
| Program account design, slot model, security model | Human-led, agent as reviewer |
| Session and OTP design | Human-led |
| Recipient-facing copy | Human (knows the users), agent for variations and Pidgin/Hausa drafts |
| Pitch narrative and demo script | Human |
| Final pre-demo check | Human, following the runbook |

---

## 13. Hackathon shortcuts

### Allowed
- Mocks behind interfaces: rates, payouts, Cleva gateway, OTP (local only).
- Skipping pagination, admin tooling and full i18n.
- Skipping tests for pure UI.

### Not allowed
- Skipping program tests or the attestor test matrix.
- Skipping phone verification or the claim session check "just for the demo".
- A mock OTP or mock funding path that works outside devnet/local.
- Hardcoding keys "temporarily".
- Floats for money.
- Any screen that collects Cleva credentials.
