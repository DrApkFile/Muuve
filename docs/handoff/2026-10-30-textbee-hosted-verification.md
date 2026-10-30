# Hosted Textbee continuation — 30 October 2026

Latest status: [root handoff](../../handoff.md) supersedes the sending blocker below.
The owner added the hosted environment settings; later real Textbee sends returned
200 with database receipts. The owner then selected a new recipient, a separate
unfunded fixture was prepared, and testing stopped at the owner's request before
OTP verification or funding. Keep the failed artifacts below as historical evidence.

## Deployment and scope

The owner reported the API live after pushing. The checkout was clean on `main`,
tracking `origin/main`, at `f59823b` (`implemented textbee for batch payment and
claims`) before this continuation. The health response does not expose a build SHA;
this is an owner-reported deployment, not independent attestation of Render's commit.
No deployment, program upgrade, Config change, migration, token transfer, claim,
payout or worker dispatch was performed by this continuation.

## Verified checks

- Actual `https://muuve.onrender.com/api/health` returned HTTP 200 with
  `service=muuve-backend`, `chain=devnet`, `payouts=mock`.
- The original payment runner's read-only status stage passed against the intended
  Supabase project `yirelxmcveyxcqofzayq` and configured devnet program. The main
  batch's SQL slots remain funded at 500000 and 1000000 base units. The recalled
  fixture stays settled; the separate 48-hour expiry fixture stays funded. No payout
  records exist for these fixtures.
- Independent paced, finalized RPC reads verified the main Link account and vault:
  program `147uqUCHmuUgziXH31v352QycgSuxLgZfzN2MYE67Sxe`, both slots funded, exactly
  1500000 base units in the six-decimal test-token vault, and original expiry
  `2026-11-01T01:18:31Z`. Config is still 172800 seconds. No original terms changed.
- The local Textbee read-only device check authenticated successfully and returned
  HTTP 200 for the enabled configured device. This proves local credentials/device
  readiness; it does not identify Render's runtime provider or prove delivery.
- No local worker process was found. It was not started because no claim has
  finalized and no payout work was created.

The recorded budget is unchanged: 1900000 base units in gross new funding already
used, 36750000 lamports reserved for fees/rent including future expiry. The sender
token balance read was 300000 base units. No additional budget was inferred from it.

## Actual hosted SMS failure

Exactly one scoped resend was requested for the original recipient A on the funded
batch through the actual Render API. It returned **HTTP 503,
`otp_provider_unavailable`**. Supabase contains the exact new claim-purpose challenge
`d1e7b2a0-f10f-4ff1-95dc-3ee06436a234`, status `failed`, with no provider reference.
No SMS code was requested from the owner, and no verification, claim or cashout
followed this failure. Recipient B was not sent another request for diagnosis.

The missing reference cannot identify which provider failed. The initial audit
reported `hosted_challenge_not_textbee`; that diagnosis was too strong for a null
reference. It was corrected to `failed_or_incomplete_send_provider_unknown`, with
the original artifact retained. There is no evidence here proving Render selected
Textbee or proving it selected Twilio.

The owner was asked to check these names in the **Render API** environment:
`OTP_PROVIDER=textbee`, `TEXTBEE_API_KEY`, `TEXTBEE_DEVICE_ID`, and upload/save the
updated `.env.render-api` if only source was pushed. No secret values were requested.
The ignored environment upload file is not included in a Git push. It already
contains the Textbee configuration locally, remains mode 0600, and keeps
`CLAIM_WINDOW_SECS=172800`. Do not upload `.env.local` or operator keys.

No automatic resend was performed. This stage consumed the runner's single recorded
resend for A. Do not reset that counter, delete progress, overwrite failure evidence
or repurpose another recipient's allocation. After configuration is confirmed,
reconcile the failed challenge before a separately bounded recovery request, retaining
history and existing rate limits. A late SMS from a failed challenge cannot be used
as a valid claim session.

