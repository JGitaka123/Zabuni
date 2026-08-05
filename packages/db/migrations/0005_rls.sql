CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
GRANT USAGE ON SCHEMA app TO zabuni_app;

CREATE OR REPLACE FUNCTION app.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN current_setting('app.tenant_id', true) ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    THEN current_setting('app.tenant_id', true)::uuid
    ELSE NULL
  END
$function$;

REVOKE ALL ON FUNCTION app.current_tenant_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO zabuni_app;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_read ON tenants AS PERMISSIVE FOR SELECT TO zabuni_app USING (true);
CREATE POLICY tenants_boundary ON tenants AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (id = app.current_tenant_id()) WITH CHECK (id = app.current_tenant_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_read ON users AS PERMISSIVE FOR SELECT TO zabuni_app USING (true);
CREATE POLICY users_boundary ON users AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
CREATE POLICY items_read ON items AS PERMISSIVE FOR SELECT TO zabuni_app USING (true);
CREATE POLICY items_boundary ON items AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_events_read ON usage_events AS PERMISSIVE FOR SELECT TO zabuni_app USING (true);
CREATE POLICY usage_events_append ON usage_events AS PERMISSIVE FOR INSERT TO zabuni_app
  WITH CHECK (true);
CREATE POLICY usage_events_boundary ON usage_events AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_read ON outbox AS PERMISSIVE FOR SELECT TO zabuni_app USING (true);
CREATE POLICY outbox_enqueue ON outbox AS PERMISSIVE FOR INSERT TO zabuni_app WITH CHECK (true);
CREATE POLICY outbox_boundary ON outbox AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY incidents_read ON incidents AS PERMISSIVE FOR SELECT TO zabuni_app USING (true);
CREATE POLICY incidents_boundary ON incidents AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON tenants, users, items, usage_events, outbox, incidents FROM PUBLIC;
GRANT SELECT ON tenants, users, items, usage_events, outbox, incidents TO zabuni_app;
GRANT INSERT ON usage_events, outbox TO zabuni_app;
