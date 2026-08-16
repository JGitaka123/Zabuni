-- Restore the pre-0019 tenant-provisioning signature as a compatibility
-- overload. Migration 0019 replaced the six-argument function in one step,
-- which meant a database rollout could not safely overlap with the previous
-- application version. Keep both signatures through the deployment window;
-- a later contract migration may remove this overload after rollback support
-- is no longer required.

CREATE FUNCTION app.provision_tenant_owner(
  p_identity_id uuid,
  p_tenant_id uuid,
  p_user_id uuid,
  p_membership_id uuid,
  p_audit_id uuid,
  p_legal_name text
)
RETURNS TABLE (tenant_id uuid, user_id uuid, membership_id uuid, membership_role text)
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $function$
  SELECT *
  FROM app.provision_tenant_owner(
    p_identity_id,
    p_tenant_id,
    p_user_id,
    p_membership_id,
    p_audit_id,
    p_legal_name,
    NULL::text
  )
$function$;

ALTER FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text)
  OWNER TO zabuni_owner;
REVOKE ALL ON FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.provision_tenant_owner(uuid, uuid, uuid, uuid, uuid, text)
  TO zabuni_app;
