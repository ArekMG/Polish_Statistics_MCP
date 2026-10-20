import assert from "node:assert/strict";
import { test } from "node:test";
import type { RateLimiter } from "../store.ts";
import { allowAll, type RecordedCall } from "./helpers.ts";
import { createDbwClient } from "../dbw-client.ts";
import { createMcpHandler } from "../server.ts";
import { tools } from "../tools.ts";
import type { Cache } from "../store.ts";

// This test simulates the full research flow for the question:
// "Które powiaty wyludniają się najszybciej i w jakim stopniu to efekt niskiej dzietności, a w jakim migracji?"
// (Which counties are depopulating fastest, and how much is due to low fertility vs migration?)
//
// It proves that an AI agent using only the MCP tools can:
// 1. Discover population, birth, death, and migration variables
// 2. Find county-level (powiat) sections with territorial breakdowns
// 3. Download multi-year data filtered to counties
// 4. Get enough data to compute population decline and decompose it

// --- Mock DBW data mirroring real variable/section structures ---

const POP_VAR = 421;      // "Ludność" (Population)
const BIRTHS_VAR = 422;   // "Urodzenia żywe" (Live births)
const DEATHS_VAR = 423;   // "Zgony" (Deaths)
const MIGRATION_IN_VAR = 424;   // "Migracje wewnętrzne - napływ" (Internal migration inflow)
const MIGRATION_OUT_VAR = 425;  // "Migracje wewnętrzne - odpływ" (Internal migration outflow)

const POP_SECTION = 1500;      // "Powiaty" (Counties)
const MIGRATION_SECTION = 1501;

const areas = [
  { id: 727, nazwa: "Statystyka publiczna", "id-nadrzedny-element": null, "id-poziom": 0, "nazwa-poziom": "Root", "czy-zmienne": false },
  { id: 300, nazwa: "Ludność", "id-nadrzedny-element": 727, "id-poziom": 1, "nazwa-poziom": "Domain", "czy-zmienne": true },
  { id: 310, nazwa: "Ruch naturalny", "id-nadrzedny-element": 727, "id-poziom": 1, "nazwa-poziom": "Domain", "czy-zmienne": true },
  { id: 320, nazwa: "Migracje", "id-nadrzedny-element": 727, "id-poziom": 1, "nazwa-poziom": "Domain", "czy-zmienne": true },
];

const sectionPeriods = [
  { "id-zmienna": POP_VAR, "nazwa-zmienna": "Ludność", "id-przekroj": POP_SECTION, "nazwa-przekroj": "Powiaty; Płeć", "id-okres": 282 },
  { "id-zmienna": BIRTHS_VAR, "nazwa-zmienna": "Urodzenia żywe", "id-przekroj": POP_SECTION, "nazwa-przekroj": "Powiaty; Płeć", "id-okres": 282 },
  { "id-zmienna": DEATHS_VAR, "nazwa-zmienna": "Zgony", "id-przekroj": POP_SECTION, "nazwa-przekroj": "Powiaty; Płeć", "id-okres": 282 },
  { "id-zmienna": MIGRATION_IN_VAR, "nazwa-zmienna": "Migracje wewnętrzne - napływ", "id-przekroj": MIGRATION_SECTION, "nazwa-przekroj": "Powiaty", "id-okres": 282 },
  { "id-zmienna": MIGRATION_OUT_VAR, "nazwa-zmienna": "Migracje wewnętrzne - odpływ", "id-przekroj": MIGRATION_SECTION, "nazwa-przekroj": "Powiaty", "id-okres": 282 },
];

