-- Tenant provisioning must not depend on the auth plugin supplying a name.
--
-- app.provision_tenant_owner copied auth_identity.name straight into users.name.
-- The phone plugin populated that via getTempName; email OTP leaves it empty, so
-- onboarding failed the users_name_not_blank check and returned a 500 on the very
-- first action a new tenant takes.
--
-- The owner's display name is now passed explicitly, falling back to the identity
-- name and then to the email local part, so a blank can never reach the insert.

DROP FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text);

CREATE FUNCTION app.provision_tenant_owner(
  p_identity_id uuid,
  p_tenant_id uuid,
  p_user_id uuid,
  p_membership_id uuid,
  p_audit_id uuid,
  p_legal_name text,
  p_full_name text
)
RETURNS TABLE (tenant_id uuid, user_id uuid, membership_id uuid, membership_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  identity_row auth_identity%ROWTYPE;
  resolved_name text;
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

  resolved_name := COALESCE(
    NULLIF(btrim(p_full_name), ''),
    NULLIF(btrim(identity_row.name), ''),
    NULLIF(split_part(COALESCE(identity_row.email, ''), '@', 1), '')
  );
  IF resolved_name IS NULL THEN
    RAISE EXCEPTION 'Owner display name could not be resolved' USING ERRCODE = '22023';
  END IF;
  IF length(resolved_name) > 200 THEN
    resolved_name := left(resolved_name, 200);
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
      resolved_name,
      'owner'
    );
  INSERT INTO auth_membership (id, identity_id, tenant_id, user_id, role)
    VALUES (p_membership_id, p_identity_id, p_tenant_id, p_user_id, 'owner');
  INSERT INTO auth_onboarding_audit (id, identity_id, scope_id, membership_id, action)
    VALUES (p_audit_id, p_identity_id, p_tenant_id, p_membership_id, 'tenant_owner_created');

  RETURN QUERY SELECT p_tenant_id, p_user_id, p_membership_id, 'owner'::text;
END
$function$;

ALTER FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text, text)
  OWNER TO zabuni_owner;
REVOKE ALL ON FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text, text)
  TO zabuni_app;
