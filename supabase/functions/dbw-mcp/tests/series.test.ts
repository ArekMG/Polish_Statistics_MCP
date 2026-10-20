import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesLoosely } from "../args.ts";
import { territorialLevel } from "../catalog.ts";
import type { RateLimiter } from "../store.ts";
import { allowAll, setup } from "./helpers.ts";

const SERIES = { variable_id: 1, section_id: 1164, years: [2019, 2020] };

test("territorialLevel reads the level from the unit code", () => {
  assert.equal(territorialLevel("10000000000000"), "poland");
  assert.equal(territorialLevel("10011200000000"), "voivodeship");
  assert.equal(territorialLevel("10011213061000"), "county");
  assert.equal(territorialLevel("10011213061011"), "municipality");
  assert.equal(territorialLevel("10"), null);
});

test("matchesLoosely tolerates Polish word endings", () => {
  assert.ok(matchesLoosely("Przeciętne wynagrodzenie", "wynagrodzenia"));
  assert.ok(matchesLoosely("Stopa bezrobocia", "bezrobocie"));
  assert.ok(!matchesLoosely("Stopa bezrobocia", "ludność"));
});

test("get_section_dimensions shows and filters by level", async () => {
  const { call } = setup();
  const res = await call("get_section_dimensions", { section_id: 1164, level: "voivodeship" });
  const out = res.structuredContent;
  assert.deepEqual(out.positions.items.map((p: { position_id: number }) => p.position_id), [31, 32]);
  assert.equal(out.positions.items[0].level, "voivodeship");
  const territory = out.dimensions.find((d: { dimension_id: number }) => d.dimension_id === 3);
  assert.deepEqual(territory.levels, { poland: 1, voivodeship: 2, county: 1 });
});

test("get_data_series returns voivodeships across years in a wide table", async () => {
  const { call } = setup();
  const res = await call("get_data_series", { ...SERIES, levels: ["wojewodztwa"], position_ids: [50], format: "wide" });
  const out = res.structuredContent;
  assert.equal(out.complete, true);
  assert.equal(out.executed.length, 2);
  assert.deepEqual(out.columns, ["2019", "2020"]);
  assert.equal(out.table.length, 2);
  assert.equal(out.table[0].Territory, "MAŁOPOLSKIE");
  assert.equal(out.table[0]["2019"], 310);
  assert.equal(out.table[0]["2020"], 1310);
  assert.ok(out.upstream_requests > 2);
  assert.equal(out.quota.remaining, 90);
});

test("get_data_series marks years without data as empty", async () => {
  const { call } = setup();
  const res = await call("get_data_series", { ...SERIES, years: [2018, 2019] });
  const out = res.structuredContent;
  assert.equal(out.complete, true);
  assert.deepEqual(out.empty.map((e: { year: number }) => e.year), [2018]);
  assert.equal(out.returned_rows, 8);
});

test("get_data_series returns partial results when the budget runs out, then finishes from cache", async () => {
  let open = true;
  const dbwLimiter: RateLimiter = {
    consume: () => Promise.resolve(open ? { allowed: true } : { allowed: false, bucket: "dbw-anon:15m", retryAfterSeconds: 120 }),
    peek: allowAll.peek,
  };
  const { call } = setup({ dbwLimiter });
  await call("get_data_series", { ...SERIES, years: [2019] });

  open = false;
  const partial = (await call("get_data_series", SERIES)).structuredContent;
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.executed.map((e: { year: number }) => e.year), [2019]);
  assert.deepEqual(partial.pending.map((e: { year: number }) => e.year), [2020]);
  assert.equal(partial.retry_after_seconds, 120);
  assert.match(partial.next_step, /same arguments/);

  const blocked = await call("get_data_series", { ...SERIES, years: [2020] });
  assert.equal(blocked.structuredContent.error.code, "RATE_LIMITED");
  assert.ok(blocked.structuredContent.error.cached_tools_available.includes("quota_status"));

  open = true;
  const done = (await call("get_data_series", SERIES)).structuredContent;
  assert.equal(done.complete, true);
  assert.equal(done.upstream_requests, 1);
  assert.equal(done.returned_rows, 16);
});

test("get_data_series validates filters", async () => {
  const { call } = setup();
  const badLevel = await call("get_data_series", { ...SERIES, levels: ["planet"] });
  assert.equal(badLevel.structuredContent.error.code, "INVALID_ARGUMENT");
  const noTerritory = await call("get_data_series", { variable_id: 1, section_id: 1163, years: [2019], levels: ["voivodeship"] });
  assert.equal(noTerritory.structuredContent.error.code, "INVALID_ARGUMENT");
  const badPosition = await call("get_data_series", { ...SERIES, position_ids: [999] });
  assert.match(badPosition.structuredContent.error.message, /999/);
});

