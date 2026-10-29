BEGIN;
SET search_path TO muuve, public;
ALTER TABLE jobs ADD COLUMN lease_token uuid;
CREATE TABLE worker_schedules (
 name text PRIMARY KEY CHECK(name IN ('reconcile','expire','failed_payouts','monitor')),
 next_run_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token uuid,
 CHECK((lease_until IS NULL)=(lease_token IS NULL))
);
ALTER TABLE worker_schedules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON worker_schedules FROM PUBLIC;
CREATE INDEX ON worker_schedules(next_run_at);
COMMIT;