// 3 counties + Poland total. County codes follow the 10MMWWPPP000 pattern.
const popPositions = [
  { "id-wymiar": 3, "nazwa-wymiar": "Terytorium", "id-pozycja": 100, "nazwa-pozycja": "POLSKA", symbol: "10000000000000" },
  // Powiat suwalski (depopulating fast) - voivodeship 20, county 04
  { "id-wymiar": 3, "nazwa-wymiar": "Terytorium", "id-pozycja": 201, "nazwa-pozycja": "Powiat suwalski", symbol: "10020000004000" },
  // Powiat hajnowski (depopulating fast) - voivodeship 20, county 01
  { "id-wymiar": 3, "nazwa-wymiar": "Terytorium", "id-pozycja": 202, "nazwa-pozycja": "Powiat hajnowski", symbol: "10022000001000" },
  // Powiat poznański (growing) - voivodeship 30, county 04
  { "id-wymiar": 3, "nazwa-wymiar": "Terytorium", "id-pozycja": 203, "nazwa-pozycja": "Powiat poznański", symbol: "10043000004000" },
  { "id-wymiar": 4, "nazwa-wymiar": "Płeć", "id-pozycja": 50, "nazwa-pozycja": "Razem", symbol: "0" },
];

const migrationPositions = [
  { "id-wymiar": 3, "nazwa-wymiar": "Terytorium", "id-pozycja": 100, "nazwa-pozycja": "POLSKA", symbol: "10000000000000" },
  { "id-wymiar": 3, "nazwa-wymiar": "Terytorium", "id-pozycja": 201, "nazwa-pozycja": "Powiat suwalski", symbol: "10020000004000" },
  { "id-wymiar": 3, "nazwa-wymiar": "Terytorium", "id-pozycja": 202, "nazwa-pozycja": "Powiat hajnowski", symbol: "10022000001000" },
  { "id-wymiar": 3, "nazwa-wymiar": "Terytorium", "id-pozycja": 203, "nazwa-pozycja": "Powiat poznański", symbol: "10043000004000" },
];

// Realistic population trends (in thousands) - population_change ≈ natural_increase + net_migration
const popData: Record<number, Record<number, number>> = {
  100: { 2018: 37977, 2019: 37972, 2020: 37964, 2021: 37761 },
  201: { 2018: 35.2, 2019: 34.8, 2020: 34.3, 2021: 33.7 },   // Suwalski: declining ~1.5k over 3 years
  202: { 2018: 39.1, 2019: 38.6, 2020: 38.0, 2021: 37.3 },   // Hajnowski: declining ~1.8k over 3 years
  203: { 2018: 329.5, 2019: 332.0, 2020: 334.8, 2021: 337.2 }, // Poznański: growing
};

// Births in thousands per year
const birthsData: Record<number, Record<number, number>> = {
  100: { 2018: 388, 2019: 375, 2020: 356, 2021: 331 },
  201: { 2018: 0.32, 2019: 0.30, 2020: 0.28, 2021: 0.26 },
  202: { 2018: 0.35, 2019: 0.33, 2020: 0.30, 2021: 0.27 },
  203: { 2018: 3.8, 2019: 3.7, 2020: 3.6, 2021: 3.5 },
};

// Deaths in thousands per year
const deathsData: Record<number, Record<number, number>> = {
  100: { 2018: 414, 2019: 410, 2020: 477, 2021: 519 },
  201: { 2018: 0.41, 2019: 0.40, 2020: 0.48, 2021: 0.55 },
  202: { 2018: 0.43, 2019: 0.42, 2020: 0.50, 2021: 0.57 },
  203: { 2018: 3.1, 2019: 3.0, 2020: 3.4, 2021: 3.6 },
};

// Internal migration inflow in thousands per year
const migInData: Record<number, Record<number, number>> = {
  100: { 2018: 345, 2019: 340, 2020: 330, 2021: 335 },
  201: { 2018: 0.18, 2019: 0.17, 2020: 0.16, 2021: 0.15 },
  202: { 2018: 0.15, 2019: 0.14, 2020: 0.13, 2021: 0.12 },
  203: { 2018: 4.2, 2019: 4.5, 2020: 4.3, 2021: 4.6 },
};

// Internal migration outflow in thousands per year — adjusted so pop_change ≈ natural_increase + net_migration
const migOutData: Record<number, Record<number, number>> = {
  100: { 2018: 340, 2019: 335, 2020: 325, 2021: 330 },
  201: { 2018: 0.35, 2019: 0.34, 2020: 0.38, 2021: 0.41 },
  202: { 2018: 0.32, 2019: 0.31, 2020: 0.35, 2021: 0.39 },
  203: { 2018: 2.8, 2019: 2.9, 2020: 2.7, 2021: 2.8 },
};

