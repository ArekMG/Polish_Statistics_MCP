/*
# Batch check of which cached entries exist

1. Purpose
   Lets the DBW MCP server plan a download (dry_run) with one database round trip
   instead of one or more lookups per year/period combination.

2. New Function
   - `mcp_cache_presence(p_keys text[])`
     Returns a jsonb array of `{cache_key, page_count}` for every key that is cached
     and not expired. `page_count` is read from the cached DBW page ("page-count"),
     or null when the entry has none. Payloads are never returned. At most 2000 keys.

3. Modified Tables
   - None.

4. Security
   - SECURITY INVOKER with a fixed search_path; read-only.
   - EXECUTE revoked from PUBLIC, anon and authenticated; granted only to service_role
     (the server function). The cache table stays locked by RLS with no policies.

5. Notes
   1. Safe to re-run (CREATE OR REPLACE).
*/

CREATE OR REPLACE FUNCTION mcp_cache_presence(p_keys text[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF coalesce(array_length(p_keys, 1), 0) > 2000 THEN
    RAISE EXCEPTION 'too many keys';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'cache_key', c.cache_key,
      'page_count', CASE WHEN jsonb_typeof(c.payload -> 'page-count') = 'number'
                         THEN (c.payload ->> 'page-count')::integer END
    ))
    FROM mcp_dbw_cache c
    WHERE c.cache_key = ANY (p_keys) AND c.expires_at > now()
  ), '[]'::jsonb);
END;
$$;

REVOKE EXECUTE ON FUNCTION mcp_cache_presence(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION mcp_cache_presence(text[]) TO service_role;
