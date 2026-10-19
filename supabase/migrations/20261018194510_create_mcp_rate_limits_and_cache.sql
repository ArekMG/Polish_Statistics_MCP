/*
# MCP server support tables: shared rate limits and DBW response cache

1. Purpose
   The DBW MCP server runs as a stateless server function. Rate-limit counters and cached
   DBW responses must be shared across all running instances, so they live here.

2. New Tables
   - `mcp_rate_limits` - fixed-window request counters
     - `bucket` (text) - limit name, e.g. `client:<id>:60s` or `dbw:15m`
     - `window_start` (timestamptz) - start of the counting window
     - `expires_at` (timestamptz) - when the window ends (used for cleanup)
     - `hits` (integer) - requests counted in this window
     - primary key (`bucket`, `window_start`)
   - `mcp_dbw_cache` - cached DBW API responses (public statistical data only)
     - `cache_key` (text, primary key)
     - `payload` (jsonb) - cached response
     - `expires_at` (timestamptz) - entry is ignored after this time
     - `created_at` (timestamptz)

3. New Function
   - `mcp_consume_rate_limit(p_buckets text[], p_windows integer[], p_limits integer[])`
     Atomically checks every bucket; only if ALL have room are they all incremented.
     Returns jsonb `{allowed, bucket, retry_after_seconds}`. Occasionally purges expired rows
     from both tables.

4. Security
   - RLS enabled on both tables with NO policies: deny-by-default for anon/authenticated.
   - All table privileges revoked from anon and authenticated.
   - The function is SECURITY INVOKER with a fixed search_path; EXECUTE is revoked from
     PUBLIC, anon and authenticated and granted only to service_role (the server function).

5. Notes
   1. No user data is stored; cached payloads are public DBW statistics.
   2. Safe to re-run (idempotent).
*/

CREATE TABLE IF NOT EXISTS mcp_rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE INDEX IF NOT EXISTS mcp_rate_limits_expires_at_idx ON mcp_rate_limits (expires_at);

CREATE TABLE IF NOT EXISTS mcp_dbw_cache (
  cache_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_dbw_cache_expires_at_idx ON mcp_dbw_cache (expires_at);

ALTER TABLE mcp_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_dbw_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON mcp_rate_limits FROM anon, authenticated;
REVOKE ALL ON mcp_dbw_cache FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_rate_limits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_dbw_cache TO service_role;

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
    DELETE FROM mcp_dbw_cache WHERE expires_at < now() - interval '1 hour';
  END IF;

  RETURN jsonb_build_object('allowed', true);
END;
$$;

REVOKE EXECUTE ON FUNCTION mcp_consume_rate_limit(text[], integer[], integer[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mcp_consume_rate_limit(text[], integer[], integer[]) TO service_role;
