CREATE POLICY catalog_match_rate_limits_owner
  ON catalog_match_rate_limits AS PERMISSIVE FOR ALL TO zabuni_owner
  USING (true)
  WITH CHECK (true);

CREATE POLICY users_catalog_rate_limit_owner_read
  ON users AS PERMISSIVE FOR SELECT TO zabuni_owner
  USING (tenant_id = app.current_tenant_id());

CREATE OR REPLACE FUNCTION app.consume_catalog_rate_limit(
  p_operation text,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
DECLARE
  accepted boolean;
  current_tenant_id uuid;
  rate_key text;
  rate_limit integer;
BEGIN
  current_tenant_id := app.current_tenant_id();

  IF p_operation IS NULL OR p_operation NOT IN ('match', 'alias') THEN
    RAISE EXCEPTION 'Invalid tenant catalog rate-limit request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.users
    WHERE tenant_id = current_tenant_id AND id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Invalid tenant catalog rate-limit user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  rate_key := current_tenant_id::text || ':' || p_operation || ':' ||
    CASE
      WHEN p_user_id IS NULL THEN 'tenant'
      ELSE 'user:' || p_user_id::text
    END;
  rate_limit := CASE
    WHEN p_operation = 'match' AND p_user_id IS NOT NULL THEN 30
    WHEN p_operation = 'match' THEN 300
    WHEN p_user_id IS NOT NULL THEN 20
    ELSE 200
  END;

  INSERT INTO public.catalog_match_rate_limits (
    key, tenant_id, request_count, window_started_at
  ) VALUES (
    rate_key, current_tenant_id, 1, CURRENT_TIMESTAMP
  )
  ON CONFLICT (key) DO UPDATE SET
    request_count = CASE
      WHEN public.catalog_match_rate_limits.window_started_at
        <= CURRENT_TIMESTAMP - INTERVAL '60 seconds' THEN 1
      ELSE public.catalog_match_rate_limits.request_count + 1
    END,
    window_started_at = CASE
      WHEN public.catalog_match_rate_limits.window_started_at
        <= CURRENT_TIMESTAMP - INTERVAL '60 seconds' THEN CURRENT_TIMESTAMP
      ELSE public.catalog_match_rate_limits.window_started_at
    END
  WHERE public.catalog_match_rate_limits.tenant_id = EXCLUDED.tenant_id
    AND (
      public.catalog_match_rate_limits.window_started_at
        <= CURRENT_TIMESTAMP - INTERVAL '60 seconds'
      OR public.catalog_match_rate_limits.request_count < rate_limit
    )
  RETURNING true INTO accepted;

  RETURN coalesce(accepted, false);
END
$function$;

DROP POLICY catalog_match_rate_limits_insert ON catalog_match_rate_limits;
DROP POLICY catalog_match_rate_limits_update ON catalog_match_rate_limits;
REVOKE INSERT, UPDATE ON catalog_match_rate_limits FROM zabuni_app;

REVOKE ALL ON FUNCTION app.consume_catalog_rate_limit(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.consume_catalog_rate_limit(text, uuid) TO zabuni_app;
