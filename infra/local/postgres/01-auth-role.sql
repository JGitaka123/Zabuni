DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zabuni_auth') THEN
    CREATE ROLE zabuni_auth LOGIN PASSWORD 'zabuni_auth'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

ALTER ROLE zabuni_auth LOGIN PASSWORD 'zabuni_auth'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
REVOKE zabuni_owner, zabuni_migrator, zabuni_app FROM zabuni_auth;
GRANT CONNECT ON DATABASE zabuni TO zabuni_auth;
GRANT USAGE ON SCHEMA public TO zabuni_auth;
