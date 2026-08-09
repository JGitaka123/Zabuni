-- Crash-loop visibility for the outbox drain.
--
-- app.claim_outbox reclaims rows whose lease expired while still in 'processing'.
-- That branch deliberately has no attempt_count guard, so a worker that dies after
-- the external effect but before acknowledgement can reclaim the same row forever.
-- Idempotency keeps the external side effect safe, but nothing currently makes the
-- loop visible. This exposes an aggregate snapshot the worker can alert on.
--
-- The snapshot returns counts only -- no tenant ids, payloads, or error text -- so a
-- globally-scoped worker can poll it without becoming a cross-tenant read path.

GRANT CREATE ON SCHEMA app TO zabuni_outbox_claim_owner;
SET ROLE zabuni_outbox_claim_owner;

CREATE OR REPLACE FUNCTION app.outbox_stall_snapshot(
  p_expired_grace_seconds integer DEFAULT 0
)
RETURNS TABLE (
  expired_leases bigint,
  exhausted_leases bigint,
  oldest_expired_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF p_expired_grace_seconds IS NULL
     OR p_expired_grace_seconds < 0
     OR p_expired_grace_seconds > 3600 THEN
    RAISE EXCEPTION 'expired grace must be between 0 and 3600 seconds';
  END IF;

  RETURN QUERY
  SELECT
    count(*)::bigint,
    count(*) FILTER (
      WHERE stalled.attempt_count >= stalled.max_attempts
    )::bigint,
    coalesce(
      floor(
        EXTRACT(EPOCH FROM (statement_timestamp() - min(stalled.claim_expires_at)))
      )::integer,
      0
    )
  FROM public.outbox AS stalled
  WHERE stalled.state = 'processing'
    AND stalled.claim_expires_at
        <= statement_timestamp() - make_interval(secs => p_expired_grace_seconds);
END
$function$;

ALTER FUNCTION app.outbox_stall_snapshot(integer)
  OWNER TO zabuni_outbox_claim_owner;
REVOKE ALL ON FUNCTION app.outbox_stall_snapshot(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.outbox_stall_snapshot(integer) TO zabuni_worker;

SET ROLE zabuni_owner;
REVOKE CREATE ON SCHEMA app FROM zabuni_outbox_claim_owner;
