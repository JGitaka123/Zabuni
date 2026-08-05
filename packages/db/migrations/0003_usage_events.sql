CREATE TABLE usage_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  metric text NOT NULL,
  quantity bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  unit_cost_minor bigint NOT NULL,
  cost_currency char(3) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_events_tenant_id_tenants_id_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT usage_events_metric_check CHECK (
    metric IN (
      'rfq_parsed',
      'quote_sent',
      'invoice_transmitted',
      'wa_template_sent',
      'sms_sent',
      'llm_tokens',
      'payment_processed'
    )
  ),
  CONSTRAINT usage_events_quantity_positive_check CHECK (quantity > 0),
  CONSTRAINT usage_events_unit_cost_nonnegative_check CHECK (unit_cost_minor >= 0),
  CONSTRAINT usage_events_currency_check CHECK (cost_currency ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX usage_events_tenant_id_id_unique ON usage_events (tenant_id, id);
CREATE INDEX usage_events_tenant_occurred_idx ON usage_events (tenant_id, occurred_at);
