# Supabase database trust anchor

`supabase-prod-ca-2021.crt` is a **public CA certificate**, not a private key.
It is safe to include in the API/worker deployment. It was downloaded over verified
HTTPS from the production download URL referenced by Supabase's own Studio source:

- [Supabase Studio certificate URL configuration](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json)
- [Production certificate download](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt)
- [Supabase SSL verification documentation](https://supabase.com/docs/guides/platform/ssl-enforcement)

Download provenance, SHA-256 and certificate fingerprint are recorded in
`supabase-prod-ca-2021.provenance.json`. The certificate expires on 26 April 2031.
Review provider rotations before expiry; do not replace it with a certificate
copied from an unverified database handshake.

This repository starts the API and worker from the repository root. Add these query
parameters to the actual PostgreSQL `DATABASE_URL` in local and Render configuration:

```text
sslmode=verify-full&sslrootcert=config/certs/supabase-prod-ca-2021.crt
```

Use `?` before the first parameter or `&` if the URL already has parameters.
`pg` loads the file and verifies both the certificate chain and hostname. No global
Node trust-store modification or `rejectUnauthorized:false` is required.

On 29 October 2026 the owner-supplied session pooler completed a TLS 1.3 handshake
with certificate and hostname verification enabled. Initial database authentication
failed with PostgreSQL `28P01`; the owner's subsequent password confirmation resolved
that failure. Hosted migrations, schema and HTTP/worker checks now pass with this CA.
