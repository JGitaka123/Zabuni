DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_outbox_claim_owner') THEN
    CREATE ROLE zabuni_outbox_claim_owner NOLOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_worker') THEN
    CREATE ROLE zabuni_worker LOGIN PASSWORD 'zabuni_worker'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

ALTER ROLE zabuni_outbox_claim_owner NOLOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
ALTER ROLE zabuni_worker LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;

-- The migration owner may assign the narrowly audited claim function to this
-- role. Neither runtime login can assume it.
GRANT zabuni_outbox_claim_owner TO zabuni_owner;
REVOKE zabuni_outbox_claim_owner, zabuni_owner, zabuni_migrator FROM zabuni_worker;
REVOKE zabuni_outbox_claim_owner, zabuni_owner, zabuni_migrator FROM zabuni_app;

GRANT CONNECT ON DATABASE zabuni TO zabuni_worker;
GRANT USAGE ON SCHEMA public TO zabuni_outbox_claim_owner, zabuni_worker;
