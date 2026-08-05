CREATE TABLE items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  sku text NOT NULL,
  description text NOT NULL,
  brand text,
  pack_size text,
  uom text,
  cost_minor bigint,
  cost_currency char(3),
  fx_buffer_bps integer,
  tax_class text NOT NULL,
  kra_item_code text,
  hs_code text,
  lead_time_days integer,
  min_margin_bps integer,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT items_tenant_id_tenants_id_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT items_sku_not_blank CHECK (btrim(sku) <> ''),
  CONSTRAINT items_description_not_blank CHECK (btrim(description) <> ''),
  CONSTRAINT items_tax_class_check CHECK (tax_class IN ('standard_16', 'zero_rated', 'exempt')),
  CONSTRAINT items_cost_pair_check CHECK ((cost_minor IS NULL) = (cost_currency IS NULL)),
  CONSTRAINT items_cost_nonnegative_check CHECK (cost_minor IS NULL OR cost_minor >= 0),
  CONSTRAINT items_cost_currency_check CHECK (cost_currency IS NULL OR cost_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT items_fx_buffer_bps_check CHECK (fx_buffer_bps IS NULL OR fx_buffer_bps >= 0),
  CONSTRAINT items_lead_time_days_check CHECK (lead_time_days IS NULL OR lead_time_days >= 0),
  CONSTRAINT items_min_margin_bps_check CHECK (min_margin_bps IS NULL OR min_margin_bps BETWEEN 0 AND 10000)
);

CREATE UNIQUE INDEX items_tenant_id_id_unique ON items (tenant_id, id);
CREATE UNIQUE INDEX items_tenant_sku_unique ON items (tenant_id, sku);
CREATE INDEX items_tenant_active_idx ON items (tenant_id, active);
