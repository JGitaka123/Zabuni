CREATE POLICY item_embeddings_catalog_matching_owner
  ON item_embeddings AS PERMISSIVE FOR ALL TO zabuni_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY item_aliases_catalog_matching_owner
  ON item_aliases AS PERMISSIVE FOR ALL TO zabuni_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE FUNCTION app.upsert_catalog_item_embedding(
  p_item_id uuid,
  p_embedding public.vector,
  p_normalized_text text,
  p_content_hash text,
  p_provider text,
  p_model text,
  p_model_version text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
DECLARE
  current_tenant_id uuid := app.current_tenant_id();
BEGIN
  IF current_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant context is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.items
    WHERE tenant_id = current_tenant_id AND id = p_item_id AND active
  ) THEN
    RAISE EXCEPTION 'Embedding item was not found or is inactive'
      USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO public.item_embeddings (
    item_id, tenant_id, embedding, normalized_text, content_hash,
    provider, model, model_version
  ) VALUES (
    p_item_id, current_tenant_id, p_embedding, p_normalized_text, p_content_hash,
    p_provider, p_model, p_model_version
  )
  ON CONFLICT (item_id) DO UPDATE SET
    embedding = EXCLUDED.embedding,
    normalized_text = EXCLUDED.normalized_text,
    content_hash = EXCLUDED.content_hash,
    provider = EXCLUDED.provider,
    model = EXCLUDED.model,
    model_version = EXCLUDED.model_version,
    updated_at = CURRENT_TIMESTAMP
  WHERE public.item_embeddings.tenant_id = current_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Embedding item is outside the tenant boundary'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END
$function$;

CREATE FUNCTION app.delete_catalog_item_embedding(p_item_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
DECLARE
  current_tenant_id uuid := app.current_tenant_id();
  removed boolean;
BEGIN
  IF current_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant context is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.item_embeddings
  WHERE tenant_id = current_tenant_id AND item_id = p_item_id
  RETURNING true INTO removed;
  RETURN coalesce(removed, false);
END
$function$;

CREATE FUNCTION app.assign_catalog_item_alias(
  p_alias_id uuid,
  p_item_id uuid,
  p_alias_text text,
  p_source text,
  p_reassign boolean
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
DECLARE
  current_tenant_id uuid := app.current_tenant_id();
  existing_alias public.item_aliases%ROWTYPE;
BEGIN
  IF current_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant context is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_alias_id IS NULL OR p_alias_id::text !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_item_id IS NULL
     OR p_alias_text IS NULL
     OR p_alias_text <> btrim(p_alias_text)
     OR p_alias_text <> lower(p_alias_text)
     OR p_alias_text = ''
     OR char_length(p_alias_text) > 1000
     OR p_alias_text ~ '[[:cntrl:]]'
     OR p_source IS NULL OR p_source NOT IN ('human', 'accepted_match')
     OR p_reassign IS NULL THEN
    RAISE EXCEPTION 'Alias assignment is invalid'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.items
    WHERE tenant_id = current_tenant_id AND id = p_item_id AND active
  ) THEN
    RAISE EXCEPTION 'Alias item was not found or is inactive'
      USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(current_tenant_id::text, 734921));
  SELECT * INTO existing_alias
  FROM public.item_aliases
  WHERE tenant_id = current_tenant_id AND lower(alias_text) = lower(p_alias_text)
  FOR UPDATE;

  IF FOUND THEN
    IF existing_alias.item_id = p_item_id THEN
      RETURN existing_alias.id;
    END IF;
    IF NOT p_reassign THEN
      RAISE EXCEPTION 'Alias is already assigned to another item'
        USING ERRCODE = 'unique_violation';
    END IF;
    UPDATE public.item_aliases SET
      item_id = p_item_id,
      source = p_source,
      hit_count = 0,
      last_used_at = NULL
    WHERE tenant_id = current_tenant_id AND id = existing_alias.id;
    RETURN existing_alias.id;
  END IF;

  INSERT INTO public.item_aliases (
    id, tenant_id, item_id, alias_text, source
  ) VALUES (
    p_alias_id, current_tenant_id, p_item_id, p_alias_text, p_source
  );
  RETURN p_alias_id;
END
$function$;

CREATE FUNCTION app.delete_catalog_item_alias(p_alias_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
DECLARE
  current_tenant_id uuid := app.current_tenant_id();
  removed boolean;
BEGIN
  IF current_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant context is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM public.item_aliases
  WHERE tenant_id = current_tenant_id AND id = p_alias_id
  RETURNING true INTO removed;
  RETURN coalesce(removed, false);
END
$function$;

CREATE FUNCTION app.confirm_catalog_item_alias(p_alias_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $function$
DECLARE
  current_tenant_id uuid := app.current_tenant_id();
BEGIN
  IF current_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Tenant context is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.item_aliases SET
    hit_count = hit_count + 1,
    last_used_at = CURRENT_TIMESTAMP
  WHERE tenant_id = current_tenant_id AND id = p_alias_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Alias was not found'
      USING ERRCODE = 'no_data_found';
  END IF;
END
$function$;

ALTER FUNCTION app.upsert_catalog_item_embedding(
  uuid, public.vector, text, text, text, text, text
) OWNER TO zabuni_owner;
ALTER FUNCTION app.delete_catalog_item_embedding(uuid) OWNER TO zabuni_owner;
ALTER FUNCTION app.assign_catalog_item_alias(uuid, uuid, text, text, boolean)
  OWNER TO zabuni_owner;
ALTER FUNCTION app.delete_catalog_item_alias(uuid) OWNER TO zabuni_owner;
ALTER FUNCTION app.confirm_catalog_item_alias(uuid) OWNER TO zabuni_owner;

DROP POLICY item_embeddings_insert ON item_embeddings;
DROP POLICY item_embeddings_update ON item_embeddings;
DROP POLICY item_embeddings_delete ON item_embeddings;
DROP POLICY item_aliases_insert ON item_aliases;
DROP POLICY item_aliases_update ON item_aliases;
DROP POLICY item_aliases_delete ON item_aliases;
REVOKE INSERT, UPDATE, DELETE ON item_embeddings, item_aliases FROM zabuni_app;

REVOKE ALL ON FUNCTION app.upsert_catalog_item_embedding(
  uuid, public.vector, text, text, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delete_catalog_item_embedding(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.assign_catalog_item_alias(uuid, uuid, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delete_catalog_item_alias(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.confirm_catalog_item_alias(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.upsert_catalog_item_embedding(
  uuid, public.vector, text, text, text, text, text
) TO zabuni_app;
GRANT EXECUTE ON FUNCTION app.delete_catalog_item_embedding(uuid) TO zabuni_app;
GRANT EXECUTE ON FUNCTION app.assign_catalog_item_alias(uuid, uuid, text, text, boolean)
  TO zabuni_app;
GRANT EXECUTE ON FUNCTION app.delete_catalog_item_alias(uuid) TO zabuni_app;
GRANT EXECUTE ON FUNCTION app.confirm_catalog_item_alias(uuid) TO zabuni_app;
