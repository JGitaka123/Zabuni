ALTER TABLE outbox ADD COLUMN claim_token uuid;

GRANT USAGE ON SCHEMA app, public TO zabuni_outbox_claim_owner, zabuni_worker;
GRANT CREATE ON SCHEMA app TO zabuni_outbox_claim_owner;
GRANT SELECT, UPDATE ON outbox TO zabuni_outbox_claim_owner;
GRANT INSERT ON incidents TO zabuni_outbox_claim_owner;

UPDATE outbox
SET state = 'pending',
    claimed_at = NULL,
    claim_expires_at = NULL,
    claimed_by = NULL,
    claim_token = NULL,
    terminal_at = NULL
WHERE state = 'processing';

UPDATE outbox
SET claimed_at = NULL,
    claim_expires_at = NULL,
    claimed_by = NULL,
    claim_token = NULL,
    terminal_at = coalesce(terminal_at, updated_at, statement_timestamp())
WHERE state IN ('sent', 'failed_permanent', 'cancelled');

UPDATE outbox
SET claimed_at = NULL,
    claim_expires_at = NULL,
    claimed_by = NULL,
    claim_token = NULL,
    terminal_at = NULL
WHERE state = 'pending';

ALTER TABLE outbox ADD CONSTRAINT outbox_claim_shape_check CHECK (
  (
    state = 'pending'
    AND claimed_at IS NULL
    AND claim_expires_at IS NULL
    AND claimed_by IS NULL
    AND claim_token IS NULL
    AND terminal_at IS NULL
  ) OR (
    state = 'processing'
    AND claimed_at IS NOT NULL
    AND claim_expires_at IS NOT NULL
    AND claimed_by IS NOT NULL
    AND claim_token IS NOT NULL
    AND terminal_at IS NULL
  ) OR (
    state IN ('sent', 'failed_permanent', 'cancelled')
    AND claimed_at IS NULL
    AND claim_expires_at IS NULL
    AND claimed_by IS NULL
    AND claim_token IS NULL
    AND terminal_at IS NOT NULL
  )
);

CREATE INDEX outbox_expired_lease_idx ON outbox (claim_expires_at, created_at)
  WHERE state = 'processing';

CREATE OR REPLACE FUNCTION app.claim_outbox(
  p_worker_id text,
  p_batch_size integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 60
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  event_type text,
  payload_version integer,
  payload jsonb,
  idempotency_key text,
  attempt_count integer,
  max_attempts integer,
  claimed_by text,
  claim_token uuid,
  claim_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 128 THEN
    RAISE EXCEPTION 'worker id must contain 1 to 128 characters';
  END IF;
  IF p_batch_size < 1 OR p_batch_size > 100 THEN
    RAISE EXCEPTION 'batch size must be between 1 and 100';
  END IF;
  IF p_lease_seconds < 5 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'lease must be between 5 and 900 seconds';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT candidate.id
    FROM public.outbox AS candidate
    WHERE (
      candidate.state = 'pending'
      AND candidate.next_attempt_at <= statement_timestamp()
      AND candidate.attempt_count < candidate.max_attempts
    ) OR (
      candidate.state = 'processing'
      AND candidate.claim_expires_at <= statement_timestamp()
    )
    ORDER BY candidate.next_attempt_at, candidate.created_at, candidate.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_batch_size
  )
  UPDATE public.outbox AS claimed
  SET state = 'processing',
      attempt_count = LEAST(claimed.attempt_count + 1, claimed.max_attempts),
      claimed_at = statement_timestamp(),
      claim_expires_at = statement_timestamp() + make_interval(secs => p_lease_seconds),
      claimed_by = p_worker_id,
      claim_token = gen_random_uuid(),
      updated_at = statement_timestamp()
  FROM candidates
  WHERE claimed.id = candidates.id
  RETURNING claimed.id,
            claimed.tenant_id,
            claimed.event_type,
            claimed.payload_version,
            claimed.payload,
            claimed.idempotency_key,
            claimed.attempt_count,
            claimed.max_attempts,
            claimed.claimed_by,
            claimed.claim_token,
            claimed.claim_expires_at;
END
$function$;

