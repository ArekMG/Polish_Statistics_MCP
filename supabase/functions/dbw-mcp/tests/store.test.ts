import assert from "node:assert/strict";
import { test } from "node:test";
import { createSupabaseStore } from "../store.ts";

function recorder(respond: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("rate limiter calls the database function with all buckets", async () => {
  const rec = recorder(() => Response.json({ allowed: false, bucket: "dbw:15m", retry_after_seconds: 120 }));
  const { limiter } = createSupabaseStore("https://db.example/", "eyJservice", rec.fetchImpl);
  const decision = await limiter.consume([
    { bucket: "a", windowSeconds: 1, limit: 5 },
    { bucket: "b", windowSeconds: 900, limit: 90 },
  ]);
  assert.deepEqual(decision, { allowed: false, bucket: "dbw:15m", retryAfterSeconds: 120 });
  assert.equal(rec.calls[0].url, "https://db.example/rest/v1/rpc/mcp_consume_rate_limit");
  assert.deepEqual(JSON.parse(String(rec.calls[0].init?.body)), {
    p_buckets: ["a", "b"],
    p_windows: [1, 900],
    p_limits: [5, 90],
  });
  const headers = rec.calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.apikey, "eyJservice");
  assert.equal(headers.Authorization, "Bearer eyJservice");
});

test("non-JWT secret keys are sent only as apikey", async () => {
  const rec = recorder(() => Response.json({ allowed: true }));
  const { limiter } = createSupabaseStore("https://db.example", "sb_secret_abc", rec.fetchImpl);
  await limiter.consume([{ bucket: "a", windowSeconds: 1, limit: 1 }]);
  const headers = rec.calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, undefined);
});

test("cache reads unexpired rows and upserts with a TTL", async () => {
  const rec = recorder((url, init) =>
    init?.method === "POST" ? new Response(null, { status: 201 }) : Response.json([{ payload: { hello: 1 } }])
  );
  const { cache } = createSupabaseStore("https://db.example", "eyJk", rec.fetchImpl);
  assert.deepEqual(await cache.get("dbw|/x?a=1"), { hello: 1 });
  assert.match(rec.calls[0].url, /cache_key=eq\.dbw%7C%2Fx%3Fa%3D1&expires_at=gt\./);

  await cache.set("k", { v: 2 }, 60);
  const body = JSON.parse(String(rec.calls[1].init?.body));
  assert.equal(body.cache_key, "k");
  assert.ok(Date.parse(body.expires_at) > Date.now() + 50_000);
  assert.match((rec.calls[1].init?.headers as Record<string, string>).Prefer, /merge-duplicates/);
});

test("database failures fail open instead of breaking the server", async () => {
  const rec = recorder(() => new Response("boom", { status: 500 }));
  const { cache, limiter } = createSupabaseStore("https://db.example", "eyJk", rec.fetchImpl);
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await cache.get("k"), undefined);
    assert.deepEqual(await limiter.consume([{ bucket: "a", windowSeconds: 1, limit: 1 }]), { allowed: true });
  } finally {
    console.error = originalError;
  }
});
