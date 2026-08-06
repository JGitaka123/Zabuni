ALTER TABLE catalog_tax_classifications
  ADD CONSTRAINT catalog_tax_classifications_source_target_check CHECK (
    (source IN ('manual_create', 'manual_change') AND item_id IS NOT NULL AND import_row_id IS NULL)
    OR (source IN ('import_file', 'import_human') AND import_row_id IS NOT NULL)
  );

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
  IF p_tax_class IS NULL OR p_tax_class NOT IN ('standard_16', 'zero_rated', 'exempt')
     OR p_source IS NULL OR p_source NOT IN ('manual_create', 'import_file', 'import_human')
     OR p_basis_note IS NULL OR btrim(p_basis_note) = '' OR length(p_basis_note) > 1000 THEN
    RAISE EXCEPTION 'classification evidence is invalid' USING ERRCODE = '23514';
  END IF;
  IF p_source = 'manual_create' AND (p_item_id IS NULL OR p_import_row_id IS NOT NULL) THEN
    RAISE EXCEPTION 'manual creation evidence requires only an item target' USING ERRCODE = '23514';
  END IF;
  IF p_source IN ('import_file', 'import_human') AND p_import_row_id IS NULL THEN
    RAISE EXCEPTION 'import evidence requires an import row target' USING ERRCODE = '23514';
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
ALTER FUNCTION app.record_tax_classification(uuid, uuid, uuid, text, text, text, uuid)
  OWNER TO zabuni_owner;

CREATE OR REPLACE FUNCTION app.enforce_catalog_import_commit_ready()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app
AS $$
DECLARE
  actual_rows integer;
  unready_rows integer;
BEGIN
  IF NEW.status = 'committed' AND OLD.status <> 'committed' THEN
    SELECT count(*), count(*) FILTER (WHERE
      row.validation_errors <> '[]'::jsonb
      OR row.sku IS NULL OR row.description IS NULL OR row.tax_class IS NULL OR row.active IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM public.catalog_tax_classifications evidence
        WHERE evidence.tenant_id = row.tenant_id
          AND evidence.import_row_id = row.id
          AND evidence.tax_class = row.tax_class
      )
    )
    INTO actual_rows, unready_rows
    FROM public.catalog_import_rows row
    WHERE row.tenant_id = NEW.tenant_id AND row.import_id = NEW.id;

    IF actual_rows <> NEW.total_rows OR unready_rows <> 0
       OR NEW.valid_rows <> NEW.total_rows OR NEW.invalid_rows <> 0 THEN
      RAISE EXCEPTION 'catalog import contains unclassified, unaudited, or invalid rows'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_item_tax_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, app
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.catalog_tax_classifications evidence
    WHERE evidence.tenant_id = NEW.tenant_id
      AND evidence.item_id = NEW.id
      AND evidence.tax_class = NEW.tax_class
  ) THEN
    RAISE EXCEPTION 'catalog item tax classification lacks evidence'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER items_tax_evidence_required
AFTER INSERT OR UPDATE OF tax_class ON items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app.enforce_item_tax_evidence();
