# Textbee OTP and four-minute devnet demo

Owner request: 30 October 2026. The four-minute setting is a demo override for
**future links**, not a rewrite of existing payment terms. Real payouts remain
mocked. This guide does not attest a deployment or a completed hosted cashout.

## Textbee setup

Textbee pushes an SMS to a registered Android device, which sends through its SIM.
You need a Textbee account, API key, enabled Android device with SMS permission,
internet access, and a SIM with SMS credit or an applicable bundle. Keep the device
online and allow background execution. API acceptance is not delivery. Follow the
[official setup guide](https://textbee.dev/docs/getting-started) and
[SMS API contract](https://textbee.dev/docs/sending-sms/sending-sms).

Put these values in ignored `.env.local` for local readiness checks. Enter them
directly into the Render **API** environment when deploying; never send them in chat:

```dotenv
TEXTBEE_API_KEY=<your API key>
TEXTBEE_DEVICE_ID=<the registered 24-character device ID>
# Optional Android subscription ID, copied from the device's current SIM settings:
TEXTBEE_SIM_SUBSCRIPTION_ID=
```

The read-only readiness command sends no SMS:

```sh
node --env-file=.env.local --import tsx scripts/verify-textbee.ts
```

After deploying the reviewed source to the existing API, select
`OTP_PROVIDER=textbee` and keep `WHATSAPP_OTP_ENABLED=false`. Preserve the current
`SESSION_SECRET`; it also keys Textbee challenge verifiers. No additional JWT key,
database migration, wallet, worker deployment or Textbee worker credential is needed.
The existing local worker must continue using the same hosted database.

The API uses the fixed official HTTPS endpoint, an explicit device, one recipient
per OTP and no redirects. It generates six digits with cryptographic randomness and
persists only a salted HMAC verifier plus the batch receipt in the existing
`otp_challenges.provider_ref` text field. The verifier binds the code to the actual
challenge UUID and phone. An unkeyed six-digit hash would allow offline guessing
after a database leak; that design is not used.

Existing database-backed challenge expiry, attempts, rate limits and atomic
single-use consumption apply. Claim-purpose sessions still require the exact link
and verified recipient phone. Textbee does not make wallet-only login a phone proof.
Pending Twilio challenges are checked with Twilio according to their stored `VE...`
reference, even after provider selection changes. Pending Textbee challenges retain
their own verifier routing. Do not remove Twilio credentials until its pending
challenges expire if verification during the switch is required.

The `sent` challenge state means the provider accepted the request, not confirmed
SMS delivery. A timeout may still have queued an SMS. The API marks that challenge
failed and does not retry automatically. A late code from that failed challenge
cannot establish a session. Diagnose the transport/device, observe existing rate
limits and deliberately request a fresh challenge. Never log provider bodies,
message text, API keys, OTPs, full phones or cookies. Device/dashboard SMS history
contains sensitive message contents and needs restricted access.

## Four-minute contract setting

The old deployed program has a fixed 172800-second Config and cannot change it through
an environment variable. The new `set_claim_window(claim_window: i64)` instruction:

- Requires the stored admin's signature and canonical Config PDA.
- Accepts only 172800 or 240 seconds; other values fail.
- Emits `ClaimWindowChanged` with old/new values.
- Changes only Config. Link allocations, recipient mapping and existing
  `created_at`/`expires_at` snapshots remain untouched.
- Keeps initialization at 48 hours. New links use the Config value at creation.
- Leaves claim and recall rejection at `now >= expires_at`; expiry is allowed at
  `now >= expires_at`. Priority is capped by that same original deadline.

Account layouts and existing instruction arguments are unchanged; the new error is
appended to preserve existing error codes. This still requires a reviewed devnet
program upgrade. Do not rerun initialization, create another mint, replace the
stable program identity or edit account data directly. `scripts/deploy-devnet.ts`
continues to reject a different deployed binary; its guard was not bypassed.

Review/tests/build before any authority action:

```sh
CARGO_HOME="$PWD/.cache/cargo" pnpm test:program
CARGO_HOME="$PWD/.cache/cargo" SBF_TOOLCHAIN_ROOT="$PWD/.cache/platform-tools-v1.58" \
  node --env-file=.env.local scripts/build-sbf.mjs
CARGO_HOME="$PWD/.cache/cargo" pnpm test:sbf
CARGO_HOME="$PWD/.cache/cargo" node --env-file=.env.local scripts/build-idl.mjs
OPERATOR_APPROVED_DEVNET=1 node --env-file=.env.local --import tsx \
  scripts/set-claim-window.ts --seconds=240 --review
```

The last command is an unsigned, read-only simulation using public role identities.
The initial live review returned error 101: the currently deployed binary does not
recognize the new instruction. No configuration transaction was signed or sent.
Review the built artifact, source hash, current loader authority, allocation size
and upgrade cost before requesting explicit operator approval for an upgrade.

Only after an approved upgrade and a passing review, this separate guarded command
can submit the admin change:

```sh
OPERATOR_APPROVED_DEVNET=1 MUUVE_ALLOW_CONFIG_CHANGE=1 \
  node --env-file=.env.local --import tsx scripts/set-claim-window.ts \
  --seconds=240 --execute --operator-approved-window-change
```

It verifies public roles, locks the local journal, records signed bytes/signature
privately before submission, checks message integrity on resume, and verifies
finalized Config. Keep the journal for reconciliation; an expired/failed/ambiguous
attempt must not be replaced blindly. Restoration to 172800 is another reviewed
admin action with its own journal; do not overwrite the previous receipt.

Coordinate `CLAIM_WINDOW_SECS=240` in the API and local worker **after the approved
change**, with `APP_ENV=preview` (or local for local tests). Backend readiness fails
closed if Config and environment disagree. Production mode rejects the short
window; mainnet remains rejected. The Blueprint keeps the safe 172800 default and
shares the API's window with its optional worker. The worker now needs APP_ENV for
short-window validation, but no OTP secrets. A short maintenance window is expected
while Config and service environment are switched; do not treat mismatch as success.

Existing 48-hour links stay 48-hour links even in demo mode. Four-minute expiry is
its own evidence; it does not prove that 48 real hours elapsed. Existing expiry
fixtures and their genuine dates must remain intact.

## Hosted cashout and batch continuation

The already funded two-slot batch in the backend payment handoff has immutable
allocations 500000 and 1000000 base units. Textbee can verify those two actual
assigned phones; no additional funding is needed to continue that approved batch.
Use the existing runner, private progress and real claim-purpose OTPs after the
owner deploys/configures the API. Do not replace its recipient phones with the
single number used for the account-login check.

Review current state before each stage, then run the scoped `--resend-otp=a` or
`--send-otp=b`, `--verify-otp=a|b`, `--claim=a|b`, `--retry-b` and status stages documented
by `scripts/run-hosted-payments.ts`, retaining its explicit approval guards. Keep
codes in its ignored private input file. The runner accepts Twilio or Textbee and
retains the original budget. Never rerun initial funding merely to resume a claim.

The local worker must use the same Supabase database and compatible window setting.
Verify finalized treasury receipt before mock provider dispatch, then SQL principal,
payout, attempt, job and webhook states. Slot A uses mock success; B uses mock failure
and retry. Preserve one logical principal and prevent another escrow release. A
successful mock payout is not an NGN transfer.

A new four-minute expiry fixture needs an additional bounded funding approval:
the original 1900000-base-unit gross funding budget is already used. Review the
fresh ID, allocations, accounts and transaction before signing. No existing funded
deadline is shortened and no new allowance is inferred from refunded balances.
