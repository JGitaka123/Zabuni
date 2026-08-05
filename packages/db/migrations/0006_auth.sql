-- Better Auth's identity/session store is intentionally global: authentication
-- must complete before tenant RLS context can be established.
CREATE TABLE auth_identity (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  phone_number text,
  phone_number_verified boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_identity_email_unique ON auth_identity (lower(email));
CREATE UNIQUE INDEX auth_identity_phone_unique ON auth_identity (phone_number)
  WHERE phone_number IS NOT NULL;

CREATE TABLE auth_session (
  id uuid PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id uuid NOT NULL REFERENCES auth_identity (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX auth_session_token_unique ON auth_session (token);
CREATE INDEX auth_session_user_idx ON auth_session (user_id);

CREATE TABLE auth_account (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth_identity (id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_account_provider_unique UNIQUE (provider_id, account_id)
);
CREATE INDEX auth_account_user_idx ON auth_account (user_id);

CREATE TABLE auth_verification (
  id uuid PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verification_identifier_idx ON auth_verification (identifier);

CREATE TABLE auth_rate_limit (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  last_request bigint NOT NULL
);

-- The linkage is global metadata, never queried directly by request handlers.
-- The schema supports future multi-tenant identities, while Phase 0 resolves a
-- session only when exactly one active membership exists.
CREATE TABLE auth_membership (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES auth_identity (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_membership_identity_unique UNIQUE (identity_id),
  CONSTRAINT auth_membership_tenant_user_unique UNIQUE (tenant_id, user_id),
  CONSTRAINT auth_membership_tenant_user_fk
    FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT auth_membership_role_check
    CHECK (role IN ('owner', 'manager', 'sales', 'finance', 'readonly')),
  CONSTRAINT auth_membership_status_check CHECK (status IN ('active', 'suspended'))
);

CREATE TABLE auth_onboarding_audit (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL,
  scope_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_onboarding_action_check CHECK (action = 'tenant_owner_created')
);

ALTER TABLE auth_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_membership FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_membership_read ON auth_membership AS PERMISSIVE FOR SELECT TO zabuni_app
  USING (true);
CREATE POLICY auth_membership_boundary ON auth_membership AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
-- The non-login object owner is reachable only through the audited
-- SECURITY DEFINER functions below.
CREATE POLICY auth_membership_owner ON auth_membership AS PERMISSIVE FOR ALL TO zabuni_owner
  USING (true) WITH CHECK (true);

REVOKE ALL ON auth_identity, auth_session, auth_account, auth_verification, auth_rate_limit,
  auth_membership, auth_onboarding_audit FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_identity, auth_session, auth_account,
  auth_verification, auth_rate_limit TO zabuni_auth;
GRANT SELECT ON auth_membership TO zabuni_app;

-- SECURITY DEFINER does not bypass FORCE RLS. These owner-only policies still
-- require the same transaction-local tenant setting as ordinary request work.
CREATE POLICY tenants_provision_insert ON tenants AS PERMISSIVE FOR INSERT TO zabuni_owner
  WITH CHECK (id = app.current_tenant_id());
CREATE POLICY tenants_provision_read ON tenants AS PERMISSIVE FOR SELECT TO zabuni_owner
  USING (id = app.current_tenant_id());
CREATE POLICY users_provision_insert ON users AS PERMISSIVE FOR INSERT TO zabuni_owner
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE OR REPLACE FUNCTION app.provision_tenant_owner(
  p_identity_id uuid,
  p_tenant_id uuid,
  p_user_id uuid,
  p_membership_id uuid,
  p_audit_id uuid,
  p_legal_name text
)
RETURNS TABLE (tenant_id uuid, user_id uuid, membership_id uuid, membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  identity_row auth_identity%ROWTYPE;
BEGIN
  IF p_legal_name IS NULL OR btrim(p_legal_name) = '' THEN
    RAISE EXCEPTION 'Tenant legal name is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO identity_row FROM auth_identity WHERE id = p_identity_id FOR UPDATE;
  IF NOT FOUND OR NOT (identity_row.email_verified OR identity_row.phone_number_verified) THEN
    RAISE EXCEPTION 'A verified identity is required' USING ERRCODE = '28000';
  END IF;
  IF EXISTS (SELECT 1 FROM auth_membership m WHERE m.identity_id = p_identity_id) THEN
    RAISE EXCEPTION 'Identity already has a tenant membership' USING ERRCODE = '23505';
  END IF;

  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);
  INSERT INTO tenants (id, legal_name, plan, status)
    VALUES (p_tenant_id, p_legal_name, 'foundation', 'active');
  INSERT INTO users (id, tenant_id, phone_e164, email, name, role)
    VALUES (
      p_user_id,
      p_tenant_id,
      identity_row.phone_number,
      identity_row.email,
      identity_row.name,
      'owner'
    );
  INSERT INTO auth_membership (id, identity_id, tenant_id, user_id, role)
    VALUES (p_membership_id, p_identity_id, p_tenant_id, p_user_id, 'owner');
  INSERT INTO auth_onboarding_audit (id, identity_id, scope_id, membership_id, action)
    VALUES (p_audit_id, p_identity_id, p_tenant_id, p_membership_id, 'tenant_owner_created');

  RETURN QUERY SELECT p_tenant_id, p_user_id, p_membership_id, 'owner'::text;
END
$function$;

ALTER FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text)
  OWNER TO zabuni_owner;

CREATE OR REPLACE FUNCTION app.resolve_identity_membership(p_identity_id uuid)
RETURNS TABLE (tenant_id uuid, user_id uuid, membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  resolved_tenant_id uuid;
  membership_count integer;
BEGIN
  SELECT count(*)::integer INTO membership_count
    FROM auth_membership m
    WHERE m.identity_id = p_identity_id AND m.status = 'active';
  IF membership_count <> 1 THEN
    RETURN;
  END IF;
  SELECT m.tenant_id INTO resolved_tenant_id
    FROM auth_membership m
    WHERE m.identity_id = p_identity_id AND m.status = 'active';

  PERFORM set_config('app.tenant_id', resolved_tenant_id::text, true);
  RETURN QUERY
    SELECT m.tenant_id, m.user_id, m.role
    FROM auth_membership m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.identity_id = p_identity_id
      AND m.status = 'active'
      AND t.status = 'active';
END
$function$;

ALTER FUNCTION app.resolve_identity_membership(uuid) OWNER TO zabuni_owner;

REVOKE ALL ON FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.resolve_identity_membership(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text)
  TO zabuni_app;
GRANT EXECUTE ON FUNCTION app.resolve_identity_membership(uuid) TO zabuni_app;
