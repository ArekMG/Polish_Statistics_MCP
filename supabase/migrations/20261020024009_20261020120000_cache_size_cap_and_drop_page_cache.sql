/*
# Cap the DBW cache and drop raw-page caching

## Purpose
The cache table `mcp_dbw_cache` had no hard size cap, and the old design cached every
raw data page fetched from DBW (up to 5000 rows each). Under a broad scrape that table
could grow into the hundreds of MB / GB with no bound. This migration:

1. Adds a byte-size cap enforced on every write, evicting the oldest expired rows first
   and then, if still over budget, the oldest rows regardless of expiry.
2. Tightens the existing probabilistic cleanup so it always runs when a cache write is
   attempted (not just on the rate-limit path), making the table self-trimming under load.

## Changes
- New SECURITY DEFINER function `mcp_trim_cache(p_max_bytes bigint)`:
  - Deletes all rows in `mcp_dbw_cache` whose `expires_at` is in the past.
  - If the remaining `octet_length(payload::text)` total still exceeds `p_max_bytes`,
    deletes the oldest rows (by `created_at`, then `cache_key`) until the total fits.
  - Returns a jsonb summary `{ remaining_rows, remaining_bytes, deleted_rows }`.
  - `SECURITY DEFINER`, fixed `search_path = public`, EXECUTE granted only to `service_role`.
    This lets the server function (service role) call it via RPC without needing direct
    DELETE privileges to be re-granted; the table owner performs the deletes.
- Replaces the probabilistic cleanup block inside `mcp_consume_rate_limit` with a
  deterministic call to `mcp_trim_cache` (1% probability, same as before) so the cap is
  enforced even on the rate-limit path. The inline `DELETE`s are removed in favor of the
  shared function.
- `mcp_rate_limits` cleanup (small table) stays inline; only expired rows are removed.

## Security
- The new function is `SECURITY DEFINER` with a fixed `search_path`. EXECUTE is revoked
  from PUBLIC, anon and authenticated, and granted only to `service_role`.
- No RLS or policy changes. `mcp_dbw_cache` and `mcp_rate_limits` remain RLS-enabled
  with no policies (deny-by-default) and service_role-only table privileges.

## Notes
1. The byte budget is passed by the caller (the server function), so it can be tuned
   without a new migration. The caller uses 100 MB by default.
2. Only expired rows are ever deleted purely for cleanup; live (unexpired) rows are only
   evicted when the table is over the hard cap, and always the oldest first.
3. Safe to re-run (idempotent): `CREATE OR REPLACE FUNCTION`, `DROP POLICY IF EXISTS`
   not needed (no policies added).
*/

CREATE OR REPLACE FUNCTION mcp_trim_cache(p_max_bytes bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
  v_deleted integer := 0;
  v_expired_deleted integer;
  v_remaining_rows integer;
  v_remaining_bytes bigint;
  v_row record;
BEGIN
  IF p_max_bytes IS NULL OR p_max_bytes < 0 THEN
    RAISE EXCEPTION 'p_max_bytes must be a non-negative integer';
  END IF;

  DELETE FROM mcp_dbw_cache WHERE expires_at < now();
  GET DIAGNOSTICS v_expired_deleted = ROW_COUNT;
  v_deleted := v_deleted + v_expired_deleted;

  SELECT coalesce(sum(octet_length(payload::text)), 0) INTO v_total FROM mcp_dbw_cache;

  IF v_total > p_max_bytes THEN
    FOR v_row IN
      SELECT cache_key, octet_length(payload::text) AS sz
      FROM mcp_dbw_cache
      ORDER BY created_at ASC, cache_key ASC
    LOOP
      DELETE FROM mcp_dbw_cache WHERE cache_key = v_row.cache_key;
      v_deleted := v_deleted + 1;
      v_total := v_total - v_row.sz;
      EXIT WHEN v_total <= p_max_bytes;
    END LOOP;
  END IF;

  SELECT count(*), coalesce(sum(octet_length(payload::text)), 0)
    INTO v_remaining_rows, v_remaining_bytes
  FROM mcp_dbw_cache;

  RETURN jsonb_build_object(
    'deleted_rows', v_deleted,
    'remaining_rows', v_remaining_rows,
    'remaining_bytes', v_remaining_bytes
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION mcp_trim_cache(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mcp_trim_cache(bigint) TO service_role;

-- Replace the inline cache cleanup in the rate-limit function with the shared trimmer.
-- The rate-limit table is small; keep its inline expired-row purge.
CREATE OR REPLACE FUNCTION mcp_consume_rate_limit(
  p_buckets text[],
  p_windows integer[],
  p_limits integer[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  n integer := coalesce(array_length(p_buckets, 1), 0);
  i integer;
  v_start timestamptz;
  v_hits integer;
  v_epoch double precision := extract(epoch FROM clock_timestamp());
  v_starts timestamptz[] := ARRAY[]::timestamptz[];
BEGIN
  IF n = 0 OR n <> coalesce(array_length(p_windows, 1), 0) OR n <> coalesce(array_length(p_limits, 1), 0) THEN
    RAISE EXCEPTION 'bucket, window and limit arrays must be non-empty and equal length';
  END IF;

  FOR i IN 1..n LOOP
    IF p_windows[i] IS NULL OR p_windows[i] < 1 OR p_limits[i] IS NULL OR p_limits[i] < 1 THEN
      RAISE EXCEPTION 'invalid window or limit';
    END IF;
    v_start := to_timestamp(floor(v_epoch / p_windows[i]) * p_windows[i]);
    v_starts := v_starts || v_start;

    INSERT INTO mcp_rate_limits (bucket, window_start, expires_at, hits)
    VALUES (p_buckets[i], v_start, v_start + make_interval(secs => p_windows[i]), 0)
    ON CONFLICT (bucket, window_start) DO NOTHING;

    SELECT hits INTO v_hits FROM mcp_rate_limits
    WHERE bucket = p_buckets[i] AND window_start = v_start
    FOR UPDATE;

    IF v_hits + 1 > p_limits[i] THEN
      RETURN jsonb_build_object(
        'allowed', false,
        'bucket', p_buckets[i],
        'retry_after_seconds',
        greatest(1, ceil(extract(epoch FROM (v_start + make_interval(secs => p_windows[i]))) - v_epoch))::integer
      );
    END IF;
  END LOOP;

  FOR i IN 1..n LOOP
    UPDATE mcp_rate_limits SET hits = hits + 1
    WHERE bucket = p_buckets[i] AND window_start = v_starts[i];
  END LOOP;

  IF random() < 0.01 THEN
    DELETE FROM mcp_rate_limits WHERE expires_at < now() - interval '1 hour';
    PERFORM mcp_trim_cache(104857600);
  END IF;

  RETURN jsonb_build_object('allowed', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION mcp_consume_rate_limit(text[], integer[], integer[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mcp_consume_rate_limit(text[], integer[], integer[]) TO service_role;
