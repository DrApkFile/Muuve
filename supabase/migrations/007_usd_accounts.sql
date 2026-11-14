BEGIN;
SET search_path TO muuve,public;
-- One US dollar account per user, issued by a provider (Bridge) after its identity check.
-- No identity documents, email or name are stored here; the provider holds them.
CREATE TABLE usd_accounts (
 user_id uuid PRIMARY KEY REFERENCES users,
 provider text NOT NULL CHECK(provider IN ('bridge')),
 customer_id text UNIQUE,
 kyc_link_id text NOT NULL UNIQUE,
 kyc_url text NOT NULL, tos_url text NOT NULL,
 kyc_status text NOT NULL DEFAULT 'not_started',
 tos_status text NOT NULL DEFAULT 'pending',
 virtual_account_id text UNIQUE,
 deposit_instructions jsonb,
 synced_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- Each bank deposit, once. On devnet a deposit is credited by minting test dollars
-- (operation_id); on mainnet the provider delivers the stablecoin itself.
CREATE TABLE usd_deposits (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users,
 provider text NOT NULL CHECK(provider IN ('bridge')),
 deposit_id text NOT NULL,
 amount_base_units numeric(20,0) NOT NULL CHECK(amount_base_units>0),
 status text NOT NULL,
 operation_id uuid REFERENCES operations,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,deposit_id)
);
CREATE INDEX ON usd_deposits(user_id,created_at);
ALTER TABLE usd_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE usd_deposits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON usd_accounts FROM PUBLIC;
REVOKE ALL ON usd_deposits FROM PUBLIC;
COMMIT;
