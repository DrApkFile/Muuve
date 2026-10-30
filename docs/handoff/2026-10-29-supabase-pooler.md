# Supabase session-pooler continuation — 29 October 2026

Resolved by the later [verified Supabase handoff](2026-10-29-supabase-verified.md):
login, all five migrations, hosted schema and HTTP/worker verification now pass.
The failed-password statements below describe the earlier checkpoint.

## Done

Saved the owner's exact session-pooler host, port and username in ignored mode-0600
`.env.local`, preserving the supplied database password and encoding it safely.
The configured target is project `yirelxmcveyxcqofzayq`, host
`aws-0-eu-west-1.pooler.supabase.com`, port 5432. No credentials are recorded here.

The first pooler attempt failed with `SELF_SIGNED_CERT_IN_CHAIN`. Located the
production CA download URL through Supabase's official Studio source, downloaded
its public certificate over verified HTTPS and saved certificate provenance in
`config/certs/`. The connection now uses `sslmode=verify-full` plus `sslrootcert`.
OpenSSL verified the chain and pooler hostname with TLS 1.3; Node's `pg` stream also
reported `authorized: true`. TLS verification was never disabled.

Updated the Render guide and environment example so API and worker deployments
can use the same reviewed CA file without adding secrets or extra environment names.
`pnpm check`, `git diff --check` and the local source/evidence/build-artifact secret
audit passed after these changes. No dependencies or application source were changed.

## In progress

Hosted PostgreSQL authentication is blocked with **`28P01` (invalid password)**.
Host/username, URL decoding, absence of placeholder/extra quotes/whitespace and
password preservation were checked. The migration command was attempted but cannot
authenticate. No hosted tables, migrations or application records were changed.

Follow-up: tried exactly the four additional password variants supplied by the owner,
in their requested order. All four returned `28P01`, with verified client TLS on
every attempt. No unsuccessful candidate was saved over the local configuration,
and no further guesses were attempted. Redacted per-attempt results are recorded in
`evidence/render-devnet/supabase-password-recheck.json`.

The separate disposable-database tests from the prior handoff remain local evidence;
they do not establish a successful hosted database connection.

## Decisions made

Used the exact owner-provided Session pooler endpoint. Retained full certificate and
hostname verification rather than weakening TLS. The certificate is public and can
be committed; `.env.local` and all private role/signing keys remain ignored.

## Known issues / next step

Reset or verify the project's **database password** in Supabase database settings,
then replace only the password in local `DATABASE_URL`, preserving URL encoding and
both TLS parameters. Enter the corresponding connection directly in Render's secret
settings when deploying. Do not paste replacement credentials into conversation.

Then retry from the repository root:

```sh
MUUVE_ALLOW_MIGRATIONS=1 node --env-file=.env.local --import tsx scripts/migrate.ts
node --env-file=.env.local --import tsx scripts/database-status.ts
```

No database reset or table drop is needed. The migration runner checks prior
checksums and serializes execution with its session advisory lock.

Connection evidence is in
`evidence/render-devnet/supabase-connectivity-result.json`; migration-attempt evidence
is in `evidence/render-devnet/supabase-migrations.json` and its redacted log.
The [earlier full report](2026-10-29-render-devnet.md) covers the completed backend
implementation and actual devnet deployment. Its missing-pooler-URI blocker is now
superseded by the observed authentication failure documented here.
