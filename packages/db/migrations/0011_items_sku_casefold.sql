CREATE UNIQUE INDEX items_tenant_sku_casefold_unique
  ON items (tenant_id, lower(sku));
