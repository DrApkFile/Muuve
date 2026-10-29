# Muuve

Claim-link payments. A sender funds USDT into an on-chain escrow link with 1–10 recipient
slots (single or batch). Each recipient opens the same link, verifies their phone by
WhatsApp or SMS code, then either cashes out to a Nigerian bank (escrow → treasury → payout,
no account needed) or keeps dollars (creates a Muuve account with the same number, escrow →
their wallet). Unclaimed slots return to the sender after 48 hours. Sign-up is Muuve phone
account or "Continue with Cleva" (a partnership preview, mock only). Hackathon MVP on devnet.

## Read first
- docs/backend-decisions.md (owner-approved decisions override conflicting v0.2 examples)
- docs/muuve-prd.md, docs/muuve-frontend-guide.md, docs/muuve-backend-guide.md
- docs/muuve-ai-agent-practices.md (how agents work on this repo)

## Commands
- Install: pnpm i
- Dev: pnpm dev
- Program tests: pnpm test:program (native local runtime); pnpm test:sbf (compiled artifact)
- API tests: pnpm test:api
- Database/API integration: pnpm test:db (disposable local Postgres)
- Production HTTP smoke: pnpm test:http (run pnpm build first)
- Typecheck + lint: pnpm check

## Hard rules
- Never read, print, or edit .env files. Use .env.example for names only.
- Owner-authorized exception for this milestone: local secret provisioning, environment
  loading and devnet operator scripts are permitted. Never print secret values, overwrite
  existing keys, commit keys/env files, or deploy to mainnet. This explicit authorization
  does not authorize unrelated credentials, production funds, or hosting charges.
- Deployment requires explicit current owner authorization and must target devnet.
  Never run anything against mainnet.
- Never commit keypairs (keys/, *.json keypairs, id.json).
- Amounts are integer base-unit strings (USDT = 6 decimals). No floats for money.
- Status strings and limits come from packages/shared.
- No crypto words on recipient-facing screens.
- Never log the #k= secret, OTP codes, full phone numbers or account numbers.
- Every claim route uses assertCanAttestClaim(). No inline copies of that logic.
- Batch claim screens never reveal other recipients.
- The Cleva preview never asks for Cleva credentials and never copies Cleva branding.
- Run `pnpm check` and the relevant tests before saying a task is done.
