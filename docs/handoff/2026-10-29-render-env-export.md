# Render environment upload files — 29 October 2026

## Done

Generated `.env.render-api` (32 variables) and `.env.render-worker` (17 variables)
from the actual Blueprint and verified local configuration. Both are ignored by Git
and have mode 0600. Existing `.env.local`, signing keys and Solana identities were
preserved. No secret values are recorded in this note or the export evidence.

Resolved local private-file alternatives into runtime values: four separate devnet
role keys and the ES256 PKCS8 PEM. Verified role public addresses against the saved
manifest, JWT private/public correspondence and stable KID. Dotenv parse round-trip
checks preserved every value, including the actual multiline private PEM.

Set preview/Twilio configuration for Render while retaining devnet and mocked fiat.
Excluded operator/test settings and all `_FILE` environment alternatives. The worker
receives no Privy, Twilio, JWT, session or cron secrets.

## Upload prerequisites

The owner supplied `https://muuve.onrender.com` after the initial export. Populated
that exact canonical origin as the API export's `APP_BASE_URL` and verified that
every other value was preserved. Neither file has a missing required value.

The exported database URL uses the Render Secret File path
`/etc/secrets/supabase-prod-ca-2021.crt`. Upload the existing public CA certificate
under that exact filename to each applicable service. This avoids depending on an
uncommitted local public-certificate path in the current hosted build.

## Decisions made

Produced separate minimal API and worker configurations, preserved the verified
database password and existing keys, and retained full database TLS verification.
No deployment, wallet funding, SMS or payout was initiated.

## Known issues / next step

Use [the upload instructions](../render-deployment.md) to add the
public CA Secret File, remove old imported local settings and import the correct
file into each service. Merely importing the new file does not delete stale operator
variables from the previous import or a linked environment group.

The API smoke test temporarily supplies its own in-memory test origin; it does not
verify the live Render deployment. A separate local auth check uses the owner-supplied
origin to verify JWT/JWKS consistency without contacting Privy. The worker export check loads and validates its
runtime key values without database/network work. Export metadata and actual check
results are under `evidence/render-devnet/render-env-*.json` and corresponding logs.
No successful hosted redeploy is claimed by producing these files.
