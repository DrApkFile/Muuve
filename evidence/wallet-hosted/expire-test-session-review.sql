UPDATE muuve.sessions
SET expires_at = clock_timestamp() - interval '1 second'
WHERE id = '0f2cd97f-f01d-4e33-b4f7-9a31121aa008'::uuid
  AND user_id = 'b913dc4f-fe0e-4cd9-9d53-e3b492ae6b07'::uuid
  AND created_at = '2026-10-30 00:18:20.135192+00'::timestamptz
  AND phone_e164 IS NULL
  AND revoked_at IS NULL
RETURNING id;
