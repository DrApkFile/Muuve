BEGIN;
SET search_path TO muuve,public;
ALTER TABLE principals ADD COLUMN treasury_owner text;
ALTER TABLE principals ADD COLUMN treasury_account text;
CREATE UNIQUE INDEX user_submission_key ON operations(actor_user_id,idempotency_key) WHERE actor_user_id IS NOT NULL AND idempotency_key IS NOT NULL;
COMMIT;
