# Nigerian OTP provider research — 30 October 2026

## Recommendation

**Termii managed OTP is the best-fit replacement candidate for Muuve's existing
backend.** This is an architectural recommendation based on current official
documentation, not a successful delivery test or an account approval guarantee.
No replacement provider has been implemented, provisioned or paid for.

Muuve already delegates OTP creation/delivery/checking to a server-side provider and
stores its challenge reference. Termii has both managed token creation/delivery and
reference-based verification, configurable expiry/attempt limits, and a documented
`dnd` route. That avoids adding custom OTP storage or a new browser authentication
system. [Send Token](https://developer.termii.com/send-token),
[Verify Token](https://developer.termii.com/verify-token).

## Comparison

| Provider         | Evidence relevant to Nigerian users                                                                        | Fit and prerequisite                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Termii           | Managed send/verify tokens; approved Nigerian sender IDs; generic and DND OTP routes documented.           | Recommended for the current provider interface. Confirm sender approval, network coverage and the account's DND access before relying on it for judging.                                                                                       |
| BulkSMSNigeria   | Documents Nigerian networks, corporate/OTP routing and delivery reports. Advertises a small signup credit. | Reasonable alternative for SMS transport. Reviewed public APIs send SMS rather than provide a managed OTP send/check pair; additional secure OTP generation/checking would be needed. Corporate/OTP delivery requires sender/network approval. |
| Sendchamp        | Documents managed verification creation and confirmation, including Nigerian international phone format.   | Plausible managed alternative. Account sender, current Nigerian route availability and live pricing still need validation.                                                                                                                     |
| Africa's Talking | Documents live Nigerian SMS services; its free sandbox sends to a simulator.                               | A production-service candidate, but its free simulator cannot prove real judge-phone ownership. Live sender provisioning and delivery costs remain prerequisites.                                                                              |

Sources: [Termii sender registration](https://developer.termii.com/sender-id),
[BulkSMSNigeria API](https://www.bulksmsnigeria.com/api),
[Sendchamp send](https://sendchamp.readme.io/reference/send-otp-api) and
[confirm](https://sendchamp.readme.io/reference/confirm-otp-api),
[Africa's Talking country/service information](https://community.africastalking.com/forum/help-18238/topic/at-help-comprehensive-94/)
and [sandbox restrictions](https://help.africastalking.com/en/articles/1170660-how-do-i-get-started-on-the-africa-s-talking-sandbox).

## Costs and trial claims

- Termii is not an unlimited free SMS service. Its current public pricing says channel
  rates depend on destination and channel and directs customers to obtain a rate card.
  No exact Nigerian OTP rate or dependable free-credit allowance was verified here.
  [Current pricing](https://termii.com/pricing).
- BulkSMSNigeria advertises starting SMS pricing of **NGN 6.49 excluding VAT** and
  **NGN 50 signup credit**. That is not proof that a new account immediately has
  approved corporate/OTP routing; verify that route's actual price and access before
  purchasing. [Pricing](https://www.bulksmsnigeria.com/pricing),
  [routing rules](https://www.bulksmsnigeria.com/api).
- The retrieved Sendchamp public pricing content did not establish a dependable
  Nigerian tariff. Do not interpret placeholder zeroes or unavailable calculator
  values as free OTP delivery. [Pricing page](https://sendchamp.com/pricing).

For random judges' Nigerian phones, dependable real delivery matters more than a
free sandbox. No reviewed trial is being promised as unrestricted free production SMS.

## Termii account prerequisites to confirm first

1. Create the owner-controlled Termii account and select managed SMS OTP.
2. Confirm that the account can send transactional OTP to Nigerian MTN, Airtel, Glo
   and 9mobile numbers, including DND recipients, without manually registering every
   recipient as a test destination. This must be confirmed for the actual account;
   public endpoint documentation does not establish every trial restriction.
3. Obtain an active, approved sender ID or explicitly authorized shared test sender.
   Termii's API requires an approved sender and its registration flow goes through
   review. Ask whether business-registration documents are required for this account
   and whether a shared sender can be used for the hackathon. No shared name or
   approval time is assumed. [Sender ID documentation](https://developer.termii.com/sender-id).
4. Confirm the Nigerian OTP/DND rate, minimum funding requirements and route access.
   The owner controls signup, business verification and payment; no charge is authorized
   by this research.
5. Obtain the API key and **the account-specific base URL from its dashboard**.
   Do not copy an old API hostname from an unrelated tutorial. Store credentials in
   local ignored files or Render secret settings, never chat or frontend environment.
   [API endpoint guidance](https://developer.termii.com/),
   [authentication](https://developer.termii.com/authentication/).

These account questions should be answered before assuming that paying for credits
solves all delivery prerequisites. The same approval distinction applies to the
other providers in this comparison.

## Repository-specific integration plan after selection

No frontend rewrite is necessary for a managed Termii adapter: retain
`/api/auth/otp/send` and `/api/auth/otp/verify`, their public request/response shapes,
phone normalization, server-side challenge IDs and session behavior.

Likely changes, grounded in the current implementation:

- `apps/web/lib/server/providers/otp.ts`: add the managed provider implementation and
  explicit selection. Keep the provider key/server response private and redact errors.
  Store the returned token reference, not an OTP code. Verify only an explicit positive
  provider result; a non-empty string such as `False` must never count as success.
- `apps/web/lib/server/config.ts`: extend the provider enum and validate only the
  selected provider's required server configuration. No silent fallback to mock OTP.
- `apps/web/lib/server/otp.ts` and relevant migration/cutover planning: bind provider
  identity to a challenge or require a verified cutover with no live old-provider
  challenges. Never route a pending Twilio challenge to a different provider simply
  because the environment changed. Any hosted migration needs owner approval.
- `.env.example`, Render configuration documentation, provider-readiness scripts and
  the hosted test runners: document and validate the chosen credentials/base URL/sender/
  route. Existing runners currently enforce Twilio and are not ready for Termii yet.
- Provider unit tests and OTP API/database tests: invalid code, expiry, malformed
  provider results, provider errors/timeouts, attempt limits, rate limits, challenge
  replay, provider binding and exact link/phone membership.

Configure six-digit numeric codes, ten-minute expiry and at most five attempts to
match the current API contract. Keep the existing stricter local counters and
atomic consumption. No authenticated claim is issued until real phone verification
and exact eligibility checks pass. Mock OTP remains local-only.

Acceptance requires actual authorized SMS delivery and valid/invalid-code tests on
the hosted API, including the two assigned Nigerian test recipients. A provider's
successful send response alone is not proof of delivery or phone ownership.

## Current payment-test implications

Funding and recall are verified separately in the
[backend payment report](handoff/2026-10-30-backend-payment-verification.md).
Hosted recipient claims and mock payouts are still blocked. No provider replacement
or new hosted secrets have been applied, and no real NGN payout is introduced.

The funded main fixture expires **1 November 2026 at 02:18:31 Lagos**. Integrating a
provider must preserve its existing recipient assignments, claim key and allocations.
If it expires before testing resumes, use the legitimate expiry/refund path; do not
extend its deadline or fabricate phone proof. The approved new-funding budget is
already consumed, so a fresh funded test would require a new bounded approval.
