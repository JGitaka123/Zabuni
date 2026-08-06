CREATE POLICY items_catalog_tax_owner ON items AS PERMISSIVE FOR ALL TO zabuni_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY catalog_imports_tax_owner ON catalog_imports AS PERMISSIVE FOR ALL TO zabuni_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY catalog_import_rows_tax_owner ON catalog_import_rows AS PERMISSIVE FOR ALL TO zabuni_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
CREATE POLICY catalog_tax_classifications_tax_owner ON catalog_tax_classifications
  AS PERMISSIVE FOR ALL TO zabuni_owner
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE OR REPLACE FUNCTION app.record_tax_classification(
  p_event_id uuid,
  p_item_id uuid,
  p_import_row_id uuid,
  p_tax_class text,
  p_source text,
  p_basis_note text,
  p_user_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  tenant uuid := app.current_tenant_id();
BEGIN
  IF p_item_id IS NULL AND p_import_row_id IS NULL THEN
    RAISE EXCEPTION 'classification target is required' USING ERRCODE = '23514';
  END IF;
  IF p_tax_class NOT IN ('standard_16', 'zero_rated', 'exempt')
     OR p_source NOT IN ('manual_create', 'import_file')
     OR btrim(p_basis_note) = '' OR length(p_basis_note) > 1000 THEN
    RAISE EXCEPTION 'classification evidence is invalid' USING ERRCODE = '23514';
  END IF;
  IF p_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.items
    WHERE tenant_id = tenant AND id = p_item_id AND tax_class = p_tax_class
  ) THEN
    RAISE EXCEPTION 'item classification does not match target' USING ERRCODE = '23514';
  END IF;
  IF p_import_row_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.catalog_import_rows
    WHERE tenant_id = tenant AND id = p_import_row_id AND tax_class = p_tax_class
  ) THEN
    RAISE EXCEPTION 'import classification does not match target' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.catalog_tax_classifications (
    id, tenant_id, item_id, import_row_id, tax_class, source, basis_note,
    classified_by_user_id
  ) VALUES (
    p_event_id, tenant, p_item_id, p_import_row_id, p_tax_class, p_source,
    btrim(p_basis_note), p_user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION app.reclassify_catalog_item(
  p_event_id uuid,
  p_item_id uuid,
  p_tax_class text,
  p_basis_note text,
  p_user_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  tenant uuid := app.current_tenant_id();
  old_tax text;
BEGIN
  IF p_tax_class NOT IN ('standard_16', 'zero_rated', 'exempt')
     OR btrim(p_basis_note) = '' OR length(p_basis_note) > 1000 THEN
    RAISE EXCEPTION 'classification decision is invalid' USING ERRCODE = '23514';
  END IF;
  SELECT tax_class INTO old_tax FROM public.items
  WHERE tenant_id = tenant AND id = p_item_id FOR UPDATE;
  IF old_tax IS NULL THEN
    RAISE EXCEPTION 'catalog item was not found' USING ERRCODE = 'P0002';
  END IF;
  IF old_tax = p_tax_class THEN
    RAISE EXCEPTION 'catalog item tax class is unchanged' USING ERRCODE = '23514';
  END IF;
  UPDATE public.items SET tax_class = p_tax_class
  WHERE tenant_id = tenant AND id = p_item_id;
  INSERT INTO public.catalog_tax_classifications (
    id, tenant_id, item_id, previous_tax_class, tax_class, source, basis_note,
    classified_by_user_id
  ) VALUES (
    p_event_id, tenant, p_item_id, old_tax, p_tax_class, 'manual_change',
    btrim(p_basis_note), p_user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION app.classify_catalog_import_row(
  p_event_id uuid,
  p_import_id uuid,
  p_row_number integer,
  p_tax_class text,
  p_basis_note text,
  p_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  tenant uuid := app.current_tenant_id();
  target_row public.catalog_import_rows%ROWTYPE;
BEGIN
  IF p_tax_class NOT IN ('standard_16', 'zero_rated', 'exempt')
     OR btrim(p_basis_note) = '' OR length(p_basis_note) > 1000 THEN
    RAISE EXCEPTION 'classification decision is invalid' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.catalog_imports
  WHERE tenant_id = tenant AND id = p_import_id AND status = 'staged' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog import is not staged or was not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO target_row FROM public.catalog_import_rows
  WHERE tenant_id = tenant AND import_id = p_import_id AND row_number = p_row_number
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog import row was not found' USING ERRCODE = 'P0002';
  END IF;
  IF target_row.tax_class IS NOT NULL OR target_row.sku IS NULL
     OR target_row.description IS NULL OR target_row.active IS NULL
     OR target_row.validation_errors <> '["missing_required:taxClass"]'::jsonb THEN
    RAISE EXCEPTION 'row is not eligible for classification' USING ERRCODE = '23514';
  END IF;
  UPDATE public.catalog_import_rows
  SET tax_class = p_tax_class, validation_errors = '[]'::jsonb
  WHERE tenant_id = tenant AND id = target_row.id;
  UPDATE public.catalog_imports
  SET valid_rows = valid_rows + 1, invalid_rows = invalid_rows - 1, updated_at = now()
  WHERE tenant_id = tenant AND id = p_import_id AND status = 'staged' AND invalid_rows > 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalog import recount failed' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.catalog_tax_classifications (
    id, tenant_id, import_row_id, tax_class, source, basis_note, classified_by_user_id
  ) VALUES (
    p_event_id, tenant, target_row.id, p_tax_class, 'import_human',
    btrim(p_basis_note), p_user_id
  );
  RETURN target_row.id;
END;
$$;

ALTER FUNCTION app.record_tax_classification(uuid, uuid, uuid, text, text, text, uuid)
  OWNER TO zabuni_owner;
ALTER FUNCTION app.reclassify_catalog_item(uuid, uuid, text, text, uuid)
  OWNER TO zabuni_owner;
ALTER FUNCTION app.classify_catalog_import_row(uuid, uuid, integer, text, text, uuid)
  OWNER TO zabuni_owner;

REVOKE ALL ON FUNCTION app.record_tax_classification(uuid, uuid, uuid, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.reclassify_catalog_item(uuid, uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.classify_catalog_import_row(uuid, uuid, integer, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_tax_classification(uuid, uuid, uuid, text, text, text, uuid) TO zabuni_app;
GRANT EXECUTE ON FUNCTION app.reclassify_catalog_item(uuid, uuid, text, text, uuid) TO zabuni_app;
GRANT EXECUTE ON FUNCTION app.classify_catalog_import_row(uuid, uuid, integer, text, text, uuid) TO zabuni_app;

REVOKE INSERT ON catalog_tax_classifications FROM zabuni_app;
REVOKE UPDATE ON catalog_import_rows FROM zabuni_app;
REVOKE UPDATE (tax_class) ON items FROM zabuni_app;