function buildRows(variableId: number, sectionId: number, year: number, data: Record<number, Record<number, number>>, unitId: number) {
  const rows: Record<string, number | string | null>[] = [];
  const positions = sectionId === POP_SECTION ? popPositions : migrationPositions;
  let rownum = 1;
  for (const pos of positions) {
    if (pos["id-wymiar"] !== 3) continue; // only territory dimension
    const val = data[pos["id-pozycja"]]?.[year];
    if (val === undefined) continue;
    rows.push({
      rownumber: rownum++,
      "id-zmienna": variableId,
      "id-przekroj": sectionId,
      "id-wymiar-1": 3,
      "id-pozycja-1": pos["id-pozycja"],
      ...(sectionId === POP_SECTION ? { "id-wymiar-2": 4, "id-pozycja-2": 50 } : {}),
      "id-okres": 282,
      "id-sposob-prezentacji-miara": unitId,
      "id-daty": year,
      "id-brak-wartosci": null,
      "id-tajnosci": null,
      "id-flaga": null,
      wartosc: val,
      precyzja: sectionId === POP_SECTION ? 1 : 0,
    });
  }
  return rows;
}

const dictionaries: Record<string, unknown[]> = {
  "periods-dictionary": [
    { "id-okres": 282, symbol: "", opis: "rok", "id-czestotliwosc": 1, "nazwa-czestotliwosc": "Rok", "nazwa-typ": "Rok" },
  ],
  "way-of-presentation": [
    { "id-sposob-prezentacji-miara": 98, nazwa: "[osoby]", "oznaczenie-jednostki": "<p>osoby</p>", "nazwa-jednostki": "osoby", "nazwa-sposob-prezentacji": "jednostki miary" },
    { "id-sposob-prezentacji-miara": 99, nazwa: "[tys.]", "oznaczenie-jednostki": "<p>tys.</p>", "nazwa-jednostki": "tysiące", "nazwa-sposob-prezentacji": "jednostki miary" },
  ],
  "no-value-dictionary": [],
  "confidentionality-dictionary": [],
  "flag-dictionary": [],
  "date-dictionary": [{ "id-rok": 2018 }, { "id-rok": 2019 }, { "id-rok": 2020 }, { "id-rok": 2021 }],
};

function metaFor(variableId: number, name: string) {
  return {
    "id-zmienna": variableId,
    nazwa: name,
    "nazwa-skrocona": name,
    tagi: [{ "id-tag": 1, "nazwa-tag": "demografia" }],
    pojecia: [],
    "wyjasnienia-metodologiczne": null,
    przekroje: [
      variableId === MIGRATION_IN_VAR || variableId === MIGRATION_OUT_VAR
        ? { "id-przekroj": MIGRATION_SECTION, "nazwa-przekroj": "Powiaty", "szereg-czasowy": "2010 - 2022", "nazwa-czestotliwosc": "Rok", "aktualizacja-ostatnia": "2024-01-01" }
        : { "id-przekroj": POP_SECTION, "nazwa-przekroj": "Powiaty; Płeć", "szereg-czasowy": "2002 - 2022", "nazwa-czestotliwosc": "Rok", "aktualizacja-ostatnia": "2024-01-01" },
    ],
    zestawy: [],
    badania: [],
    "akty-prawne": [],
    jednostki: [],
  };
}

