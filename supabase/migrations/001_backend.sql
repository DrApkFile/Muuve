BEGIN;
CREATE SCHEMA muuve;
REVOKE ALL ON SCHEMA muuve FROM PUBLIC;
SET search_path TO muuve, public;
CREATE DOMAIN amount AS numeric(20,0) CHECK (VALUE > 0 AND VALUE <= 18446744073709551615);
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone_e164 text UNIQUE NOT NULL,
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 60),
 auth_origin text NOT NULL CHECK(auth_origin IN ('muuve','cleva_preview')),
 wallet_address text UNIQUE, privy_user_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
 id uuid PRIMARY KEY, purpose text NOT NULL CHECK(purpose IN ('account','claim','proof')),
 user_id uuid REFERENCES users, phone_e164 text NOT NULL, link_id uuid,
 expires_at timestamptz NOT NULL, consumed_at timestamptz, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((purpose='claim')=(link_id IS NOT NULL))
);
CREATE TABLE otp_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), phone_e164 text NOT NULL, ip inet NOT NULL,
 channel text NOT NULL CHECK(channel IN ('sms','whatsapp')),
 purpose text NOT NULL CHECK(purpose IN ('account','claim')), link_id uuid,
 provider_ref text, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','verified','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 expires_at timestamptz NOT NULL, verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((purpose='claim')=(link_id IS NOT NULL))
);
CREATE INDEX ON otp_challenges(phone_e164,created_at);
CREATE INDEX ON otp_challenges(ip,created_at);
CREATE TABLE links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_user_id uuid NOT NULL REFERENCES users,
 sender_wallet text NOT NULL, link_id_hex char(32) NOT NULL CHECK(link_id_hex ~ '^[0-9a-f]{32}$'),
 pda text UNIQUE NOT NULL, claim_pubkey text NOT NULL, note text CHECK(length(note)<=120),
 kind text NOT NULL CHECK(kind IN ('single','batch')), total_base_units amount NOT NULL,
 slot_count smallint NOT NULL CHECK(slot_count BETWEEN 1 AND 10),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','open','settled','cancelled')),
 capacity_state text NOT NULL DEFAULT 'reserved' CHECK(capacity_state IN ('reserved','open','released')),
 expires_at timestamptz, create_sig text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(sender_user_id,link_id_hex), UNIQUE(sender_wallet,link_id_hex),
 CHECK(total_base_units<=1000000000), CHECK((kind='single')=(slot_count=1))
);
ALTER TABLE sessions ADD FOREIGN KEY(link_id) REFERENCES links;
-- Challenge link IDs intentionally have no FK: invalid/nonmember requests have identical send behavior.
CREATE TABLE link_slots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), link_id uuid NOT NULL REFERENCES links,
 slot_index smallint NOT NULL CHECK(slot_index BETWEEN 0 AND 9), recipient_phone_e164 text NOT NULL,
 label text CHECK(length(label)<=40), amount_base_units amount NOT NULL CHECK(amount_base_units<=500000000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','funded','cashing_out','cashed_out','kept','recalled','returned')),
 claimed_by_user_id uuid REFERENCES users, claim_sig text, recall_sig text, return_sig text,
 intent_id uuid, intent_version numeric(20,0) NOT NULL DEFAULT 0, intent_path text,
 priority_until timestamptz, claimed_at timestamptz,
 UNIQUE(link_id,slot_index), UNIQUE(link_id,recipient_phone_e164)
);
CREATE TABLE principals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source text NOT NULL CHECK(source IN ('escrow_claim','wallet')),
 link_slot_id uuid UNIQUE REFERENCES link_slots, user_id uuid REFERENCES users,
 owner_phone text NOT NULL, sender_wallet text NOT NULL, amount_base_units amount NOT NULL,
 state text NOT NULL DEFAULT 'escrow' CHECK(state IN ('escrow','treasury','resolving','paid','kept','refunded','quarantined')),
 quarantine_reason text CHECK(quarantine_reason IN ('provider_unknown','provider_conflict','chain_conflict')),
 transfer_sig text UNIQUE, active_payout_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((source='escrow_claim')=(link_slot_id IS NOT NULL)), CHECK(source!='wallet' OR user_id IS NOT NULL)
);
CREATE TABLE quotes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_session_id uuid NOT NULL REFERENCES sessions,
 principal_id uuid NOT NULL REFERENCES principals, amount_base_units amount NOT NULL,
 rate numeric(14,4) NOT NULL CHECK(rate>0), amount_ngn_kobo amount NOT NULL,
 currency text NOT NULL DEFAULT 'NGN' CHECK(currency='NGN'), country text NOT NULL DEFAULT 'NG' CHECK(country='NG'),
 expires_at timestamptz NOT NULL, consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payouts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), principal_id uuid NOT NULL REFERENCES principals,
 quote_id uuid NOT NULL UNIQUE REFERENCES quotes, retry_of uuid REFERENCES payouts,
 bank_code text NOT NULL, account_number char(10) NOT NULL CHECK(account_number ~ '^[0-9]{10}$'), account_name text NOT NULL,
 status text NOT NULL DEFAULT 'quoted' CHECK(status IN ('quoted','transferring','processing','paid','failed','resolved','quarantined')),
 resolution text CHECK(resolution IN ('retried','kept_in_dollars','returned_to_wallet','refunded_to_sender')),
 provider text NOT NULL, provider_key uuid NOT NULL UNIQUE, provider_ref text UNIQUE,
 client_idempotency_key text CHECK(length(client_idempotency_key) BETWEEN 8 AND 128),
 failure_reason text, failed_at timestamptz, resolved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='resolved')=(resolution IS NOT NULL))
);
ALTER TABLE principals ADD FOREIGN KEY(active_payout_id) REFERENCES payouts;
CREATE UNIQUE INDEX one_live_payout ON payouts(principal_id) WHERE status IN ('quoted','transferring','processing','quarantined');
CREATE UNIQUE INDEX payout_retry_key ON payouts(principal_id,client_idempotency_key) WHERE client_idempotency_key IS NOT NULL;
CREATE TABLE operations (
 id uuid PRIMARY KEY, actor_session_id uuid REFERENCES sessions, actor_user_id uuid REFERENCES users,
 kind text NOT NULL CHECK(kind IN ('create','intent','claim_keep','claim_cashout','recall','expire','wallet_payout','treasury_keep','treasury_refund','fund')),
 link_id uuid REFERENCES links, slot_id uuid REFERENCES link_slots, payout_id uuid REFERENCES payouts, principal_id uuid REFERENCES principals,
 fingerprint text NOT NULL, request jsonb NOT NULL, expected_signers jsonb NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','submitted','confirmed','finalized','failed','unknown','held','superseded')),
 idempotency_key text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor_session_id,idempotency_key)
);
CREATE UNIQUE INDEX one_live_slot_operation ON operations(slot_id,kind) WHERE state IN ('prepared','submitted','confirmed','unknown','held');
CREATE TABLE transaction_attempts (
 id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES operations,
 replacement_of uuid REFERENCES transaction_attempts, message_hash text NOT NULL,
 message_base64 text NOT NULL, tx_base64 text NOT NULL, blockhash text NOT NULL,
 last_valid_block_height bigint NOT NULL, signature text UNIQUE,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','submitted','confirmed','finalized','failed','unknown','held','superseded')),
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE funding_reservations (
 operation_id uuid PRIMARY KEY REFERENCES operations, user_id uuid NOT NULL REFERENCES users,
 amount_base_units amount NOT NULL, day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','minted','released'))
);
CREATE TABLE provider_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payout_id uuid NOT NULL REFERENCES payouts,
 provider_key uuid NOT NULL, outcome text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mock_provider_transfers (
 provider_key uuid PRIMARY KEY, provider_ref text NOT NULL UNIQUE, fingerprint text NOT NULL,
 payout_id uuid NOT NULL REFERENCES payouts, outcome text NOT NULL CHECK(outcome IN ('paid','failed')),
 ready_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_inbox (
 provider text NOT NULL, event_id text NOT NULL, body_hash text NOT NULL,
 payout_id uuid NOT NULL REFERENCES payouts, status text NOT NULL CHECK(status IN ('paid','failed')),
 processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,event_id)
);
CREATE TABLE jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL, entity_id uuid NOT NULL,
 dedupe_key text NOT NULL UNIQUE, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','done','quarantined')),
 attempts integer NOT NULL DEFAULT 0, run_after timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
 last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE events (
 id bigserial PRIMARY KEY, entity_type text NOT NULL, entity_id uuid NOT NULL,
 type text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION immutable_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'events are append only'; END $$;
CREATE TRIGGER append_only_events BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION immutable_event();
CREATE FUNCTION immutable_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.link_id,NEW.slot_index,NEW.recipient_phone_e164,NEW.amount_base_units) IS DISTINCT FROM
    (OLD.link_id,OLD.slot_index,OLD.recipient_phone_e164,OLD.amount_base_units) THEN RAISE EXCEPTION 'immutable slot allocation'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_slot_allocation BEFORE UPDATE ON link_slots FOR EACH ROW EXECUTE FUNCTION immutable_slot();
CREATE FUNCTION validate_link_slots() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lid uuid; l links; n bigint; total numeric; highest integer;
BEGIN
 IF TG_TABLE_NAME='links' THEN lid:=COALESCE(NEW.id,OLD.id); ELSE lid:=COALESCE(NEW.link_id,OLD.link_id); END IF;
 SELECT * INTO l FROM links WHERE id=lid;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT count(*),sum(amount_base_units),max(slot_index) INTO n,total,highest FROM link_slots WHERE link_id=lid;
 IF n<>l.slot_count OR total<>l.total_base_units OR highest<>l.slot_count-1 THEN RAISE EXCEPTION 'invalid fixed allocation accounting'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER link_accounting AFTER INSERT OR UPDATE ON links DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_link_slots();
CREATE CONSTRAINT TRIGGER slot_accounting AFTER INSERT OR UPDATE OR DELETE ON link_slots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_link_slots();
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='muuve' LOOP
  EXECUTE format('ALTER TABLE muuve.%I ENABLE ROW LEVEL SECURITY',t.tablename);
  EXECUTE format('REVOKE ALL ON muuve.%I FROM PUBLIC',t.tablename);
 END LOOP;
END $$;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA muuve FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA muuve FROM PUBLIC;
CREATE INDEX ON operations(state,updated_at);
CREATE INDEX ON transaction_attempts(operation_id,created_at DESC);
CREATE INDEX ON jobs(state,run_after);
CREATE INDEX ON payouts(status,failed_at);
CREATE INDEX ON links(sender_user_id,capacity_state);
COMMIT;
