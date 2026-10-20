-- Cache stats function for quota_status reporting.
-- Returns count and total bytes of unexpired cache entries.
CREATE OR REPLACE FUNCTION mcp_cache_stats()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'entries', count(*),
    'bytes', coalesce(sum(octet_length(payload::text)), 0)
  )
  FROM mcp_dbw_cache
  WHERE expires_at > now();
$$;

REVOKE EXECUTE ON FUNCTION mcp_cache_stats() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mcp_cache_stats() TO service_role;