function fakeDbw() {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    const path = url.pathname.replace(/^\/api\/1\.2\.0/, "");
    const q = (k: string) => url.searchParams.get(k);
    const n = (k: string) => Number(q(k));
    let body: unknown = null;
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    const notFound = () => new Response(JSON.stringify({ "error-reason": "Not Found", status: "404" }), { status: 404 });
    const page = <T,>(items: T[], p: number, size: number) => ({ "page-number": p, "page-size": size, "page-count": Math.max(1, Math.ceil(items.length / size)), data: items.slice(p * size, (p + 1) * size) });

    if (path === "/area/area-area") body = areas;
    else if (path === "/area/area-variable") {
      const areaId = n("id-obszaru");
      const vars: Record<number, { id: number; nazwa: string; "id-zmienna": number; "nazwa-zmienna": string }[]> = {
        300: [{ id: 300, nazwa: "Ludność", "id-zmienna": POP_VAR, "nazwa-zmienna": "Ludność" }],
        310: [
          { id: 310, nazwa: "Ruch naturalny", "id-zmienna": BIRTHS_VAR, "nazwa-zmienna": "Urodzenia żywe" },
          { id: 310, nazwa: "Ruch naturalny", "id-zmienna": DEATHS_VAR, "nazwa-zmienna": "Zgony" },
        ],
        320: [
          { id: 320, nazwa: "Migracje", "id-zmienna": MIGRATION_IN_VAR, "nazwa-zmienna": "Migracje wewnętrzne - napływ" },
          { id: 320, nazwa: "Migracje", "id-zmienna": MIGRATION_OUT_VAR, "nazwa-zmienna": "Migracje wewnętrzne - odpływ" },
        ],
      };
      body = vars[areaId] ?? null;
    } else if (path === "/variable/variable-section-periods") {
      body = page(sectionPeriods, n("numer-strony"), n("ile-na-stronie"));
    } else if (path === "/variable/variable-meta") {
      const id = n("id-zmiennej");
      const names: Record<number, string> = {
        [POP_VAR]: "Ludność", [BIRTHS_VAR]: "Urodzenia żywe", [DEATHS_VAR]: "Zgony",
        [MIGRATION_IN_VAR]: "Migracje wewnętrzne - napływ", [MIGRATION_OUT_VAR]: "Migracje wewnętrzne - odpływ",
      };
      body = names[id] ? metaFor(id, names[id]) : null;
    } else if (path === "/variable/variable-section-position") {
      const sectionId = n("id-przekroj");
      body = sectionId === POP_SECTION ? popPositions : sectionId === MIGRATION_SECTION ? migrationPositions : null;
    } else if (path === "/variable/variable-data-section") {
      const varId = n("id-zmienna");
      const sectionId = n("id-przekroj");
      const year = n("id-rok");
      const size = n("ile-na-stronie");
      if (year >= 2018 && year <= 2021 && size <= 5000) {
        if (varId === POP_VAR && sectionId === POP_SECTION) body = page(buildRows(POP_VAR, POP_SECTION, year, popData, 99), n("numer-strony"), size);
        else if (varId === BIRTHS_VAR && sectionId === POP_SECTION) body = page(buildRows(BIRTHS_VAR, POP_SECTION, year, birthsData, 99), n("numer-strony"), size);
        else if (varId === DEATHS_VAR && sectionId === POP_SECTION) body = page(buildRows(DEATHS_VAR, POP_SECTION, year, deathsData, 99), n("numer-strony"), size);
        else if (varId === MIGRATION_IN_VAR && sectionId === MIGRATION_SECTION) body = page(buildRows(MIGRATION_IN_VAR, MIGRATION_SECTION, year, migInData, 98), n("numer-strony"), size);
        else if (varId === MIGRATION_OUT_VAR && sectionId === MIGRATION_SECTION) body = page(buildRows(MIGRATION_OUT_VAR, MIGRATION_SECTION, year, migOutData, 98), n("numer-strony"), size);
      }
    } else if (path.startsWith("/dictionaries/")) {
      const items = dictionaries[path.slice("/dictionaries/".length)];
      body = items ? page(items, n("page"), n("page-size")) : null;
    }
    return Promise.resolve(body === null ? notFound() : ok(body));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function memoryCache(): Cache & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: <T>(key: string) => Promise.resolve(store.get(key) as T | undefined),
    presence: (keys: string[]) => {
      const out = new Map<string, number | null>();
      for (const k of keys) {
        if (!store.has(k)) continue;
        const pc = (store.get(k) as { "page-count"?: unknown } | null)?.["page-count"];
        out.set(k, typeof pc === "number" ? pc : null);
      }
      return Promise.resolve(out);
    },
    set: (key: string, value: unknown) => { store.set(key, structuredClone(value)); return Promise.resolve(); },
    stats: () => Promise.resolve({ entries: store.size, bytes: 0 }),
  };
}

