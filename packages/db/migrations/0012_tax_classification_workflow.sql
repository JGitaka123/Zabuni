CREATE TABLE catalog_tax_classifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  item_id uuid,
  import_row_id uuid,
  previous_tax_class text,
  tax_class text NOT NULL,
  source text NOT NULL,
  basis_note text NOT NULL,
  classified_by_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_tax_classifications_tenant_id_tenants_id_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT catalog_tax_classifications_tenant_import_row_fk
    FOREIGN KEY (tenant_id, import_row_id)
    REFERENCES catalog_import_rows (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catalog_tax_classifications_tenant_item_fk
    FOREIGN KEY (tenant_id, item_id)
    REFERENCES items (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catalog_tax_classifications_tenant_user_fk
    FOREIGN KEY (tenant_id, classified_by_user_id)
    REFERENCES users (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT catalog_tax_classifications_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT catalog_tax_classifications_tax_class_check
    CHECK (tax_class IN ('standard_16', 'zero_rated', 'exempt')),
  CONSTRAINT catalog_tax_classifications_previous_tax_class_check
    CHECK (previous_tax_class IS NULL OR previous_tax_class IN ('standard_16', 'zero_rated', 'exempt')),
  CONSTRAINT catalog_tax_classifications_target_check
    CHECK (item_id IS NOT NULL OR import_row_id IS NOT NULL),
  CONSTRAINT catalog_tax_classifications_source_check
    CHECK (source IN ('manual_create', 'manual_change', 'import_file', 'import_human')),
  CONSTRAINT catalog_tax_classifications_basis_note_check
    CHECK (btrim(basis_note) <> '' AND length(basis_note) <= 1000)
);

CREATE INDEX catalog_tax_classifications_tenant_row_created_idx
  ON catalog_tax_classifications (tenant_id, import_row_id, created_at DESC)
  WHERE import_row_id IS NOT NULL;
CREATE INDEX catalog_tax_classifications_tenant_item_created_idx
  ON catalog_tax_classifications (tenant_id, item_id, created_at DESC)
  WHERE item_id IS NOT NULL;

ALTER TABLE catalog_tax_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_tax_classifications FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_tax_classifications_read ON catalog_tax_classifications
  AS PERMISSIVE FOR SELECT TO zabuni_app USING (true);
CREATE POLICY catalog_tax_classifications_insert ON catalog_tax_classifications
  AS PERMISSIVE FOR INSERT TO zabuni_app WITH CHECK (true);
CREATE POLICY catalog_tax_classifications_boundary ON catalog_tax_classifications
  AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON catalog_tax_classifications FROM PUBLIC;
GRANT SELECT, INSERT ON catalog_tax_classifications TO zabuni_app;

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
      validation_errors <> '[]'::jsonb
      OR sku IS NULL OR description IS NULL OR tax_class IS NULL OR active IS NULL
    )
    INTO actual_rows, unready_rows
    FROM public.catalog_import_rows
    WHERE tenant_id = NEW.tenant_id AND import_id = NEW.id;

    IF actual_rows <> NEW.total_rows OR unready_rows <> 0
       OR NEW.valid_rows <> NEW.total_rows OR NEW.invalid_rows <> 0 THEN
      RAISE EXCEPTION 'catalog import contains unclassified or invalid rows'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER catalog_import_commit_ready
BEFORE UPDATE OF status ON catalog_imports
FOR EACH ROW EXECUTE FUNCTION app.enforce_catalog_import_commit_ready();
