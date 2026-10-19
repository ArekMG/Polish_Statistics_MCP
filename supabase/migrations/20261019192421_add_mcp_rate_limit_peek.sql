/*
# Read-only view of shared rate-limit counters

1. Purpose
   Lets the DBW MCP server report how much of its upstream request budget is left
   (for the new quota_status tool and the quota field on data replies) without
   consuming any budget.

2. New Function
   - `mcp_peek_rate_limit(p_buckets text[], p_windows integer[])`
     For each bucket, returns the hits counted in the current fixed window and the
     seconds until that window resets, as a jsonb array of
     `{bucket, hits, reset_after_seconds}`. Read-only; never inserts or updates rows.

3. Modified Tables
   - None.

4. Security
   - SECURITY INVOKER with a fixed search_path.
   - EXECUTE revoked from PUBLIC, anon and authenticated; granted only to service_role
     (the server function). The underlying table stays locked by RLS with no policies.

5. Notes
   1. Safe to re-run (CREATE OR REPLACE).
*/

CREATE OR REPLACE FUNCTION mcp_peek_rate_limit(
  p_buckets text[],
  p_windows integer[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  n integer := coalesce(array_length(p_buckets, 1), 0);
  i integer;
  v_start timestamptz;
  v_hits integer;
  v_epoch double precision := extract(epoch FROM clock_timestamp());
  v_out jsonb := '[]'::jsonb;
BEGIN
  IF n = 0 OR n <> coalesce(array_length(p_windows, 1), 0) THEN
    RAISE EXCEPTION 'bucket and window arrays must be non-empty and equal length';
  END IF;

  FOR i IN 1..n LOOP
    IF p_windows[i] IS NULL OR p_windows[i] < 1 THEN
      RAISE EXCEPTION 'invalid window';
    END IF;
    v_start := to_timestamp(floor(v_epoch / p_windows[i]) * p_windows[i]);
    SELECT hits INTO v_hits FROM mcp_rate_limits
    WHERE bucket = p_buckets[i] AND window_start = v_start;
    v_out := v_out || jsonb_build_object(
      'bucket', p_buckets[i],
      'hits', coalesce(v_hits, 0),
      'reset_after_seconds',
      greatest(1, ceil(extract(epoch FROM (v_start + make_interval(secs => p_windows[i]))) - v_epoch))::integer
    );
  END LOOP;

  RETURN v_out;
END;
$$;

REVOKE EXECUTE ON FUNCTION mcp_peek_rate_limit(text[], integer[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mcp_peek_rate_limit(text[], integer[]) TO service_role;