function setup() {
  const dbw = fakeDbw();
  const cache = memoryCache();
  const client = createDbwClient({ limiter: allowAll, cache, fetchImpl: dbw.fetchImpl, sleep: () => Promise.resolve() });
  const handler = createMcpHandler({ tools, context: { client, cache }, limiter: allowAll });
  let nextId = 1;
  async function rpc(method: string, params?: unknown) {
    const res = await handler(new Request("http://localhost/dbw-mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
    }));
    return (await res.json()).result as { isError?: boolean; structuredContent: Record<string, any>; content: { text: string }[] };
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    return rpc("tools/call", { name, arguments: args });
  }
  return { call, dbw };
}

// --- The actual research flow test ---

test("full research flow: county depopulation decomposition into fertility and migration", async () => {
  const { call } = setup();

  // Step 1: Discover the demography area using English synonym "population"
  // (G8: synonym search should find "Ludność")
  const areasRes = await call("search_areas", { query: "population" });
  const areas = areasRes.structuredContent.areas;
  const ludnoscArea = areas.find((a: { name: string }) => a.name.includes("Ludność"));
  assert.ok(ludnoscArea, "search_areas with 'population' should find the Ludność area via synonyms");

  // Step 2: Find the population variable in that area
  const varsRes = await call("find_variables", { area_id: ludnoscArea.area_id });
  const popVar = varsRes.structuredContent.variables.find((v: { name: string }) => v.name === "Ludność");
  assert.ok(popVar, "find_variables should return the Ludność variable");

  // Step 3: Find births and deaths variables in the "Ruch naturalny" area
  const naturalAreasRes = await call("search_areas", { query: "natural" });
  const ruchArea = naturalAreasRes.structuredContent.areas.find((a: { name: string }) => a.name.includes("Ruch"));
  assert.ok(ruchArea, "search_areas should find 'Ruch naturalny' area");

  const naturalVarsRes = await call("find_variables", { area_id: ruchArea.area_id });
  const birthsVar = naturalVarsRes.structuredContent.variables.find((v: { name: string }) => v.name.includes("Urodzenia"));
  const deathsVar = naturalVarsRes.structuredContent.variables.find((v: { name: string }) => v.name.includes("Zgony"));
  assert.ok(birthsVar, "find_variables should return births variable");
  assert.ok(deathsVar, "find_variables should return deaths variable");

  // Step 4: Find migration variables via synonym search
  const migrationAreasRes = await call("search_areas", { query: "migration" });
  const migArea = migrationAreasRes.structuredContent.areas.find((a: { name: string }) => a.name.includes("Migrac"));
  assert.ok(migArea, "search_areas with 'migration' should find Migracje area via synonyms");

  const migVarsRes = await call("find_variables", { area_id: migArea.area_id });
  const migInVar = migVarsRes.structuredContent.variables.find((v: { name: string }) => v.name.includes("napływ"));
  const migOutVar = migVarsRes.structuredContent.variables.find((v: { name: string }) => v.name.includes("odpływ"));
  assert.ok(migInVar, "find_variables should return migration inflow variable");
  assert.ok(migOutVar, "find_variables should return migration outflow variable");

  // Step 5: List sections for population variable — find the county-level section
  const sectionsRes = await call("list_sections_and_periods", { variable_id: popVar.variable_id });
  const countySection = sectionsRes.structuredContent.sections.find((s: { name: string }) => s.name.includes("Powiat"));
  assert.ok(countySection, "list_sections_and_periods should return a county section");
  const periodId = countySection.periods[0].period_id;

  // Step 6: Get section dimensions to confirm county-level positions exist
  const dimsRes = await call("get_section_dimensions", { section_id: countySection.section_id, level: "county" });
  const countyPositions = dimsRes.structuredContent.positions.items;
  assert.ok(countyPositions.length >= 2, "get_section_dimensions should return county-level positions");
  assert.ok(countyPositions.every((p: { is_current: boolean }) => p.is_current), "all positions should be current");
  assert.ok(countyPositions.every((p: { level: string }) => p.level === "county"), "all positions should be at county level");
  const countyIds = countyPositions.map((p: { position_id: number }) => p.position_id);

  // Step 7: Download population data for multiple years, filtered to counties
  const years = [2018, 2019, 2020, 2021];
  const popData = (await call("get_data_series", {
    variable_id: popVar.variable_id,
    section_id: countySection.section_id,
    years,
    levels: ["county"],
    format: "wide",
  })).structuredContent;

  assert.equal(popData.complete, true);
  assert.equal(popData.truncated, false);
  assert.ok(popData.total_rows > 0, "should have population data rows");
  assert.ok(popData.key_columns.includes("unit"), "wide format should include key_columns (G6)");
  assert.deepEqual(popData.columns.map(Number).sort(), years, "wide columns should be the requested years");

  // Step 8: Download births data for the same counties and years
  const birthsData = (await call("get_data_series", {
    variable_id: birthsVar.variable_id,
    section_id: countySection.section_id,
    years,
    levels: ["county"],
  })).structuredContent;
  assert.equal(birthsData.complete, true);
  assert.ok(birthsData.returned_rows > 0, "should have births data rows");

  // Step 9: Download deaths data
  const deathsData = (await call("get_data_series", {
    variable_id: deathsVar.variable_id,
    section_id: countySection.section_id,
    years,
    levels: ["county"],
  })).structuredContent;
  assert.equal(deathsData.complete, true);

  // Step 10: Find the migration section and download inflow/outflow
  const migSectionsRes = await call("list_sections_and_periods", { variable_id: migInVar.variable_id });
  const migSection = migSectionsRes.structuredContent.sections[0];

  const migInData = (await call("get_data_series", {
    variable_id: migInVar.variable_id,
    section_id: migSection.section_id,
    years,
    levels: ["county"],
  })).structuredContent;
  assert.equal(migInData.complete, true);

  const migOutData = (await call("get_data_series", {
    variable_id: migOutVar.variable_id,
    section_id: migSection.section_id,
    years,
    levels: ["county"],
  })).structuredContent;
  assert.equal(migOutData.complete, true);

  // Step 11: Verify the data is sufficient to compute the decomposition
  // An AI agent would now compute, for each county:
  //   population_change = pop[year+1] - pop[year]
  //   natural_increase = births[year] - deaths[year]
  //   net_migration = mig_in[year] - mig_out[year]
  //   residual = population_change - natural_increase - net_migration (should be ~0)
  //   fertility_share = natural_increase / population_change
  //   migration_share = net_migration / population_change

  const popTable = new Map<string, Record<string, number | string | null>>(popData.table.map((r: Record<string, unknown>) => [r.Terytorium as string, r as Record<string, number | string | null>]));
  const birthsRows = birthsData.rows as Record<string, unknown>[];
  const deathsRows = deathsData.rows as Record<string, unknown>[];
  const migInRows = migInData.rows as Record<string, unknown>[];
  const migOutRows = migOutData.rows as Record<string, unknown>[];

  const birthsByCountyYear = new Map<string, number>();
  for (const r of birthsRows) birthsByCountyYear.set(`${(r.dimensions as Record<string, string>).Terytorium}|${r.year}`, Number(r.value));
  const deathsByCountyYear = new Map<string, number>();
  for (const r of deathsRows) deathsByCountyYear.set(`${(r.dimensions as Record<string, string>).Terytorium}|${r.year}`, Number(r.value));
  const migInByCountyYear = new Map<string, number>();
  for (const r of migInRows) migInByCountyYear.set(`${(r.dimensions as Record<string, string>).Terytorium}|${r.year}`, Number(r.value));
  const migOutByCountyYear = new Map<string, number>();
  for (const r of migOutRows) migOutByCountyYear.set(`${(r.dimensions as Record<string, string>).Terytorium}|${r.year}`, Number(r.value));

  // Compute for Suwalski (2018 -> 2021)
  const suwalski = "Powiat suwalski";
  const pop2018 = Number(popTable.get(suwalski)!["2018"]);
  const pop2021 = Number(popTable.get(suwalski)!["2021"]);
  const popChange = pop2021 - pop2018;

  const birthsTotal = years.reduce((s, y) => s + (birthsByCountyYear.get(`${suwalski}|${y}`) ?? 0), 0);
  const deathsTotal = years.reduce((s, y) => s + (deathsByCountyYear.get(`${suwalski}|${y}`) ?? 0), 0);
  const naturalIncrease = birthsTotal - deathsTotal;

  const migInTotal = years.reduce((s, y) => s + (migInByCountyYear.get(`${suwalski}|${y}`) ?? 0), 0);
  const migOutTotal = years.reduce((s, y) => s + (migOutByCountyYear.get(`${suwalski}|${y}`) ?? 0), 0);
  const netMigration = migInTotal - migOutTotal;

  // Both components should be negative (contributing to decline)
  assert.ok(naturalIncrease < 0, "Suwalski should have negative natural increase (more deaths than births)");
  assert.ok(netMigration < 0, "Suwalski should have negative net migration (more outflow than inflow)");
  assert.ok(popChange < 0, "Suwalski should have declining population");

  // The two components should roughly sum to the population change
  const decomposition = naturalIncrease + netMigration;
  const shareFertility = naturalIncrease / popChange;
  const shareMigration = netMigration / popChange;

  // Verify the decomposition is meaningful (shares should sum to ~1)
  assert.ok(Math.abs(shareFertility + shareMigration - 1) < 0.15,
    `Fertility share (${shareFertility.toFixed(2)}) + migration share (${shareMigration.toFixed(2)}) should be close to 1`);

  // Hajnowski should also be depopulating
  const hajnowski = "Powiat hajnowski";
  const hajPop2018 = Number(popTable.get(hajnowski)!["2018"]);
  const hajPop2021 = Number(popTable.get(hajnowski)!["2021"]);
  assert.ok(hajPop2021 < hajPop2018, "Hajnowski should be depopulating");

  // Poznański should be growing
  const poznanski = "Powiat poznański";
  const pozPop2018 = Number(popTable.get(poznanski)!["2018"]);
  const pozPop2021 = Number(popTable.get(poznanski)!["2021"]);
  assert.ok(pozPop2021 > pozPop2018, "Poznański should be growing");

  // Step 12: dry_run with probe_uncached (G7) to estimate worst-case cost for a larger request
  const plan = (await call("get_data_series", {
    variable_id: popVar.variable_id,
    section_id: countySection.section_id,
    years: [2010, 2011, 2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021],
    levels: ["county"],
    dry_run: true,
    probe_uncached: true,
  })).structuredContent;

  assert.equal(plan.dry_run, true);
  assert.equal(plan.probe_uncached, undefined); // probe_uncached is a presentation arg, not in output
  // With probe_uncached, all in-range combos should be to_fetch
  const allStatuses = Object.values(plan.coverage).flatMap((y: unknown) => Object.values(y as Record<string, string>));
  assert.ok(allStatuses.every((s: string) => s === "to_fetch" || s === "outside_range"),
    "probe_uncached should mark everything as to_fetch or outside_range");
  assert.ok(plan.estimated_dbw_requests.minimum > 0);

  // Summary: the MCP tools provided everything needed to answer the question
  // without any direct API calls. The agent used:
  // - search_areas (with synonym support) to discover domains
  // - find_variables to get variable ids
  // - list_sections_and_periods to find county-level sections
  // - get_section_dimensions to confirm county positions and levels
  // - get_data_series (wide format) to get population trends per county
  // - get_data_series for births, deaths, migration inflow, outflow
  // - dry_run + probe_uncached to plan a larger historical download
});

test("quota_status includes error catalog for agent guidance (G9)", async () => {
  const { call } = setup();
  const out = (await call("quota_status")).structuredContent;
  assert.ok(out.error_codes, "quota_status should include error_codes catalog");
  assert.ok(out.error_codes.RATE_LIMITED, "catalog should include RATE_LIMITED");
  assert.ok(out.error_codes.BUDGET_EXHAUSTED, "catalog should include BUDGET_EXHAUSTED");
  assert.ok(out.error_codes.TOO_LARGE, "catalog should include TOO_LARGE");
  assert.ok(out.cache, "quota_status should include cache stats (G4)");
});
