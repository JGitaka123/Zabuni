ALTER TABLE outbox ADD CONSTRAINT outbox_idempotency_key_shape_check CHECK (
  btrim(idempotency_key) <> ''
  AND length(idempotency_key) <= 128
);

GRANT CREATE ON SCHEMA app TO zabuni_outbox_claim_owner;
SET ROLE zabuni_outbox_claim_owner;

CREATE OR REPLACE FUNCTION app.claim_outbox(
  p_worker_id text,
  p_batch_size integer DEFAULT 1,
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
  IF p_batch_size IS NULL OR p_batch_size <> 1 THEN
    RAISE EXCEPTION 'batch size must be 1 until lease renewal is implemented';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 900 THEN
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
    LIMIT 1
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

ALTER FUNCTION app.claim_outbox(text, integer, integer)
  OWNER TO zabuni_outbox_claim_owner;
REVOKE ALL ON FUNCTION app.claim_outbox(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_outbox(text, integer, integer) TO zabuni_worker;

SET ROLE zabuni_owner;
REVOKE CREATE ON SCHEMA app FROM zabuni_outbox_claim_owner;
