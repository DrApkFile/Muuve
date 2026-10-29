BEGIN;
SET search_path TO muuve,public;
CREATE FUNCTION guard_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_state text; after_state text; allowed boolean:=false; field text:=TG_ARGV[0];
BEGIN
 before_state:=to_jsonb(OLD)->>field;after_state:=to_jsonb(NEW)->>field;
 IF before_state=after_state THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='link_slots' THEN
  allowed:=CASE before_state WHEN 'pending' THEN after_state='funded'
   WHEN 'funded' THEN after_state IN ('cashing_out','kept','recalled','returned')
   WHEN 'cashing_out' THEN after_state IN ('cashed_out','kept','returned') ELSE false END;
 ELSIF TG_TABLE_NAME='links' THEN
  allowed:=CASE before_state WHEN 'pending' THEN after_state IN ('open','cancelled') WHEN 'open' THEN after_state='settled'
   WHEN 'settled' THEN after_state='open' ELSE false END;
 ELSIF TG_TABLE_NAME='payouts' THEN
  allowed:=CASE before_state WHEN 'quoted' THEN after_state IN ('transferring','processing','failed','resolved')
   WHEN 'transferring' THEN after_state IN ('processing','failed','quarantined')
   WHEN 'processing' THEN after_state IN ('paid','failed','quarantined')
   WHEN 'failed' THEN after_state IN ('resolved','quarantined')
   WHEN 'quarantined' THEN after_state IN ('paid','failed') ELSE false END;
 ELSIF TG_TABLE_NAME='principals' THEN
  allowed:=CASE before_state WHEN 'escrow' THEN after_state IN ('treasury','kept','refunded','quarantined')
   WHEN 'treasury' THEN after_state IN ('resolving','paid','quarantined')
   WHEN 'resolving' THEN after_state IN ('treasury','kept','refunded','quarantined')
   WHEN 'quarantined' THEN after_state IN ('treasury','paid') ELSE after_state='quarantined' END;
 ELSE
  allowed:=before_state NOT IN ('finalized','failed','superseded') OR after_state='finalized';
 END IF;
 IF NOT allowed THEN RAISE EXCEPTION 'invalid durable state transition'; END IF;
 INSERT INTO events(entity_type,entity_id,type,payload) VALUES(TG_TABLE_NAME,NEW.id,TG_TABLE_NAME||'.'||after_state,jsonb_build_object('from',before_state,'to',after_state));
 RETURN NEW;
END $$;
CREATE TRIGGER state_guard BEFORE UPDATE ON links FOR EACH ROW EXECUTE FUNCTION guard_transition('status');
CREATE TRIGGER state_guard BEFORE UPDATE ON link_slots FOR EACH ROW EXECUTE FUNCTION guard_transition('status');
CREATE TRIGGER state_guard BEFORE UPDATE ON payouts FOR EACH ROW EXECUTE FUNCTION guard_transition('status');
CREATE TRIGGER state_guard BEFORE UPDATE ON principals FOR EACH ROW EXECUTE FUNCTION guard_transition('state');
CREATE TRIGGER state_guard BEFORE UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION guard_transition('state');
CREATE TRIGGER state_guard BEFORE UPDATE ON transaction_attempts FOR EACH ROW EXECUTE FUNCTION guard_transition('state');
REVOKE ALL ON FUNCTION guard_transition() FROM PUBLIC;
COMMIT;
