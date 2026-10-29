BEGIN;
SET search_path TO muuve,public;
CREATE FUNCTION immutable_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='links' THEN IF
   (ROW(NEW.sender_user_id,NEW.sender_wallet,NEW.link_id_hex,NEW.pda,NEW.claim_pubkey,NEW.total_base_units,NEW.slot_count,NEW.kind)
   IS DISTINCT FROM ROW(OLD.sender_user_id,OLD.sender_wallet,OLD.link_id_hex,OLD.pda,OLD.claim_pubkey,OLD.total_base_units,OLD.slot_count,OLD.kind)
   OR OLD.expires_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at)
 THEN RAISE EXCEPTION 'immutable link terms'; END IF; END IF;
 IF TG_TABLE_NAME='quotes' THEN IF
   ROW(NEW.actor_session_id,NEW.principal_id,NEW.amount_base_units,NEW.rate,NEW.amount_ngn_kobo,NEW.currency,NEW.country,NEW.expires_at)
   IS DISTINCT FROM ROW(OLD.actor_session_id,OLD.principal_id,OLD.amount_base_units,OLD.rate,OLD.amount_ngn_kobo,OLD.currency,OLD.country,OLD.expires_at)
 THEN RAISE EXCEPTION 'immutable quote terms'; END IF; END IF;
 IF TG_TABLE_NAME='payouts' THEN IF
   ROW(NEW.principal_id,NEW.quote_id,NEW.retry_of,NEW.bank_code,NEW.account_number,NEW.account_name,NEW.provider,NEW.provider_key,NEW.client_idempotency_key)
   IS DISTINCT FROM ROW(OLD.principal_id,OLD.quote_id,OLD.retry_of,OLD.bank_code,OLD.account_number,OLD.account_name,OLD.provider,OLD.provider_key,OLD.client_idempotency_key)
 THEN RAISE EXCEPTION 'immutable payout terms'; END IF; END IF;
 IF TG_TABLE_NAME='principals' THEN IF
   (ROW(NEW.source,NEW.link_slot_id,NEW.owner_phone,NEW.sender_wallet,NEW.amount_base_units)
   IS DISTINCT FROM ROW(OLD.source,OLD.link_slot_id,OLD.owner_phone,OLD.sender_wallet,OLD.amount_base_units)
   OR (OLD.treasury_owner IS NOT NULL AND ROW(NEW.treasury_owner,NEW.treasury_account) IS DISTINCT FROM ROW(OLD.treasury_owner,OLD.treasury_account)))
 THEN RAISE EXCEPTION 'immutable principal terms'; END IF; END IF;
 IF TG_TABLE_NAME='operations' THEN IF
   ROW(NEW.kind,NEW.link_id,NEW.slot_id,NEW.payout_id,NEW.principal_id,NEW.fingerprint,NEW.request,NEW.expected_signers)
   IS DISTINCT FROM ROW(OLD.kind,OLD.link_id,OLD.slot_id,OLD.payout_id,OLD.principal_id,OLD.fingerprint,OLD.request,OLD.expected_signers)
 THEN RAISE EXCEPTION 'immutable operation terms'; END IF; END IF;
 IF TG_TABLE_NAME='transaction_attempts' THEN IF
   ROW(NEW.operation_id,NEW.replacement_of,NEW.message_hash,NEW.message_base64,NEW.blockhash,NEW.last_valid_block_height,NEW.signature)
   IS DISTINCT FROM ROW(OLD.operation_id,OLD.replacement_of,OLD.message_hash,OLD.message_base64,OLD.blockhash,OLD.last_valid_block_height,OLD.signature)
 THEN RAISE EXCEPTION 'immutable transaction message'; END IF; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_terms BEFORE UPDATE ON links FOR EACH ROW EXECUTE FUNCTION immutable_terms();
CREATE TRIGGER immutable_terms BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION immutable_terms();
CREATE TRIGGER immutable_terms BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION immutable_terms();
CREATE TRIGGER immutable_terms BEFORE UPDATE ON principals FOR EACH ROW EXECUTE FUNCTION immutable_terms();
CREATE TRIGGER immutable_terms BEFORE UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION immutable_terms();
CREATE TRIGGER immutable_terms BEFORE UPDATE ON transaction_attempts FOR EACH ROW EXECUTE FUNCTION immutable_terms();
REVOKE ALL ON FUNCTION immutable_terms() FROM PUBLIC;
COMMIT;
