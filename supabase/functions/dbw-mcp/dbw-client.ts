import { ToolError } from "./errors.ts";
import type { Cache, RateLimiter, RateRule } from "./store.ts";

export type Lang = "en" | "pl";

export const DBW_BASE_URL = "https://api-dbw.stat.gov.pl/api/1.2.0";
export const DBW_MAX_PAGE_SIZE = 5000;

export type DbwPage<T> = {
  "page-number": number;
  "page-size": number;
  "page-count": number;
  data: T[];
};

export type DbwClientOptions = {
  apiKey?: string;
  limiter: RateLimiter;
  cache: Cache;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type DbwGetOptions = {
  cacheTtlSeconds?: number;
};

export type DbwClient = {
  registered: boolean;
  get<T>(path: string, params: Record<string, string | number>, lang: Lang, options?: DbwGetOptions): Promise<T>;
};

// Kept below the published DBW limits (anonymous 5/s, 100/15min, 1000/12h, 10000/7d;
// registered 10/s, 500/15min, 5000/12h, 50000/7d) so this server never trips them.
function upstreamRules(registered: boolean): RateRule[] {
  return registered
    ? [
      { bucket: "dbw:1s", windowSeconds: 1, limit: 8 },
      { bucket: "dbw:15m", windowSeconds: 900, limit: 450 },
      { bucket: "dbw:12h", windowSeconds: 43200, limit: 4500 },
      { bucket: "dbw:7d", windowSeconds: 604800, limit: 45000 },
    ]
    : [
      { bucket: "dbw-anon:1s", windowSeconds: 1, limit: 4 },
      { bucket: "dbw-anon:15m", windowSeconds: 900, limit: 90 },
      { bucket: "dbw-anon:12h", windowSeconds: 43200, limit: 900 },
      { bucket: "dbw-anon:7d", windowSeconds: 604800, limit: 9000 },
    ];
}

const MAX_SHORT_WAIT_SECONDS = 2;
const MAX_BUDGET_ATTEMPTS = 6;

function retryAfterFrom(res: Response): number | undefined {
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter);
  const reset = res.headers.get("x-rate-limit-reset");
  if (reset) {
    const ms = Date.parse(reset) - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000);
  }
  return undefined;
}

export function createDbwClient(options: DbwClientOptions): DbwClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? DBW_BASE_URL;
  const timeoutMs = options.timeoutMs ?? 30000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const registered = Boolean(options.apiKey);
  const rules = upstreamRules(registered);

  async function acquireBudget() {
    for (let attempt = 0; attempt < MAX_BUDGET_ATTEMPTS; attempt++) {
      const decision = await options.limiter.consume(rules);
      if (decision.allowed) return;
      if (decision.retryAfterSeconds > MAX_SHORT_WAIT_SECONDS) {
        throw new ToolError(
          "RATE_LIMITED",
          `The shared DBW request budget for this server is used up (limit "${decision.bucket}").`,
          {
            retryAfterSeconds: decision.retryAfterSeconds,
            hint: "Wait before retrying. Cached discovery and metadata calls still work.",
          },
        );
      }
      await sleep(decision.retryAfterSeconds * 1000);
    }
    throw new ToolError("RATE_LIMITED", "The DBW API is busy; the per-second request budget stayed full.", {
      retryAfterSeconds: 1,
      hint: "Retry in a moment.",
    });
  }

  async function fetchOnce(url: string): Promise<Response> {
    await acquireBudget();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.apiKey) headers["X-ClientId"] = options.apiKey;
    return await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  }

  async function get<T>(
    path: string,
    params: Record<string, string | number>,
    lang: Lang,
    getOptions: DbwGetOptions = {},
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) query.set(k, String(v));
    query.set("lang", lang);
    const relative = `${path}?${query.toString()}`;
    const cacheKey = `dbw|${relative}`;

    if (getOptions.cacheTtlSeconds) {
      const hit = await options.cache.get<T>(cacheKey);
      if (hit !== undefined) return hit;
    }

    let lastError: ToolError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(500);
      let res: Response;
      try {
        res = await fetchOnce(`${baseUrl}${relative}`);
      } catch (err) {
        if (err instanceof ToolError) throw err;
        const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
        lastError = timedOut
          ? new ToolError("UPSTREAM_TIMEOUT", `DBW did not respond within ${timeoutMs / 1000}s (${path}).`, {
            hint: "DBW can be slow for large requests; retry, or request a smaller page.",
          })
          : new ToolError("UPSTREAM_ERROR", `Could not reach the DBW API (${path}).`, { hint: "Retry shortly." });
        continue;
      }

      if (res.ok) {
        let body: T;
        try {
          body = await res.json() as T;
        } catch {
          throw new ToolError("UPSTREAM_ERROR", `DBW returned a response that is not valid JSON (${path}).`);
        }
        if (getOptions.cacheTtlSeconds) await options.cache.set(cacheKey, body, getOptions.cacheTtlSeconds);
        return body;
      }

      await res.body?.cancel();
      if (res.status === 404) {
        throw new ToolError("NOT_FOUND", `DBW returned no result for ${path} with ${JSON.stringify(params)}.`);
      }
      if (res.status === 429) {
        throw new ToolError("RATE_LIMITED", "The DBW API rejected the request because its rate limit was reached.", {
          retryAfterSeconds: retryAfterFrom(res) ?? 60,
          hint: "Wait before retrying.",
        });
      }
      if (res.status === 400) {
        throw new ToolError("INVALID_ARGUMENT", `DBW rejected the request parameters for ${path}.`, {
          hint: "Check that all ids are valid integers obtained from the discovery tools.",
        });
      }
      if (res.status === 401 || res.status === 403) {
        throw new ToolError("UPSTREAM_ERROR", "DBW refused the server's credentials.", {
          hint: "The server operator should check the configured DBW API key.",
        });
      }
      lastError = new ToolError("UPSTREAM_ERROR", `DBW returned HTTP ${res.status} for ${path}.`, {
        hint: "This is usually temporary; retry shortly.",
      });
    }
    throw lastError!;
  }

  return { registered, get };
}