## Tooling changes

`scripts/run-hosted-payments.ts` now clears the selected private OTP input before
verification, preserving the other recipient's input. This avoids retaining a code
in the ignored input file after use. No runtime API change is needed for this fix.

New `scripts/audit-hosted-payment-otp.ts` performs read-only SQL checks of the exact
original recipient allocation, link-bound challenge and provider-reference prefix.
With `--require-verified`, it additionally verifies the actual returned claim-cookie
signature, issuer, audience and exact live SQL session/phone/link binding. It never
generates a session, checks a guessed code, sends SMS or releases principal. Its
verified-session mode remains unexecuted because the hosted send failed.

## Commands and evidence

| Record                                       | Command                                                                                                                                                | Result                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `textbee-hosted-batch-status`                | `OPERATOR_APPROVED_DEVNET=1 MUUVE_RUN_DEVNET_TRANSACTIONS=1 node --import tsx scripts/run-hosted-payments.ts --status --operator-approved-test-budget` | Exit 0; read-only target and fixture status                           |
| `textbee-hosted-recipient-a-send`            | Same guards, `node --import tsx scripts/run-hosted-payments.ts --resend-otp=a --operator-approved-test-budget`                                         | Exit 1; actual hosted 503                                             |
| `textbee-hosted-recipient-a-audit`           | `node --import tsx scripts/audit-hosted-payment-otp.ts --role=a`                                                                                       | Exit 1; original overly strong missing-reference diagnostic, retained |
| `textbee-hosted-recipient-a-audit-corrected` | Same audit command                                                                                                                                     | Exit 1; failed challenge, provider unknown; no resend                 |
| `textbee-postdeploy-provider-readiness`      | `node --env-file=.env.local --import tsx scripts/verify-textbee.ts`                                                                                    | Exit 0; real device authentication, no SMS                            |
| `textbee-hosted-tooling-check`               | `pnpm check`                                                                                                                                           | Exit 0; TypeScript and repository formatting                          |

Timing/exit-code records and logs live in `evidence/render-devnet/`. Main fixture
status is in `evidence/backend-payment/run-status-9cb97879-f828-46bc-8e91-066b9418b255.json`;
the failed send is in `run-resend-otp-a-d7b1ddca-438d-4e00-83bd-0725df1e4375.json`.
Independent chain proof:
`evidence/textbee/hosted-chain-105a3061-c9b7-479d-9fa4-3f38572e414d.json`.
The RPC audit used an inline read-only Node script with `scripts/operator.ts`,
`decodeLink`, `decodeConfig` and `getTokenAccountBalance`; no signer was loaded.
Health was checked with IPv4 curl, TLS verification and bounded connection/total
timeouts, exit 0. No new unit/database/SBF count is claimed for these operator-only
tooling changes; earlier full-suite results remain separate evidence.

`textbee-hosted-secret-audit` ran `node scripts/audit-local-secrets.mjs`, exit 0:
private permissions, Git exclusions, source/evidence and existing build artifact
checks passed. No credential, phone, OTP or authentication token is in this report.

## Next steps

Confirm/correct the hosted provider environment first. If it already selects Textbee
with both values present, inspect redacted Render provider logs and the exact
Textbee batch/message status before any repeat request. Do not publish SMS bodies,
phone numbers, OTPs, API keys, verifier references, tokens or cookies.

After a real accepted Textbee challenge is verified, prove the exact signed claim
session and independently eligible slot, then resume the previously approved intent,
treasury release and mock payout stages. Keep the local worker on hosted Supabase,
use scoped jobs and reconcile finalized chain effects before dispatch. Full hosted
cashout and independent batch claims remain unverified.

The four-minute program upgrade and new expiry fixture still require the separate
approval in [demo-expiry-approval.md](../demo-expiry-approval.md). Source push/live API
confirmation was not treated as approval for authority actions or extra funding.
