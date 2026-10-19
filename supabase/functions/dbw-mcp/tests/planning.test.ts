import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateByYear, periodRank } from "../aggregate.ts";
import type { DecodedRow } from "../decode.ts";
import { roundValue, type Rounding } from "../rounding.ts";
import { memoryLimiter, setup } from "./helpers.ts";

const HALF_UP: Rounding = { mode: "half_up" };

const SERIES = { variable_id: 1, section_id: 1164, years: [2019, 2020] };
const dataCalls = (calls: { url: URL }[]) => calls.filter((c) => c.url.pathname.endsWith("variable-data-section")).length;

test("dry_run shows coverage and exact cost without downloading data", async () => {
  const { call, dbw } = setup();
  const plan = (await call("get_data_series", { ...SERIES, dry_run: true })).structuredContent;
  assert.equal(plan.dry_run, true);
  assert.equal(plan.coverage["2019"][plan.periods[0].period], "to_fetch");
  assert.equal(plan.estimated_dbw_requests.minimum, 2);
  assert.equal(plan.fits_in_budget, true);
  assert.equal(dataCalls(dbw.calls), 0);

  await call("get_data_series", { ...SERIES, years: [2019] });
  const before = dataCalls(dbw.calls);
  const again = (await call("get_data_series", { ...SERIES, dry_run: true })).structuredContent;
  const label = again.periods[0].period;
  assert.equal(again.coverage["2019"][label], "cached");
  assert.equal(again.coverage["2020"][label], "to_fetch");
  assert.equal(again.estimated_dbw_requests.minimum, 1);
  assert.equal(dataCalls(dbw.calls), before);
});

test("years without data are remembered and cost nothing next time", async () => {
  const { call, dbw } = setup();
  await call("get_data_series", { ...SERIES, years: [2018] });
  const before = dataCalls(dbw.calls);
  const plan = (await call("get_data_series", { ...SERIES, years: [2018], dry_run: true })).structuredContent;
  const status = Object.values(plan.coverage["2018"])[0];
  assert.ok(status === "empty" || status === "outside_range");
  assert.equal(plan.estimated_dbw_requests.minimum, 0);
  await call("get_data_series", { ...SERIES, years: [2018] });
  assert.equal(dataCalls(dbw.calls), before);
});

test("aggregate returns one value per year with completeness info", async () => {
  const { call } = setup();
  const out = (await call("get_data_series", { ...SERIES, levels: ["voivodeship"], position_ids: [50], aggregate: { fn: "mean" }, format: "wide" }))
    .structuredContent;
  assert.equal(out.aggregation.fn, "mean");
  assert.equal(out.aggregation.incomplete_groups, 0);
  assert.deepEqual(out.columns, ["2019", "2020"]);
  assert.equal(out.table[0]["2019"], 310);

  const bad = await call("get_data_series", { ...SERIES, aggregate: { fn: "median" } });
  assert.equal(bad.structuredContent.error.code, "INVALID_ARGUMENT");
});

test("aggregateByYear leaves incomplete years empty unless allow_partial", () => {
  const row = (period: string, value: number | null): DecodedRow => ({
    row: 1, year: 2023, period, period_name: period, dimensions: { Region: "A" }, value, precision: 1, unit: "%",
  });
  const rows = [row("M01", 2), row("M02", 4), row("M03", null)];
  const rank = (r: DecodedRow) => periodRank(r.period, 0);
  const strict = aggregateByYear(rows, ["Region"], { fn: "mean", window: "year", allowPartial: false }, 3, rank, HALF_UP);
  assert.equal(strict.rows[0].value, null);
  assert.equal(strict.rows[0].periods_used, 2);
  assert.equal(strict.incomplete, 1);
  const partial = aggregateByYear(rows, ["Region"], { fn: "mean", window: "year", allowPartial: true }, 3, rank, HALF_UP);
  assert.equal(partial.rows[0].value, 3);
  const sum = aggregateByYear(rows.slice(0, 2), ["Region"], { fn: "sum", window: "year", allowPartial: false }, 2, rank, HALF_UP);
  assert.equal(sum.rows[0].value, 6);
  assert.equal(sum.rows[0].complete, true);
});

test("first and last follow calendar order, not input order", () => {
  const row = (period: string, value: number): DecodedRow => ({
    row: 1, year: 2023, period, period_name: period, dimensions: { Region: "A" }, value, precision: 1, unit: "%",
  });
  const rows = [row("M12", 9), row("M02", 4), row("M10", 7)];
  const rank = (r: DecodedRow) => periodRank(r.period, 0);
  const last = aggregateByYear(rows, ["Region"], { fn: "last", window: "year", allowPartial: false }, 3, rank, HALF_UP).rows[0];
  assert.equal(last.value, 9);
  assert.equal(last.source_period, "M12");
  const first = aggregateByYear(rows, ["Region"], { fn: "first", window: "year", allowPartial: false }, 3, rank, HALF_UP).rows[0];
  assert.equal(first.value, 4);
  assert.ok(periodRank("Q4", 1) > periodRank("M11", 999));
});

