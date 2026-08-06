DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM items item
    WHERE NOT EXISTS (
      SELECT 1 FROM catalog_tax_classifications evidence
      WHERE evidence.tenant_id = item.tenant_id
        AND evidence.item_id = item.id
        AND evidence.tax_class = item.tax_class
    )
  ) THEN
    RAISE EXCEPTION 'tax evidence backfill required for existing catalog items before Q-2 deployment';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM catalog_import_rows row
    JOIN catalog_imports batch
      ON batch.tenant_id = row.tenant_id AND batch.id = row.import_id
    WHERE batch.status = 'committed'
      AND NOT EXISTS (
        SELECT 1 FROM catalog_tax_classifications evidence
        WHERE evidence.tenant_id = row.tenant_id
          AND evidence.import_row_id = row.id
          AND evidence.tax_class = row.tax_class
      )
  ) THEN
    RAISE EXCEPTION 'tax evidence backfill required for committed catalog imports before Q-2 deployment';
  END IF;
END
$preflight$;
