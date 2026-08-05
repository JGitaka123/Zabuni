ALTER TABLE usage_events DROP CONSTRAINT usage_events_metric_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_metric_check CHECK (
  metric IN (
    'rfq_parsed',
    'quote_sent',
    'invoice_transmitted',
    'wa_template_sent',
    'sms_sent',
    'llm_tokens',
    'llm_call',
    'payment_processed'
  )
);

ALTER TABLE usage_events ADD COLUMN idempotency_key text;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_idempotency_key_check CHECK (
  idempotency_key IS NULL
  OR (btrim(idempotency_key) <> '' AND length(idempotency_key) <= 128)
);

CREATE UNIQUE INDEX usage_events_tenant_idempotency_unique
  ON usage_events (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN usage_events.unit_cost_minor IS
  'Total event cost in minor currency units when metric = llm_call and quantity = 1.';

REVOKE UPDATE, DELETE ON usage_events FROM zabuni_app;
