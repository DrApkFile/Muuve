BEGIN;
SET search_path TO muuve,public;
ALTER TABLE users ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT users_auth_origin_check;
ALTER TABLE users ADD CONSTRAINT users_auth_origin_check
 CHECK(auth_origin IN ('muuve','cleva_preview','wallet'));
ALTER TABLE users ADD CONSTRAINT users_identity_required
 CHECK((auth_origin='wallet' AND wallet_address IS NOT NULL) OR
       (auth_origin!='wallet' AND phone_e164 IS NOT NULL));
ALTER TABLE sessions ALTER COLUMN phone_e164 DROP NOT NULL;
ALTER TABLE sessions ADD CONSTRAINT sessions_identity_required
 CHECK((purpose='account' AND user_id IS NOT NULL) OR
       (purpose IN ('claim','proof') AND phone_e164 IS NOT NULL));
ALTER TABLE principals ALTER COLUMN owner_phone DROP NOT NULL;
ALTER TABLE principals ADD CONSTRAINT principal_recipient_phone_required
 CHECK(source='wallet' OR owner_phone IS NOT NULL);

CREATE TABLE wallet_auth_challenges (
 id uuid PRIMARY KEY, wallet_address text NOT NULL, browser_hash char(64) NOT NULL,
 origin text NOT NULL, message text NOT NULL, ip inet NOT NULL,
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 consumed_at timestamptz, attempts smallint NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes'),
 CHECK(browser_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX ON wallet_auth_challenges(wallet_address,created_at);
CREATE INDEX ON wallet_auth_challenges(ip,created_at);
CREATE INDEX ON wallet_auth_challenges(expires_at);
ALTER TABLE wallet_auth_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wallet_auth_challenges FROM PUBLIC;
COMMIT;