CREATE OR REPLACE FUNCTION app.complete_outbox(
  p_id uuid,
  p_tenant_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_result_ref text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant_id::text THEN
    RAISE EXCEPTION 'tenant transaction context is required';
  END IF;
  IF p_tenant_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'tenant id must be UUIDv7';
  END IF;
  IF p_result_ref IS NULL OR btrim(p_result_ref) = '' OR length(p_result_ref) > 256 THEN
    RAISE EXCEPTION 'result reference must contain 1 to 256 characters';
  END IF;

  UPDATE public.outbox
  SET state = 'sent',
      result_ref = p_result_ref,
      last_error = NULL,
      terminal_at = statement_timestamp(),
      claimed_at = NULL,
      claim_expires_at = NULL,
      claimed_by = NULL,
      claim_token = NULL,
      updated_at = statement_timestamp()
  WHERE id = p_id
    AND tenant_id = p_tenant_id
    AND state = 'processing'
    AND claimed_by = p_worker_id
    AND claim_token = p_claim_token
    AND claim_expires_at > statement_timestamp();
  RETURN FOUND;
END
$function$;

CREATE OR REPLACE FUNCTION app.fail_outbox(
  p_id uuid,
  p_tenant_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_incident_id uuid,
  p_error_code text,
  p_permanent boolean,
  p_retry_delay_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  v_attempt_count integer;
  v_event_type text;
  v_terminal boolean;
BEGIN
  IF current_setting('app.tenant_id', true) IS DISTINCT FROM p_tenant_id::text THEN
    RAISE EXCEPTION 'tenant transaction context is required';
  END IF;
  IF p_tenant_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR p_incident_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'tenant and incident ids must be UUIDv7';
  END IF;
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION 'failure code is invalid';
  END IF;
  IF p_permanent IS NULL THEN
    RAISE EXCEPTION 'permanent flag is required';
  END IF;
  IF p_retry_delay_seconds < 0 OR p_retry_delay_seconds > 3600 THEN
    RAISE EXCEPTION 'retry delay must be between 0 and 3600 seconds';
  END IF;

  SELECT attempt_count, event_type,
         p_permanent OR attempt_count >= max_attempts
  INTO v_attempt_count, v_event_type, v_terminal
  FROM public.outbox
  WHERE id = p_id
    AND tenant_id = p_tenant_id
    AND state = 'processing'
    AND claimed_by = p_worker_id
    AND claim_token = p_claim_token
    AND claim_expires_at > statement_timestamp()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.outbox
  SET state = CASE WHEN v_terminal THEN 'failed_permanent' ELSE 'pending' END,
      last_error = p_error_code,
      next_attempt_at = statement_timestamp() + make_interval(secs => p_retry_delay_seconds),
      terminal_at = CASE WHEN v_terminal THEN statement_timestamp() ELSE NULL END,
      claimed_at = NULL,
      claim_expires_at = NULL,
      claimed_by = NULL,
      claim_token = NULL,
      updated_at = statement_timestamp()
  WHERE id = p_id AND tenant_id = p_tenant_id;

  IF v_terminal THEN
    INSERT INTO public.incidents (id, tenant_id, outbox_id, kind, summary, status)
    VALUES (
      p_incident_id,
      p_tenant_id,
      p_id,
      'outbox_failed_permanent',
      'Delivery of ' || v_event_type || ' failed permanently after '
        || v_attempt_count::text || ' attempts',
      'open'
    );
  END IF;
  RETURN true;
END
$function$;

ALTER FUNCTION app.claim_outbox(text, integer, integer)
  OWNER TO zabuni_outbox_claim_owner;
ALTER FUNCTION app.complete_outbox(uuid, uuid, text, uuid, text)
  OWNER TO zabuni_outbox_claim_owner;
ALTER FUNCTION app.fail_outbox(uuid, uuid, text, uuid, uuid, text, boolean, integer)
  OWNER TO zabuni_outbox_claim_owner;
REVOKE CREATE ON SCHEMA app FROM zabuni_outbox_claim_owner;
SET ROLE zabuni_outbox_claim_owner;
REVOKE ALL ON FUNCTION app.claim_outbox(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_outbox(uuid, uuid, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.fail_outbox(uuid, uuid, text, uuid, uuid, text, boolean, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_outbox(text, integer, integer) TO zabuni_worker;
GRANT EXECUTE ON FUNCTION app.complete_outbox(uuid, uuid, text, uuid, text) TO zabuni_worker;
GRANT EXECUTE ON FUNCTION app.fail_outbox(uuid, uuid, text, uuid, uuid, text, boolean, integer) TO zabuni_worker;
RESET ROLE;
SET ROLE zabuni_owner;

REVOKE ALL ON outbox, incidents FROM zabuni_worker;

REVOKE INSERT ON outbox FROM zabuni_app;
GRANT INSERT (
  id,
  tenant_id,
  event_type,
  payload_version,
  payload,
  idempotency_key,
  max_attempts,
  next_attempt_at
) ON outbox TO zabuni_app;
