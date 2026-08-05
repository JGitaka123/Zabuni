CREATE TABLE outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  event_type text NOT NULL,
  payload_version integer NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  claimed_by text,
  last_error text,
  result_ref text,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_tenant_id_tenants_id_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT outbox_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT outbox_payload_version_check CHECK (payload_version > 0),
  CONSTRAINT outbox_state_check CHECK (state IN ('pending', 'processing', 'sent', 'failed_permanent', 'cancelled')),
  CONSTRAINT outbox_attempt_count_check CHECK (attempt_count >= 0 AND attempt_count <= max_attempts),
  CONSTRAINT outbox_max_attempts_check CHECK (max_attempts > 0)
);

CREATE UNIQUE INDEX outbox_tenant_id_id_unique ON outbox (tenant_id, id);
CREATE UNIQUE INDEX outbox_tenant_idempotency_unique ON outbox (tenant_id, idempotency_key);
CREATE INDEX outbox_ready_idx ON outbox (next_attempt_at, created_at)
  WHERE state IN ('pending', 'processing');

CREATE TABLE incidents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  outbox_id uuid,
  kind text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT incidents_tenant_id_tenants_id_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT incidents_tenant_outbox_fk
    FOREIGN KEY (tenant_id, outbox_id) REFERENCES outbox (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT incidents_kind_not_blank CHECK (btrim(kind) <> ''),
  CONSTRAINT incidents_summary_not_blank CHECK (btrim(summary) <> ''),
  CONSTRAINT incidents_status_check CHECK (status IN ('open', 'resolved')),
  CONSTRAINT incidents_resolution_check CHECK (
    (status = 'resolved' AND resolved_at IS NOT NULL)
    OR (status = 'open' AND resolved_at IS NULL)
  )
);

CREATE UNIQUE INDEX incidents_tenant_id_id_unique ON incidents (tenant_id, id);
CREATE UNIQUE INDEX incidents_tenant_outbox_unique ON incidents (tenant_id, outbox_id) WHERE outbox_id IS NOT NULL;
CREATE INDEX incidents_tenant_status_created_idx ON incidents (tenant_id, status, created_at);
