import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_ARGS, setup } from "./helpers.ts";

test("search_areas filters by query, parent, has_variables and paginates", async () => {
  const { call } = setup();
  const byQuery = await call("search_areas", { query: "price" });
  assert.deepEqual(byQuery.structuredContent.areas.map((a: { area_id: number }) => a.area_id), [1, 7]);
  assert.equal(byQuery.structuredContent.areas[1].path, "Prices > Price indices");

  const accentless = await call("search_areas", { query: "rynek" });
  assert.equal(accentless.structuredContent.total, 1);

  const children = await call("search_areas", { parent_id: 1 });
  assert.deepEqual(children.structuredContent.areas.map((a: { area_id: number }) => a.area_id), [7]);

  const paged = await call("search_areas", { has_variables: true, limit: 2 });
  assert.equal(paged.structuredContent.total, 3);
  assert.equal(paged.structuredContent.areas.length, 2);
  assert.equal(paged.structuredContent.next_offset, 2);
  const last = await call("search_areas", { has_variables: true, limit: 2, offset: 2 });
  assert.equal(last.structuredContent.next_offset, null);
});

test("find_variables works by area and by query and explains bad input", async () => {
  const { call } = setup();
  const byArea = await call("find_variables", { area_id: 100 });
  assert.deepEqual(byArea.structuredContent.variables.map((v: { variable_id: number }) => v.variable_id), [814, 815]);

  const byQuery = await call("find_variables", { query: "employed" });
  assert.deepEqual(byQuery.structuredContent.variables, [{ variable_id: 1, name: "Employed persons - LFS", section_count: 2 }]);

  const none = await call("find_variables", {});
  assert.equal(none.isError, true);
  assert.equal(none.structuredContent.error.code, "INVALID_ARGUMENT");

  const emptyArea = await call("find_variables", { area_id: 1 });
  assert.equal(emptyArea.structuredContent.error.code, "NOT_FOUND");
  assert.match(emptyArea.structuredContent.error.hint, /child areas/);
});

test("get_variable_metadata strips HTML and reports sections", async () => {
  const { call } = setup();
  const res = await call("get_variable_metadata", { variable_id: 1 });
  const meta = res.structuredContent;
  assert.equal(meta.concepts[0].definition, "Persons who worked & earned.");
  assert.equal(meta.methodology.notki[0].opis, "Survey based.");
  assert.equal(meta.sections[0].time_series, "2010 - 2020");
  assert.deepEqual(meta.legal_acts, []);

  const short = await call("get_variable_metadata", { variable_id: 1, include_definitions: false });
  assert.equal(short.structuredContent.concepts[0].definition, undefined);
  assert.equal(short.structuredContent.methodology, undefined);

  const missing = await call("get_variable_metadata", { variable_id: 999 });
  assert.equal(missing.structuredContent.error.code, "NOT_FOUND");
});

test("list_sections_and_periods decodes periods and year ranges", async () => {
  const { call } = setup();
  const res = await call("list_sections_and_periods", { variable_id: 1 });
  const [first, second] = res.structuredContent.sections;
  assert.equal(first.section_id, 1163);
  assert.deepEqual(first.years, { from: 2010, to: 2020 });
  assert.deepEqual(first.periods.map((p: { symbol: string }) => p.symbol), ["Q1", "Q2"]);
  assert.equal(second.frequency, "Year");
});

test("get_section_dimensions groups and paginates positions", async () => {
  const { call } = setup();
  const res = await call("get_section_dimensions", { section_id: 1163, dimension_id: 1, limit: 2 });
  const out = res.structuredContent;
  assert.deepEqual(out.dimensions.map((d: { name: string; position_count: number }) => [d.name, d.position_count]), [
    ["Sex", 3],
    ["Poland", 1],
    ["Age", 2],
  ]);
  assert.equal(out.positions.total, 3);
  assert.equal(out.positions.next_offset, 2);
});

test("estimate_data_size counts rows and judges complete retrieval", async () => {
  const { call } = setup({ dataRows: 12001 });
  const res = await call("estimate_data_size", DATA_ARGS);
  assert.equal(res.structuredContent.total_rows, 12001);
  assert.equal(res.structuredContent.pages_at_max_page_size, 3);
  assert.equal(res.structuredContent.complete_retrieval.allowed, true);

  const big = setup({ dataRows: 20001 });
  const tooBig = await big.call("estimate_data_size", DATA_ARGS);
  assert.equal(tooBig.structuredContent.complete_retrieval.allowed, false);
  assert.match(tooBig.structuredContent.recommendation, /get_data_page/);
});

test("data requests are validated against the catalog with helpful hints", async () => {
  const { call } = setup();
  const badSection = await call("preview_data", { ...DATA_ARGS, section_id: 5 });
  assert.equal(badSection.structuredContent.error.code, "NOT_FOUND");
  assert.match(badSection.structuredContent.error.hint, /1163 \(Poland; Sex; Age\)/);

  const badPeriod = await call("preview_data", { ...DATA_ARGS, period_id: 282 });
  assert.match(badPeriod.structuredContent.error.hint, /270 \(quarter - Q1\)/);

  const badYear = await call("preview_data", { ...DATA_ARGS, year: 1999 });
  assert.equal(badYear.structuredContent.error.code, "NO_DATA");
  assert.match(badYear.structuredContent.error.hint, /2010-2020/);

  const missingArg = await call("preview_data", { variable_id: 1 });
  assert.equal(missingArg.structuredContent.error.code, "INVALID_ARGUMENT");
  assert.match(missingArg.structuredContent.error.message, /section_id/);

  const wrongType = await call("preview_data", { ...DATA_ARGS, year: "twenty" });
  assert.match(wrongType.structuredContent.error.message, /"year" must be an integer/);

  const noData = await call("preview_data", { ...DATA_ARGS, year: 2020 });
  assert.equal(noData.structuredContent.error.code, "NO_DATA");
});

