import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateByYear } from "../aggregate.ts";
import type { DecodedRow } from "../decode.ts";
import { setup } from "./helpers.ts";

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
  const strict = aggregateByYear(rows, ["Region"], { fn: "mean", window: "year", allowPartial: false }, 3);
  assert.equal(strict.rows[0].value, null);
  assert.equal(strict.rows[0].periods_used, 2);
  assert.equal(strict.incomplete, 1);
  const partial = aggregateByYear(rows, ["Region"], { fn: "mean", window: "year", allowPartial: true }, 3);
  assert.equal(partial.rows[0].value, 3);
  const sum = aggregateByYear(rows.slice(0, 2), ["Region"], { fn: "sum", window: "year", allowPartial: false }, 2);
  assert.equal(sum.rows[0].value, 6);
  assert.equal(sum.rows[0].complete, true);
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