test("include_executed: false returns only the count", async () => {
  const { call } = setup();
  const out = (await call("get_data_series", { ...SERIES, include_executed: false })).structuredContent;
  assert.equal(out.executed, undefined);
  assert.equal(out.executed_count, 2);
  assert.ok(Array.isArray(out.empty));
});

test("default language comes from the server address and can be overridden per call", async () => {
  const { handler, dbw } = setup();
  const send = (url: string, args: Record<string, unknown>) =>
    handler(new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_areas", arguments: args } }),
    }));
  await send("http://localhost/dbw-mcp?lang=pl", {});
  assert.equal(dbw.calls.at(-1)!.url.searchParams.get("lang"), "pl");
  await send("http://localhost/dbw-mcp?lang=pl", { lang: "en" });
  assert.equal(dbw.calls.at(-1)!.url.searchParams.get("lang"), "en");
  const bad = await send("http://localhost/dbw-mcp?lang=de", {});
  assert.equal(bad.status, 400);
});

test("ties round exactly and consistently", () => {
  const month = (period: string, value: number): DecodedRow => ({
    row: 1, year: 2025, period, period_name: period, dimensions: { Region: "PL" }, value, precision: 1, unit: "%",
  });
  // Mean is exactly 5.425; float arithmetic would give 5.4249999...
  const rows = [5.4, 5.4, 5.4, 5.5].map((v, i) => month(`M0${i + 1}`, v));
  const rank = (r: DecodedRow) => periodRank(r.period, 0);
  const agg = (rounding: Rounding) =>
    aggregateByYear(rows, ["Region"], { fn: "mean", window: "year", allowPartial: false }, 4, rank, rounding).rows[0].value;
  assert.equal(agg({ mode: "half_up" }), 5.425);
  assert.equal(agg({ mode: "half_up", decimals: 2 }), 5.43);
  assert.equal(agg({ mode: "half_even", decimals: 2 }), 5.42);
  assert.equal(roundValue(4.725, { mode: "half_up", decimals: 2 }), 4.73);
  assert.equal(roundValue(8.125, { mode: "half_even", decimals: 2 }), 8.12);
  assert.equal(roundValue(-2.5, { mode: "half_up", decimals: 0 }), -3);
  assert.equal(roundValue(1.005, { mode: "half_up", decimals: 2 }), 1.01);
});

test("finished series are replayed from the result cache without re-reading parts", async () => {
  const { call, dbw } = setup();
  const first = (await call("get_data_series", { ...SERIES, aggregate: { fn: "mean" } })).structuredContent;
  assert.equal(first.from_result_cache, undefined);
  const callsBefore = dbw.calls.length;
  const again = (await call("get_data_series", { ...SERIES, aggregate: { fn: "mean" }, format: "wide", include_executed: false }))
    .structuredContent;
  assert.equal(again.from_result_cache, true);
  assert.equal(again.executed, undefined);
  assert.equal(again.executed_count, first.executed_count);
  assert.ok(Array.isArray(again.table));
  assert.equal(dbw.calls.length, callsBefore);
  const rounded = (await call("get_data_series", { ...SERIES, decimals: 0 })).structuredContent;
  assert.equal(rounded.from_result_cache, undefined);
  assert.ok(rounded.rows.every((r: { value: number | null }) => r.value === null || Number.isInteger(r.value)));
  const bad = await call("get_data_series", { ...SERIES, round: "none", decimals: 1 });
  assert.equal(bad.structuredContent.error.code, "INVALID_ARGUMENT");
});

test("a caller's own DBW key is sent to DBW and counted in its own budget", async () => {
  const dbwLimiter = memoryLimiter();
  const { handler, dbw, cache } = setup({ dbwLimiter });
  const send = (headers: Record<string, string>, url = "http://localhost/dbw-mcp") =>
    handler(new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_areas", arguments: {} } }),
    }));
  await send({ "X-DBW-Key": "user-key-12345678" });
  assert.equal(dbw.calls.at(-1)!.headers.get("X-ClientId"), "user-key-12345678");
  assert.ok(dbwLimiter.calls.at(-1)!.some((r) => r.bucket === "dbwkey-test:15m" && r.limit === 450));

  cache.store.clear();
  await send({}, "http://localhost/dbw-mcp?lang=pl&dbw_key=user-key-12345678");
  assert.equal(dbw.calls.at(-1)!.headers.get("X-ClientId"), "user-key-12345678");

  cache.store.clear();
  await send({}, "http://localhost/dbw-mcp?lang=pl");
  assert.equal(dbw.calls.at(-1)!.headers.get("X-ClientId"), null);
  assert.ok(dbwLimiter.calls.at(-1)!.some((r) => r.bucket === "dbw-anon:15m"));

  const bad = await send({ "X-DBW-Key": "bad key" });
  assert.equal(bad.status, 400);
});

test("a rejected caller key gives a clear error", async () => {
  const { handler } = setup({ failWith: { status: 401 } });
  const res = await handler(new Request("http://localhost/dbw-mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DBW-Key": "user-key-12345678" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_areas", arguments: {} } }),
  }));
  const body = await res.json();
  assert.equal(body.result.structuredContent.error.code, "INVALID_DBW_KEY");
});
