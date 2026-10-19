export interface Cache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  // Maps each cached key to the DBW "page-count" stored in it (null when absent); missing keys are not cached.
  presence(keys: string[]): Promise<Map<string, number | null>>;
}

export type RateRule = { bucket: string; windowSeconds: number; limit: number };

export type RateDecision =
  | { allowed: true }
  | { allowed: false; bucket: string; retryAfterSeconds: number };

export type RateUsage = { bucket: string; hits: number; resetAfterSeconds: number };

export interface RateLimiter {
  consume(rules: RateRule[]): Promise<RateDecision>;
  peek(rules: RateRule[]): Promise<RateUsage[] | undefined>;
}

type FetchFn = typeof fetch;

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Shared state lives in Postgres (via PostgREST) because server-function instances do not share memory.
// Failures are logged and treated as cache misses / allowed requests so a database hiccup never takes the server down;
// DBW still enforces its own limits, which the client maps to RATE_LIMITED errors.
export function createSupabaseStore(supabaseUrl: string, serviceKey: string, fetchImpl: FetchFn = fetch) {
  const base = supabaseUrl.replace(/\/+$/, "") + "/rest/v1";
  const headers: Record<string, string> = { apikey: serviceKey, "Content-Type": "application/json" };
  if (serviceKey.startsWith("eyJ")) headers.Authorization = `Bearer ${serviceKey}`;

  const cache: Cache = {
    async get<T>(key: string) {
      try {
        const url = `${base}/mcp_dbw_cache?select=payload&cache_key=eq.${encodeURIComponent(key)}` +
          `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&limit=1`;
        const res = await fetchImpl(url, { headers });
        if (!res.ok) {
          console.error("cache read failed", res.status);
          return undefined;
        }
        const rows = await res.json() as { payload: T }[];
        return rows.length ? rows[0].payload : undefined;
      } catch (err) {
        console.error("cache read error", err);
        return undefined;
      }
    },
    async presence(keys: string[]) {
      const out = new Map<string, number | null>();
      if (keys.length === 0) return out;
      try {
        const res = await fetchImpl(`${base}/rpc/mcp_cache_presence`, {
          method: "POST",
          headers,
          body: JSON.stringify({ p_keys: keys }),
        });
        if (!res.ok) {
          console.error("cache presence failed", res.status);
          return out;
        }
        const rows = await res.json() as { cache_key: string; page_count: number | null }[];
        if (Array.isArray(rows)) {
          for (const r of rows) out.set(String(r.cache_key), typeof r.page_count === "number" ? r.page_count : null);
        }
      } catch (err) {
        console.error("cache presence error", err);
      }
      return out;
    },
    async set(key: string, value: unknown, ttlSeconds: number) {
      try {
        const res = await fetchImpl(`${base}/mcp_dbw_cache?on_conflict=cache_key`, {
          method: "POST",
          headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            cache_key: key,
            payload: value,
            expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
          }),
        });
        if (!res.ok) console.error("cache write failed", res.status);
      } catch (err) {
        console.error("cache write error", err);
      }
    },
  };

  const limiter: RateLimiter = {
    async consume(rules: RateRule[]) {
      try {
        const res = await fetchImpl(`${base}/rpc/mcp_consume_rate_limit`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            p_buckets: rules.map((r) => r.bucket),
            p_windows: rules.map((r) => r.windowSeconds),
            p_limits: rules.map((r) => r.limit),
          }),
        });
        if (!res.ok) {
          console.error("rate limiter failed", res.status);
          return { allowed: true };
        }
        const out = await res.json() as { allowed?: boolean; bucket?: string; retry_after_seconds?: number };
        if (out.allowed === false) {
          return { allowed: false, bucket: String(out.bucket), retryAfterSeconds: Number(out.retry_after_seconds) || 1 };
        }
        return { allowed: true };
      } catch (err) {
        console.error("rate limiter error", err);
        return { allowed: true };
      }
    },
    async peek(rules: RateRule[]) {
      try {
        const res = await fetchImpl(`${base}/rpc/mcp_peek_rate_limit`, {
          method: "POST",
          headers,
          body: JSON.stringify({ p_buckets: rules.map((r) => r.bucket), p_windows: rules.map((r) => r.windowSeconds) }),
        });
        if (!res.ok) {
          console.error("rate limit peek failed", res.status);
          return undefined;
        }
        const out = await res.json() as { bucket: string; hits: number; reset_after_seconds: number }[];
        if (!Array.isArray(out)) return undefined;
        return out.map((u) => ({ bucket: String(u.bucket), hits: Number(u.hits) || 0, resetAfterSeconds: Number(u.reset_after_seconds) || 0 }));
      } catch (err) {
        console.error("rate limit peek error", err);
        return undefined;
      }
    },
  };

  return { cache, limiter };
}
