# Muuve

**You don't send money to an account. You send it to a person.**

Muuve turns dollars into a claim link you share on WhatsApp. The recipient verifies their number by WhatsApp or SMS code, then cashes out to any Nigerian bank or OPay account, or keeps the money in dollars. Anything unclaimed goes back to the sender after 48 hours. One link can pay one person or a whole family.

Built for the Cleva x Tether Future of Payments Hackathon (UNILAG Edition).

## Backend milestone

Backend implementation lives in `apps/web/lib/server`, with Node route handlers in
`apps/web/app/api`, fixed-allocation Anchor escrow in `programs/muuve_escrow`, shared
schemas in `packages/shared`, and transactional Postgres migrations in `supabase/migrations`.
No frontend is included. Fiat payouts, rates and bank resolution are mocks.

Read the [owner-approved decisions](docs/backend-decisions.md), then the
[setup, devnet and recovery runbook](docs/backend-runbook.md).

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:db
pnpm test:program -- --test-threads=1
pnpm build
```

The program is deployed and verified on devnet. Local tests and deployed-contract
evidence do not establish live Privy wallet linking, SMS delivery or hosted Render
operation. See the [latest milestone report](docs/handoff/2026-10-29-render-devnet.md)
for actual results and the remaining Supabase, Render and Privy configuration.

Render API and continuous-worker setup: [deployment guide](docs/render-deployment.md).
Public devnet funding addresses: [wallets.md](wallets.md).
`pnpm setup:local` provisions local keys when no saved identity exists. Restore the
protected key backup on a new machine; missing keys for saved identities are never
silently regenerated. Never commit local secrets. Load root configuration explicitly:

```sh
node --env-file=.env.local --import tsx scripts/verify-auth.ts
```

## Docs
- [Product requirements](docs/muuve-prd.md)
- [Frontend guide](docs/muuve-frontend-guide.md)
- [Backend guide](docs/muuve-backend-guide.md)
- [AI agent practices](docs/muuve-ai-agent-practices.md)
