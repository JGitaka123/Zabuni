CREATE TABLE catalog_imports (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  source_filename text NOT NULL,
  status text NOT NULL DEFAULT 'staged',
  column_mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_rows integer NOT NULL DEFAULT 0,
  valid_rows integer NOT NULL DEFAULT 0,
  invalid_rows integer NOT NULL DEFAULT 0,
  created_by_user_id uuid,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_imports_tenant_id_tenants_id_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT catalog_imports_tenant_created_by_user_fk
    FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT catalog_imports_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT catalog_imports_source_filename_not_blank CHECK (btrim(source_filename) <> ''),
  CONSTRAINT catalog_imports_status_check CHECK (status IN ('staged', 'committed', 'failed')),
  CONSTRAINT catalog_imports_column_mapping_object_check
    CHECK (jsonb_typeof(column_mapping) = 'object'),
  CONSTRAINT catalog_imports_row_counts_check CHECK (
    total_rows >= 0 AND valid_rows >= 0 AND invalid_rows >= 0
    AND valid_rows + invalid_rows <= total_rows
  ),
  CONSTRAINT catalog_imports_commit_state_check CHECK (
    (status = 'committed' AND committed_at IS NOT NULL)
    OR (status <> 'committed' AND committed_at IS NULL)
  ),
  CONSTRAINT catalog_imports_commit_counts_check CHECK (
    status <> 'committed' OR (invalid_rows = 0 AND valid_rows = total_rows)
  )
);

CREATE INDEX catalog_imports_tenant_status_created_idx
  ON catalog_imports (tenant_id, status, created_at DESC);

CREATE TABLE catalog_import_rows (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  import_id uuid NOT NULL,
  row_number integer NOT NULL,
  raw_data jsonb NOT NULL,
  sku text,
  description text,
  brand text,
  pack_size text,
  uom text,
  cost_minor bigint,
  cost_currency char(3),
  fx_buffer_bps integer,
  tax_class text,
  kra_item_code text,
  hs_code text,
  lead_time_days integer,
  min_margin_bps integer,
  active boolean,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_import_rows_tenant_id_tenants_id_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT catalog_import_rows_tenant_import_fk
    FOREIGN KEY (tenant_id, import_id) REFERENCES catalog_imports (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT catalog_import_rows_tenant_id_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT catalog_import_rows_tenant_import_row_unique
    UNIQUE (tenant_id, import_id, row_number),
  CONSTRAINT catalog_import_rows_row_number_check CHECK (row_number > 0),
  CONSTRAINT catalog_import_rows_raw_data_object_check CHECK (jsonb_typeof(raw_data) = 'object'),
  CONSTRAINT catalog_import_rows_sku_not_blank CHECK (sku IS NULL OR btrim(sku) <> ''),
  CONSTRAINT catalog_import_rows_description_not_blank
    CHECK (description IS NULL OR btrim(description) <> ''),
  CONSTRAINT catalog_import_rows_tax_class_check CHECK (
    tax_class IS NULL OR tax_class IN ('standard_16', 'zero_rated', 'exempt')
  ),
  CONSTRAINT catalog_import_rows_cost_pair_check
    CHECK ((cost_minor IS NULL) = (cost_currency IS NULL)),
  CONSTRAINT catalog_import_rows_cost_nonnegative_check
    CHECK (cost_minor IS NULL OR cost_minor >= 0),
  CONSTRAINT catalog_import_rows_cost_currency_check
    CHECK (cost_currency IS NULL OR cost_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT catalog_import_rows_fx_buffer_bps_check
    CHECK (fx_buffer_bps IS NULL OR fx_buffer_bps >= 0),
  CONSTRAINT catalog_import_rows_lead_time_days_check
    CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  CONSTRAINT catalog_import_rows_min_margin_bps_check
    CHECK (min_margin_bps IS NULL OR min_margin_bps BETWEEN 0 AND 10000),
  CONSTRAINT catalog_import_rows_validation_errors_array_check
    CHECK (jsonb_typeof(validation_errors) = 'array')
);

CREATE INDEX catalog_import_rows_tenant_import_idx
  ON catalog_import_rows (tenant_id, import_id, row_number);
CREATE INDEX catalog_import_rows_tenant_import_errors_idx
  ON catalog_import_rows (tenant_id, import_id)
  WHERE validation_errors <> '[]'::jsonb;

ALTER TABLE catalog_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_imports_read ON catalog_imports AS PERMISSIVE FOR SELECT TO zabuni_app
  USING (true);
CREATE POLICY catalog_imports_insert ON catalog_imports AS PERMISSIVE FOR INSERT TO zabuni_app
  WITH CHECK (true);
CREATE POLICY catalog_imports_update ON catalog_imports AS PERMISSIVE FOR UPDATE TO zabuni_app
  USING (status = 'staged') WITH CHECK (true);
CREATE POLICY catalog_imports_delete ON catalog_imports AS PERMISSIVE FOR DELETE TO zabuni_app
  USING (status IN ('staged', 'failed'));
CREATE POLICY catalog_imports_boundary ON catalog_imports AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

ALTER TABLE catalog_import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_import_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_import_rows_read ON catalog_import_rows AS PERMISSIVE FOR SELECT TO zabuni_app
  USING (true);
CREATE POLICY catalog_import_rows_insert ON catalog_import_rows AS PERMISSIVE FOR INSERT TO zabuni_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM catalog_imports
    WHERE catalog_imports.tenant_id = catalog_import_rows.tenant_id
      AND catalog_imports.id = catalog_import_rows.import_id
      AND catalog_imports.status = 'staged'
  ));
CREATE POLICY catalog_import_rows_update ON catalog_import_rows AS PERMISSIVE FOR UPDATE TO zabuni_app
  USING (EXISTS (
    SELECT 1 FROM catalog_imports
    WHERE catalog_imports.tenant_id = catalog_import_rows.tenant_id
      AND catalog_imports.id = catalog_import_rows.import_id
      AND catalog_imports.status = 'staged'
  )) WITH CHECK (EXISTS (
    SELECT 1 FROM catalog_imports
    WHERE catalog_imports.tenant_id = catalog_import_rows.tenant_id
      AND catalog_imports.id = catalog_import_rows.import_id
      AND catalog_imports.status = 'staged'
  ));
CREATE POLICY catalog_import_rows_boundary ON catalog_import_rows AS RESTRICTIVE FOR ALL TO zabuni_app
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY items_write ON items AS PERMISSIVE FOR INSERT TO zabuni_app WITH CHECK (true);
CREATE POLICY items_update ON items AS PERMISSIVE FOR UPDATE TO zabuni_app
  USING (true) WITH CHECK (true);

REVOKE ALL ON catalog_imports, catalog_import_rows FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON catalog_imports, catalog_import_rows TO zabuni_app;
GRANT DELETE ON catalog_imports TO zabuni_app;

GRANT INSERT (
  id, tenant_id, sku, description, brand, pack_size, uom, cost_minor, cost_currency,
  fx_buffer_bps, tax_class, kra_item_code, hs_code, lead_time_days, min_margin_bps, active,
  created_at
) ON items TO zabuni_app;
GRANT UPDATE (
  sku, description, brand, pack_size, uom, cost_minor, cost_currency, fx_buffer_bps,
  tax_class, kra_item_code, hs_code, lead_time_days, min_margin_bps, active
) ON items TO zabuni_app;
