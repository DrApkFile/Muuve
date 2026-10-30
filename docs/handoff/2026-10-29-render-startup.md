# Render startup configuration diagnostic — 29 October 2026

## Done

Investigated the owner's Render log for service `srv-dbhqunegekts73c09c20`. The build
succeeded according to that log, but startup rejected a non-empty local operator
environment variable before spawning Next.js. The later missing-port message is a
consequence of that exit. `pnpm run start` is a valid repository command.

Updated `scripts/start-api.mjs` to list the offending variable names in its error,
without printing values. Updated `scripts/worker.ts` to emit the same information
through structured redacted logging. The existing exclusion policy is unchanged;
deployment/admin/test keys remain local-only. Runtime mint-authority, treasury,
attestor and fee-payer secrets remain permitted.

Added `tests/unit/render-startup.test.ts`. It executes both real entry points with
forbidden settings and sentinel secret values, verifies rejection before external
work, checks the variable-name diagnostic and checks that secret values and permitted
runtime-key names are absent from that diagnostic. Non-empty `false` flags remain
rejected, matching the existing policy.

Observed successful verification: both new subprocess regression tests; 50 unit
tests (42 database cases skipped here and previously run separately); the production
HTTP smoke test with a clean Render environment; official Blueprint validation;
TypeScript/Prettier and secret scanning. The HTTP run verifies that the unchanged
runtime-key policy still permits startup and public JWKS/health checks. It does not
establish remote Render health.

Updated [Render troubleshooting](../render-deployment.md) with the precise local-only
variable names, linked-environment-group handling, required runtime settings and
redeploy instructions.

## In progress

The remote environment has not been changed or independently inspected. The supplied
log establishes that at least one forbidden variable exists, but its older generic
message does not identify which one. The configured local file has six matching
non-empty entries; these are documented as a likely imported set, not a verified
inventory of Render's environment.

## Decisions made

Preserved the guard and all runtime authorization boundaries. Improved diagnosis
instead of allowing hosted deployment/admin/test credentials. No wallet, database,
contract or frontend behavior was changed by this fix.

## Known issues / next step

Remove `OPERATOR_*`, `DEVNET_TEST_*`, `TEST_MINT_SECRET` and `TEST_MINT_SECRET_FILE`
from the API/worker service environment and any linked group that supplies them.
Save and deploy, then verify `/api/health`. This fixes the reported configuration
failure without requiring the source diagnostic update to be deployed first.

Do not import the full local environment into Render. Its local OTP mode and private
file paths are unsuitable for the hosted service; use the documented environment
matrix. A successful remote restart/health response is not claimed by local tests.
