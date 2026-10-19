import assert from "node:assert/strict";
import { test } from "node:test";
import { createDbwClient } from "../dbw-client.ts";
import { ToolError } from "../errors.ts";
import type { RateDecision, RateLimiter } from "../store.ts";
import { allowAll, DATA_ARGS, fakeDbw, memoryCache, setup } from "./helpers.ts";

test("API key is sent only as X-ClientId and never appears in tool output", async () => {
  const { call, dbw } = setup({ apiKey: "SECRET-KEY-123" });
  const res = await call("preview_data", DATA_ARGS);
  assert.ok(dbw.calls.length > 0);
  for (const c of dbw.calls) {
    assert.equal(c.headers.get("x-clientid"), "SECRET-KEY-123");
    assert.ok(!c.url.toString().includes("SECRET-KEY-123"));
  }
  assert.ok(!JSON.stringify(res).includes("SECRET-KEY-123"));
});

test("anonymous mode sends no key and uses stricter budgets", async () => {
  const limiter: RateLimiter & { buckets: string[] } = {
    buckets: [],
    consume(rules) {
      this.buckets.push(...rules.map((r) => `${r.bucket}=${r.limit}`));
      return Promise.resolve({ allowed: true });
    },
    peek: allowAll.peek,
  };
  const dbw = fakeDbw();
  const client = createDbwClient({ limiter, cache: memoryCache(), fetchImpl: dbw.fetchImpl });
  await client.get("/area/area-area", {}, "en");
  assert.equal(dbw.calls[0].headers.get("x-clientid"), null);
  assert.ok(limiter.buckets.includes("dbw-anon:1s=4"));
  assert.ok(limiter.buckets.includes("dbw-anon:15m=90"));
  assert.equal(dbw.calls[0].url.searchParams.get("lang"), "en");
});

test("per-second budget waits briefly; longer budgets fail with RATE_LIMITED", async () => {
  const decisions: RateDecision[] = [
    { allowed: false, bucket: "dbw:1s", retryAfterSeconds: 1 },
    { allowed: true },
  ];
  const slept: number[] = [];
  const dbw = fakeDbw();
  const waiting = createDbwClient({
    apiKey: "k",
    limiter: { consume: () => Promise.resolve(decisions.shift()!), peek: allowAll.peek },
    cache: memoryCache(),
    fetchImpl: dbw.fetchImpl,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  await waiting.get("/area/area-area", {}, "en");
  assert.deepEqual(slept, [1000]);

  const blocked = createDbwClient({
    apiKey: "k",
    limiter: {
      consume: () => Promise.resolve({ allowed: false, bucket: "dbw:15m", retryAfterSeconds: 300 }),
      peek: allowAll.peek,
    },
    cache: memoryCache(),
    fetchImpl: dbw.fetchImpl,
  });
  await assert.rejects(blocked.get("/area/area-area", {}, "en"), (err: ToolError) => {
    assert.equal(err.code, "RATE_LIMITED");
    assert.equal(err.retryAfterSeconds, 300);
    return true;
  });
});

test("upstream 429 maps to RATE_LIMITED with retry hint for the model", async () => {
  const { call } = setup({ failWith: { status: 429, headers: { "Retry-After": "42" } } });
  const res = await call("search_areas", {});
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.error.code, "RATE_LIMITED");
  assert.equal(res.structuredContent.error.retry_after_seconds, 42);
  assert.match(res.content[0].text, /Retry after 42s/);
});

test("upstream 5xx is retried once, then reported as UPSTREAM_ERROR", async () => {
  const { call, dbw } = setup({ failWith: { status: 503 } });
  const res = await call("search_areas", {});
  assert.equal(res.structuredContent.error.code, "UPSTREAM_ERROR");
  assert.equal(dbw.calls.length, 2);
});

test("timeouts are reported as UPSTREAM_TIMEOUT", async () => {
  const hanging = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as typeof fetch;
  const client = createDbwClient({
    limiter: allowAll,
    cache: memoryCache(),
    fetchImpl: hanging,
    timeoutMs: 20,
    sleep: () => Promise.resolve(),
  });
  // AbortSignal.timeout timers are unref'd in Node; keep the event loop alive until they fire.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(client.get("/area/area-area", {}, "en"), (err: ToolError) => err.code === "UPSTREAM_TIMEOUT");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("unexpected exceptions do not leak internals", async () => {
  const broken = ((() => Promise.resolve(new Response("not json", { status: 200 }))) as unknown) as typeof fetch;
  const client = createDbwClient({ limiter: allowAll, cache: memoryCache(), fetchImpl: broken });
  await assert.rejects(client.get("/area/area-area", {}, "en"), (err: ToolError) => err.code === "UPSTREAM_ERROR");
});