test("quota_status reports remaining budget without using it", async () => {
  const { call, dbw } = setup();
  const res = await call("quota_status");
  const out = res.structuredContent;
  assert.equal(out.authenticated, false);
  assert.equal(out.shared, true);
  assert.equal(out.key_source, "none");
  assert.ok(out.upgrade_hint !== undefined);
  assert.ok("cache" in out);
  assert.ok(out.limits.some((l: { remaining: number; limit: number }) => l.limit === 90 && l.remaining === 90));
  assert.equal(dbw.calls.length, 0);
});

test("get_data_series returns total_rows and truncated for complete results", async () => {
  const { call } = setup();
  const out = (await call("get_data_series", { ...SERIES, years: [2019] })).structuredContent;
  assert.equal(out.complete, true);
  assert.equal(out.truncated, false);
  assert.equal(out.total_rows, out.returned_rows);
  assert.ok(out.revision);
  assert.equal(out.cache.hit, false);
});

test("get_data_series returns truncated=true and no total_rows for partial results", async () => {
  let open = true;
  const dbwLimiter: RateLimiter = {
    consume: () => Promise.resolve(open ? { allowed: true } : { allowed: false, bucket: "dbw-anon:15m", retryAfterSeconds: 120 }),
    peek: allowAll.peek,
  };
  const { call } = setup({ dbwLimiter });
  await call("get_data_series", { ...SERIES, years: [2019] });
  open = false;
  const partial = (await call("get_data_series", SERIES)).structuredContent;
  assert.equal(partial.truncated, true);
  assert.equal(partial.total_rows, undefined);
});

test("force_refresh bypasses the result cache", async () => {
  const { call } = setup();
  await call("get_data_series", { ...SERIES, years: [2019] });
  const cached = (await call("get_data_series", { ...SERIES, years: [2019] })).structuredContent;
  assert.equal(cached.cache.hit, true);
  const forced = (await call("get_data_series", { ...SERIES, years: [2019], force_refresh: true })).structuredContent;
  assert.equal(forced.cache.hit, false);
});

test("result cache hit returns revision and cache metadata", async () => {
  const { call, dbw } = setup();
  const first = (await call("get_data_series", { ...SERIES, years: [2019] })).structuredContent;
  const callsBefore = dbw.calls.length;
  const again = (await call("get_data_series", { ...SERIES, years: [2019] })).structuredContent;
  assert.equal(again.cache.hit, true);
  assert.ok(again.cache.stored_at);
  assert.equal(again.revision, first.revision);
  assert.equal(dbw.calls.length, callsBefore);
});

test("get_section_dimensions exposes is_current and validity dates", async () => {
  const { call } = setup();
  const res = await call("get_section_dimensions", { section_id: 1164, level: "voivodeship" });
  const items = res.structuredContent.positions.items;
  assert.ok(items.every((p: { is_current: boolean }) => p.is_current === true));
  assert.ok(items[0].level_name);
});

test("budget_strategy strict refuses when estimated exceeds remaining", async () => {
  const dbwLimiter: RateLimiter = {
    consume: () => Promise.resolve({ allowed: true }),
    peek: () => Promise.resolve([{ bucket: "dbw-anon:15m", hits: 89, resetAfterSeconds: 120 }]),
  };
  const { call } = setup({ dbwLimiter });
  const result = await call("get_data_series", { ...SERIES, budget_strategy: "strict" });
  assert.equal(result.structuredContent.error.code, "BUDGET_EXHAUSTED");
  assert.ok(result.structuredContent.error.retry_after_seconds);
});

test("dry_run shows chunks when estimated exceeds remaining", async () => {
  const dbwLimiter: RateLimiter = {
    consume: () => Promise.resolve({ allowed: true }),
    peek: () => Promise.resolve([{ bucket: "dbw-anon:15m", hits: 89, resetAfterSeconds: 120 }]),
  };
  const { call } = setup({ dbwLimiter });
  const plan = (await call("get_data_series", { ...SERIES, dry_run: true })).structuredContent;
  assert.equal(plan.fits_in_budget, false);
  assert.ok(Array.isArray(plan.chunks));
  assert.ok(plan.budget_strategy_hint);
});

test("max_requests caps the number of DBW requests", async () => {
  const { call } = setup();
  const out = (await call("get_data_series", { ...SERIES, max_requests: 1 })).structuredContent;
  assert.equal(out.complete, false);
  assert.equal(out.truncated, true);
  assert.ok(out.pending.length > 0);
  assert.match(out.pending[0].reason, /max_requests/);
});