test("preview_data decodes rows and caps at 1000", async () => {
  const { call } = setup({ dataRows: 1500 });
  const res = await call("preview_data", DATA_ARGS);
  const out = res.structuredContent;
  assert.equal(out.total_rows, 1500);
  assert.equal(out.returned_rows, 1000);
  assert.equal(out.truncated, true);
  assert.deepEqual(out.dimensions, ["Sex", "Poland", "Age"]);
  const [first, second] = out.rows;
  assert.deepEqual(first.dimensions, { Poland: "POLAND", Sex: "Males", Age: "15-24" });
  assert.equal(first.value, null);
  assert.equal(first.no_value, "(.) data not available");
  assert.equal(first.flag, "s Estimated value");
  assert.equal(first.period, "Q1");
  assert.equal(first.unit, "[thousand persons]");
  assert.equal(second.value, 1001);
  assert.equal(second.no_value, undefined);
  assert.equal(second.flag, undefined);
  assert.equal(second.codes, undefined);

  const withCodes = await call("preview_data", { ...DATA_ARGS, include_codes: true });
  assert.equal(withCodes.structuredContent.rows[0].codes["id-flaga"], 29);
});

test("get_data_page paginates and reports out-of-range pages", async () => {
  const { call } = setup({ dataRows: 25 });
  const p0 = await call("get_data_page", { ...DATA_ARGS, page_size: 10 });
  assert.equal(p0.structuredContent.page_count, 3);
  assert.equal(p0.structuredContent.next_page, 1);
  const p2 = await call("get_data_page", { ...DATA_ARGS, page_size: 10, page: 2 });
  assert.equal(p2.structuredContent.returned_rows, 5);
  assert.equal(p2.structuredContent.next_page, null);
  const p3 = await call("get_data_page", { ...DATA_ARGS, page_size: 10, page: 3 });
  assert.equal(p3.structuredContent.error.code, "PAGE_OUT_OF_RANGE");
  assert.match(p3.structuredContent.error.hint, /25 rows; valid pages are 0-2/);
  const tooBig = await call("get_data_page", { ...DATA_ARGS, page_size: 6000 });
  assert.equal(tooBig.structuredContent.error.code, "INVALID_ARGUMENT");
});

test("get_complete_data fetches every page and outputs escaped CSV", async () => {
  const { call, dbw } = setup({ dataRows: 12001 });
  const res = await call("get_complete_data", DATA_ARGS);
  const out = res.structuredContent;
  assert.equal(out.complete, true);
  assert.equal(out.upstream_pages, 3);
  const lines = out.csv.split("\n");
  assert.equal(lines.length, 12002);
  assert.equal(lines[0], "year,period,Sex,Poland,Age,value,precision,unit,no_value,confidentiality,flag");
  assert.equal(lines[1], "2019,Q1,Males,POLAND,15-24,,1,[thousand persons],(.) data not available,,s Estimated value");
  assert.equal(lines[4], '2019,Q1,Males,POLAND,"25 and over, ""total""",1003,1,[thousand persons],,,');
  const dataCalls = dbw.calls.filter((c) => c.url.pathname.endsWith("variable-data-section"));
  assert.deepEqual(dataCalls.map((c) => c.url.searchParams.get("numer-strony")), ["0", "0", "1", "2"]);
});

test("get_complete_data refuses oversized selections", async () => {
  const { call } = setup({ dataRows: 20001 });
  const res = await call("get_complete_data", DATA_ARGS);
  assert.equal(res.isError, true);
  assert.equal(res.structuredContent.error.code, "TOO_LARGE");
  assert.match(res.content[0].text, /^ERROR \[TOO_LARGE\]/);
  assert.match(res.structuredContent.error.hint, /pages 0-4/);
});

test("get_dictionary reads, filters and validates names", async () => {
  const { call } = setup();
  const flags = await call("get_dictionary", { name: "flags", query: "estimated" });
  assert.deepEqual(flags.structuredContent.entries, [{ id: 29, symbol: "s", name: "Estimated value" }]);
  const units = await call("get_dictionary", { name: "units" });
  assert.equal(units.structuredContent.entries[0].symbol, "thousand persons");
  const bad = await call("get_dictionary", { name: "secrets" });
  assert.equal(bad.structuredContent.error.code, "INVALID_ARGUMENT");
});

test("discovery responses are cached so repeat calls skip DBW", async () => {
  const { call, dbw } = setup();
  await call("search_areas", {});
  await call("search_areas", { query: "industry" });
  assert.equal(dbw.calls.filter((c) => c.url.pathname.endsWith("area-area")).length, 1);
  await call("find_variables", { query: "employed" });
  await call("find_variables", { query: "orders" });
  assert.equal(dbw.calls.filter((c) => c.url.pathname.endsWith("variable-section-periods")).length, 1);
});
