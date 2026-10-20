import { aggregateByYear, parseAggregate, periodRank } from "./aggregate.ts";
import { type Args, boolArg, enumArg, intArg, intListArg, langArg, normalizeText, strListArg } from "./args.ts";
import { getSectionPositions, type SectionPosition, TERRITORIAL_LEVELS, type TerritorialLevel } from "./catalog.ts";
import { DBW_MAX_PAGE_SIZE } from "./dbw-client.ts";
import {
  createRowDecoder,
  type DecodedRow,
  dimensionOrder,
  getDecodingDictionaries,
  getDictionary,
  type RawDataRow,
  rowsToCsv,
} from "./decode.ts";
import {
  DATA_TTL,
  type DataRequest,
  dataPageCacheKey,
  describePeriods,
  fetchDataPage,
  MAX_COMPLETE_ROWS,
  resolveSection,
  type ToolContext,
} from "./data.ts";
import { isToolError, ToolError } from "./errors.ts";
import { parseRounding, roundValue } from "./rounding.ts";
import { sha256Hex } from "./store.ts";

type Group = { label: string; rows: DecodedRow[] };
type SeriesResult = {
  core: Record<string, unknown>;
  executed: Record<string, unknown>[];
  dimensions: string[];
  groups: Group[];
  revision: string;
  storedAt: string;
};

const PRESENTATION_ARGS = new Set(["format", "include_executed", "dry_run", "force_refresh", "max_requests", "budget_strategy", "probe_uncached"]);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Keyed on every argument that changes the numbers, so format and list trimming reuse one cached result.
async function resultCacheKey(args: Args, lang: string) {
  const relevant = Object.fromEntries(Object.entries(args).filter(([k]) => !PRESENTATION_ARGS.has(k)));
  return `series|v1|${await sha256Hex(stableJson({ ...relevant, lang }))}`;
}

function present(
  result: SeriesResult,
  format: "json" | "csv" | "wide",
  includeExecuted: boolean,
  fromCache: boolean,
): Record<string, unknown> {
  const decoded = result.groups.flatMap((g) => g.rows);
  const totalRows = result.core.total_rows as number | undefined;
  const truncated = Boolean(result.core.truncated);
  return {
    ...result.core,
    executed: includeExecuted ? result.executed : undefined,
    executed_count: result.executed.length,
    returned_rows: decoded.length,
    ...(totalRows !== undefined ? { total_rows: totalRows } : {}),
    truncated,
    format,
    dimensions: result.dimensions,
    revision: result.revision,
    ...(fromCache ? { from_result_cache: true, cache: { hit: true, stored_at: result.storedAt } } : { cache: { hit: false } }),
    ...(format === "csv"
      ? { csv: rowsToCsv(decoded, result.dimensions) }
      : format === "wide"
      ? toWide(result.groups, result.dimensions)
      : { rows: decoded }),
  };
}

export const MAX_SERIES_COMBINATIONS = 120;
export const MAX_SERIES_YEARS = 30;
const MAX_PAGES_PER_COMBINATION = MAX_COMPLETE_ROWS / DBW_MAX_PAGE_SIZE;
const CONCURRENCY = 3;
const TIME_BUDGET_MS = 90_000;

const LEVEL_ALIASES: Record<string, TerritorialLevel> = {
  polska: "poland",
  makroregion: "macroregion",
  wojewodztwo: "voivodeship",
  wojewodztwa: "voivodeship",
  podregion: "subregion",
  powiat: "county",
  powiaty: "county",
  gmina: "municipality",
  gminy: "municipality",
};

function parseLevels(args: Args): Set<TerritorialLevel> | undefined {
  const raw = strListArg(args, "levels", TERRITORIAL_LEVELS.length);
  if (!raw) return undefined;
  const out = new Set<TerritorialLevel>();
  for (const value of raw) {
    const key = normalizeText(value);
    const level = (TERRITORIAL_LEVELS as readonly string[]).includes(key) ? key as TerritorialLevel : LEVEL_ALIASES[key];
    if (!level) {
      throw new ToolError("INVALID_ARGUMENT", `Unknown level "${value}".`, {
        hint: `Use one of: ${TERRITORIAL_LEVELS.join(", ")}.`,
      });
    }
    out.add(level);
  }
  return out;
}

type Combination = { year: number; periodId: number; period: string; periodName: string };
type CoverageStatus = "cached" | "empty" | "outside_range" | "to_fetch";

const noDataKey = (req: DataRequest) => `nodata|${req.variableId}|${req.sectionId}|${req.year}|${req.periodId}`;

type Coverage = { status: CoverageStatus; requests: number };

// Two batched cache lookups for the whole selection, whatever its size.
async function planCoverage(ctx: ToolContext, reqs: DataRequest[]): Promise<Coverage[]> {
  const firstKeys = reqs.map((r) => dataPageCacheKey(r, 0, DBW_MAX_PAGE_SIZE));
  const found = await ctx.cache.presence([...reqs.map(noDataKey), ...firstKeys]);
  const extraKeys = reqs.map((r, i) => {
    const pageCount = Math.min(found.get(firstKeys[i]) ?? 1, MAX_PAGES_PER_COMBINATION);
    return Array.from({ length: Math.max(pageCount - 1, 0) }, (_, p) => dataPageCacheKey(r, p + 1, DBW_MAX_PAGE_SIZE));
  });
  const extraFound = extraKeys.some((k) => k.length) ? await ctx.cache.presence(extraKeys.flat()) : new Map();
  return reqs.map((r, i) => {
    if (found.has(noDataKey(r))) return { status: "empty", requests: 0 };
    if (!found.has(firstKeys[i])) return { status: "to_fetch", requests: 1 };
    const missing = extraKeys[i].filter((k) => !extraFound.has(k)).length;
    return { status: missing ? "to_fetch" : "cached", requests: missing };
  });
}

// Splits in-range combinations into chunks that fit within the remaining DBW request budget.
function chunkCombos(combos: Combination[], budget: number): { years: number[]; period_ids: number[]; estimated_requests: number }[] {
  const chunks: { years: Set<number>; period_ids: Set<number>; estimated_requests: number }[] = [];
  let current = { years: new Set<number>(), period_ids: new Set<number>(), estimated_requests: 0 };
  for (const c of combos) {
    if (current.estimated_requests >= budget && current.years.size > 0) {
      chunks.push(current);
      current = { years: new Set<number>(), period_ids: new Set<number>(), estimated_requests: 0 };
    }
    current.years.add(c.year);
    current.period_ids.add(c.periodId);
    current.estimated_requests++;
  }
  if (current.years.size > 0) chunks.push(current);
  return chunks.map((c) => ({
    years: [...c.years].sort((a, b) => a - b),
    period_ids: [...c.period_ids].sort((a, b) => a - b),
    estimated_requests: c.estimated_requests,
  }));
}

function isAnnualPeriod(p: { symbol: string; name: string }) {
  return /^(rok|year)\b/i.test(normalizeText(p.name)) || (p.symbol === "" && /rok|year|annual/i.test(p.name));
}
type Outcome =
  | { status: "ok"; rows: RawDataRow[] }
  | { status: "empty"; reason: string }
  | { status: "pending"; reason: string };

function rowPositions(raw: RawDataRow): [number, number][] {
  const out: [number, number][] = [];
  for (let n = 1; raw[`id-wymiar-${n}`] !== undefined; n++) {
    out.push([Number(raw[`id-wymiar-${n}`]), Number(raw[`id-pozycja-${n}`])]);
  }
  return out;
}

// Only dimensions touched by a filter are restricted; others pass through unchanged.
function buildPositionFilter(positions: SectionPosition[], positionIds?: number[], levels?: Set<TerritorialLevel>) {
  if (!positionIds && !levels) return undefined;
  const known = new Set(positions.map((p) => p.positionId));
  const unknown = positionIds?.filter((id) => !known.has(id)) ?? [];
  if (unknown.length) {
    throw new ToolError("INVALID_ARGUMENT", `Position ids not in this section: ${unknown.join(", ")}.`, {
      hint: "Use get_section_dimensions to list valid position ids.",
    });
  }
  const idDims = new Set(positions.filter((p) => positionIds?.includes(p.positionId)).map((p) => p.dimensionId));
  const levelDims = new Set(positions.filter((p) => p.level !== null).map((p) => p.dimensionId));
  if (levels && levelDims.size === 0) {
    throw new ToolError("INVALID_ARGUMENT", "This section has no territorial dimension, so levels cannot be used.", {
      hint: "Filter with position_ids instead.",
    });
  }
  const allowed = new Map<number, Set<number>>();
  for (const p of positions) {
    const restrictedById = idDims.has(p.dimensionId);
    const restrictedByLevel = levels !== undefined && levelDims.has(p.dimensionId);
    if (!restrictedById && !restrictedByLevel) continue;
    const set = allowed.get(p.dimensionId) ?? new Set<number>();
    allowed.set(p.dimensionId, set);
    if (restrictedById && !positionIds!.includes(p.positionId)) continue;
    if (restrictedByLevel && !(p.level && levels!.has(p.level))) continue;
    set.add(p.positionId);
  }
  if ([...allowed.values()].some((s) => s.size === 0)) {
    const present = [...new Set(positions.map((p) => p.level).filter(Boolean))].join(", ");
    throw new ToolError("NO_DATA", "No positions in this section match the requested filter.", {
      hint: `Levels present in this section: ${present || "none"}.`,
    });
  }
  return (raw: RawDataRow) => rowPositions(raw).every(([dim, pos]) => allowed.get(dim)?.has(pos) ?? true);
}

async function resolvePeriods(ctx: ToolContext, args: Args, sectionPeriodIds: number[], lang: DataRequest["lang"]) {
  const ids = intListArg(args, "period_ids", { min: 1, max: 1_000_000, maxItems: 60 });
  const symbols = strListArg(args, "period_symbols", 60);
  if (ids && symbols) throw new ToolError("INVALID_ARGUMENT", 'Use either "period_ids" or "period_symbols", not both.');
  const dict = new Map((await getDictionary(ctx.client, "periods", lang)).map((p) => [p.id, p]));
  let chosen = sectionPeriodIds;
  if (ids) chosen = ids;
  if (symbols) {
    const bySymbol = new Map(sectionPeriodIds.map((id) => [(dict.get(id)?.symbol ?? "").toUpperCase(), id]));
    chosen = symbols.map((s) => bySymbol.get(s.toUpperCase()) ?? -1);
    const bad = symbols.filter((_, i) => chosen[i] === -1);
    if (bad.length) {
      throw new ToolError("INVALID_ARGUMENT", `Period symbols not available for this section: ${bad.join(", ")}.`, {
        hint: `Available periods: ${await describePeriods(ctx, sectionPeriodIds, lang)}.`,
      });
    }
  }
  const missing = chosen.filter((id) => !sectionPeriodIds.includes(id));
  if (missing.length) {
    throw new ToolError("INVALID_ARGUMENT", `Period ids not available for this section: ${missing.join(", ")}.`, {
      hint: `Available periods: ${await describePeriods(ctx, sectionPeriodIds, lang)}.`,
    });
  }
  return chosen.map((id) => ({ periodId: id, period: dict.get(id)?.symbol ?? "", periodName: dict.get(id)?.name ?? "" }));
}

async function fetchCombination(ctx: ToolContext, req: DataRequest): Promise<Outcome> {
  try {
    const first = await fetchDataPage(ctx, req, 0, DBW_MAX_PAGE_SIZE);
    if (first.pageCount > MAX_PAGES_PER_COMBINATION) {
      return { status: "empty", reason: `too large (over ${MAX_COMPLETE_ROWS} rows); use get_data_page` };
    }
    const rows = [...first.rows];
    for (let page = 1; page < first.pageCount; page++) {
      rows.push(...(await fetchDataPage(ctx, req, page, DBW_MAX_PAGE_SIZE)).rows);
    }
    return { status: "ok", rows };
  } catch (err) {
    if (isToolError(err, "NO_DATA")) {
      await ctx.cache.set(noDataKey(req), true, DATA_TTL);
      return { status: "empty", reason: "no data published for this year and period" };
    }
    throw err;
  }
}

function toWide(groups: { label: string; rows: DecodedRow[] }[], dimensions: string[]) {
  const columns = groups.map((g) => g.label);
  const keyColumns = [...dimensions, "unit"];
  const table = new Map<string, Record<string, string | number | null>>();
  for (const g of groups) {
    for (const r of g.rows) {
      const key = JSON.stringify([...dimensions.map((d) => r.dimensions[d]), r.unit]);
      let entry = table.get(key);
      if (!entry) {
        entry = Object.fromEntries(dimensions.map((d) => [d, r.dimensions[d] ?? null]));
        entry.unit = r.unit;
        for (const c of columns) entry[c] = null;
        table.set(key, entry);
      }
      entry[g.label] = r.value;
    }
  }
  return { columns, key_columns: keyColumns, table: [...table.values()] };
}

export async function getDataSeries(args: Args, ctx: ToolContext): Promise<Record<string, unknown>> {
  const variableId = intArg(args, "variable_id", { required: true, min: 1 });
  const sectionId = intArg(args, "section_id", { required: true, min: 1 });
  const years = intListArg(args, "years", { min: 1800, max: 2200, maxItems: MAX_SERIES_YEARS });
  if (!years) throw new ToolError("INVALID_ARGUMENT", '"years" is required, e.g. [2020, 2021, 2022].');
  const positionIds = intListArg(args, "position_ids", { min: 1, max: 1_000_000_000, maxItems: 1000 });
  const levels = parseLevels(args);
  const format = enumArg(args, "format", ["json", "csv", "wide"] as const, "json");
  const includeCodes = boolArg(args, "include_codes", false);
  const dryRun = boolArg(args, "dry_run", false);
  const forceRefresh = boolArg(args, "force_refresh", false);
  const probeUncached = boolArg(args, "probe_uncached", false);
  const includeExecuted = boolArg(args, "include_executed", true);
  const maxRequests = intArg(args, "max_requests", { min: 1, max: 1000 });
  const budgetStrategy = enumArg(args, "budget_strategy", ["partial", "strict", "wait"] as const, "partial");
  const aggregate = parseAggregate(args);
  const rounding = parseRounding(args);
  const lang = langArg(args);

  const resultKey = dryRun ? undefined : await resultCacheKey(args, lang);
  const hit = (!forceRefresh && resultKey) ? await ctx.cache.get<SeriesResult>(resultKey) : undefined;
  if (hit?.core && Array.isArray(hit.groups) && Array.isArray(hit.executed)) {
    return present(hit, format, includeExecuted, true);
  }

  const { variable, section, range } = await resolveSection(ctx, variableId, sectionId, lang);
  const periods = await resolvePeriods(ctx, args, section.periodIds, lang);
  const combos: Combination[] = [...years].sort((a, b) => a - b)
    .flatMap((year) => periods.map((p) => ({ year, ...p })));
  if (combos.length > MAX_SERIES_COMBINATIONS) {
    throw new ToolError("TOO_LARGE", `${combos.length} year/period combinations requested; the limit is ${MAX_SERIES_COMBINATIONS}.`, {
      hint: "Split the request into fewer years or periods.",
    });
  }

  const positions = await getSectionPositions(ctx.client, sectionId, lang);
  const keep = buildPositionFilter(positions, positionIds, levels);
  const dicts = await getDecodingDictionaries(ctx.client, lang);
  const decode = createRowDecoder(dicts, positions, includeCodes);
  const dimensions = dimensionOrder(positions);
  const requestFor = (c: Combination): DataRequest => ({
    variableId,
    variableName: variable.name,
    sectionId,
    sectionName: section.name,
    year: c.year,
    periodId: c.periodId,
    lang,
  });
  const outsideRange = (c: Combination) => Boolean(range && (c.year < range.from || c.year > range.to));
  const periodLabel = (p: { period: string; periodName: string }) => p.period || p.periodName;

  const periodDict = await getDictionary(ctx.client, "periods", lang);
  const annualIds = section.periodIds.filter((id) => {
    const p = periodDict.find((d) => d.id === id);
    return p !== undefined && isAnnualPeriod(p);
  });
  const chosenIds = periods.map((p) => p.periodId);
  const annualWarning = aggregate && annualIds.length && !annualIds.every((id) => chosenIds.includes(id))
    ? `This section also publishes an official annual value (period_ids ${annualIds.join(", ")}). ` +
      `Prefer it over a computed ${aggregate.fn}, which may differ methodologically.`
    : undefined;

  if (dryRun) {
    const matrix: Record<string, Record<string, CoverageStatus>> = {};
    const counts: Record<CoverageStatus, number> = { cached: 0, empty: 0, outside_range: 0, to_fetch: 0 };
    let estimated = 0;
    const inRange = combos.filter((c) => !outsideRange(c));
    const plan = probeUncached
      ? inRange.map(() => ({ status: "to_fetch" as CoverageStatus, requests: 1 }))
      : await planCoverage(ctx, inRange.map(requestFor));
    for (const c of combos) {
      const idx = inRange.indexOf(c);
      const cov: Coverage = idx === -1 ? { status: "outside_range", requests: 0 } : plan[idx];
      (matrix[String(c.year)] ??= {})[periodLabel(c)] = cov.status;
      counts[cov.status]++;
      estimated += cov.requests;
    }
    const quota = await ctx.client.quota();
    const tightest = quota?.filter((q) => q.window_seconds > 1).sort((a, b) => a.remaining - b.remaining)[0];
    return {
      variable_id: variableId,
      variable_name: variable.name,
      section_id: sectionId,
      section_name: section.name,
      lang,
      dry_run: true,
      published_years: range ? { from: range.from, to: range.to } : null,
      periods: periods.map((p) => ({ period_id: p.periodId, period: periodLabel(p) })),
      coverage: matrix,
      coverage_counts: counts,
      legend: {
        cached: "already downloaded; costs nothing",
        empty: "checked earlier: DBW has no data",
        outside_range: "outside the published years; skipped for free",
        to_fetch: "not downloaded yet; availability unknown until fetched",
      },
      estimated_dbw_requests: {
        minimum: estimated,
        note: "Each to_fetch combination costs 1 request per 5000 rows; most cost exactly 1. " +
          "Combinations with no data also cost 1 the first time, then are remembered.",
      },
      ...(tightest
        ? { fits_in_budget: estimated <= tightest.remaining, tightest_limit: tightest }
        : {}),
      ...(tightest && estimated > tightest.remaining
        ? {
            chunks: chunkCombos(combos.filter((c) => !outsideRange(c)), tightest.remaining),
            budget_strategy_hint: `estimated ${estimated} > remaining ${tightest.remaining}; use budget_strategy "strict" to refuse, or split into chunks.`,
          }
        : {}),
      ...(annualWarning ? { warning: annualWarning } : {}),
    };
  }

  // strict: refuse before fetching if the estimated cost exceeds the remaining budget.
  if (!dryRun && budgetStrategy === "strict") {
    const quota = await ctx.client.quota();
    const tightest = quota?.filter((q) => q.window_seconds > 1).sort((a, b) => a.remaining - b.remaining)[0];
    if (tightest) {
      const inRange = combos.filter((c) => !outsideRange(c));
      const plan = await planCoverage(ctx, inRange.map(requestFor));
      const estimated = plan.reduce((s, c) => s + c.requests, 0);
      if (estimated > tightest.remaining) {
        throw new ToolError("BUDGET_EXHAUSTED", `Estimated ${estimated} DBW requests but only ${tightest.remaining} remaining (limit "${tightest.limit_id}").`, {
          retryAfterSeconds: tightest.reset_after_seconds,
          hint: 'Use budget_strategy "partial" to fetch what fits, or wait for the budget to reset.',
          details: { limit_id: tightest.limit_id, estimated, remaining: tightest.remaining },
        });
      }
    }
  }

  const outcomes: Outcome[] = new Array(combos.length);
  const knownEmpty = await ctx.cache.presence(combos.map((c) => noDataKey(requestFor(c))));
  let retryAfter: number | undefined;
  let rateError: ToolError | undefined;
  let keptRows = 0;
  const started = Date.now();
  let requestsUsed = 0;
  let next = 0;

  async function worker() {
    while (next < combos.length) {
      const i = next++;
      const c = combos[i];
      if (outsideRange(c)) {
        outcomes[i] = { status: "empty", reason: `outside the published time series (${range!.from}-${range!.to})` };
        continue;
      }
      if (knownEmpty.has(noDataKey(requestFor(c)))) {
        outcomes[i] = { status: "empty", reason: "no data published for this year and period" };
        continue;
      }
      if (rateError) {
        outcomes[i] = { status: "pending", reason: "request budget used up" };
        continue;
      }
      if (maxRequests && requestsUsed >= maxRequests) {
        outcomes[i] = { status: "pending", reason: `max_requests limit of ${maxRequests} reached` };
        continue;
      }
      if (Date.now() - started > TIME_BUDGET_MS) {
        outcomes[i] = { status: "pending", reason: "time limit for one call reached" };
        continue;
      }
      if (keptRows > MAX_COMPLETE_ROWS) {
        outcomes[i] = { status: "pending", reason: `row limit of ${MAX_COMPLETE_ROWS} reached` };
        continue;
      }
      const req = requestFor(c);
      try {
        requestsUsed++;
        const out = await fetchCombination(ctx, req);
        if (out.status !== "ok") requestsUsed--;
        if (out.status === "ok" && keep) out.rows = out.rows.filter(keep);
        if (out.status === "ok") keptRows += out.rows.length;
        outcomes[i] = out;
      } catch (err) {
        if (isToolError(err, "RATE_LIMITED")) {
          rateError = err;
          retryAfter = Math.max(retryAfter ?? 0, err.retryAfterSeconds ?? 60);
          outcomes[i] = { status: "pending", reason: "request budget used up" };
        } else if (isToolError(err)) {
          outcomes[i] = { status: "pending", reason: err.message };
        } else {
          throw err;
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const describe = (c: Combination) => ({ year: c.year, period_id: c.periodId, period: periodLabel(c) });
  const label = (c: Combination) => (periods.length === 1 || !c.period ? String(c.year) : `${c.year} ${c.period}`);
  const executed: Record<string, unknown>[] = [];
  const empty: Record<string, unknown>[] = [];
  const pending: Record<string, unknown>[] = [];
  const groups: { label: string; rows: DecodedRow[] }[] = [];
  combos.forEach((c, i) => {
    const o = outcomes[i];
    if (o.status === "ok") {
      executed.push({ ...describe(c), rows: o.rows.length });
      groups.push({ label: label(c), rows: o.rows.map(decode) });
    } else if (o.status === "empty") empty.push({ ...describe(c), reason: o.reason });
    else pending.push({ ...describe(c), reason: o.reason });
  });

  if (rateError && executed.length === 0 && empty.length === 0) throw rateError;
  const truncated = pending.length > 0 || keptRows > MAX_COMPLETE_ROWS;
  if (keptRows > MAX_COMPLETE_ROWS) {
    if (format === "wide") {
      throw new ToolError("TOO_LARGE", `The selection has more than ${MAX_COMPLETE_ROWS} rows after filtering.`, {
        hint: "Narrow it with levels, position_ids, fewer years or fewer periods, or use format json/csv.",
      });
    }
    // For json/csv, return what we have with truncated=true and a hint instead of throwing.
  }

  let outputGroups: Group[] = groups;
  let aggregation: Record<string, unknown> | undefined;
  if (aggregate) {
    const ranks = new Map(periods.map((p) => [p.period || String(p.periodId), periodRank(p.period, p.periodId)]));
    const result = aggregateByYear(
      groups.flatMap((g) => g.rows),
      dimensions,
      aggregate,
      periods.length,
      (r) => ranks.get(r.period) ?? 0,
      rounding,
    );
    outputGroups = [...new Set(result.rows.map((r) => r.year))].map((year) => ({
      label: String(year),
      rows: result.rows.filter((r) => r.year === year),
    }));
    aggregation = {
      fn: aggregate.fn,
      window: "year",
      periods_expected_per_year: periods.length,
      allow_partial: aggregate.allowPartial,
      incomplete_groups: result.incomplete,
      semantics: {
        mean: "arithmetic average of all non-null period values in the year",
        sum: "total of all non-null period values in the year",
        min: "smallest non-null period value in the year",
        max: "largest non-null period value in the year",
        first: "value of the earliest period in calendar order (by period symbol, not input order)",
        last: "value of the latest period in calendar order (by period symbol, not input order)",
      }[aggregate.fn],
      note: aggregate.allowPartial
        ? "Incomplete years are computed from the available periods; check periods_used."
        : "Years missing any period have value null; set allow_partial: true to compute them anyway.",
      ...(annualWarning ? { warning: annualWarning } : {}),
    };
  } else if (rounding.decimals !== undefined) {
    for (const g of outputGroups) {
      for (const r of g.rows) if (r.value !== null) r.value = roundValue(r.value, rounding);
    }
  }

  const core: Record<string, unknown> = {
    variable_id: variableId,
    variable_name: variable.name,
    section_id: sectionId,
    section_name: section.name,
    lang,
    selection: {
      years: [...years].sort((a, b) => a - b),
      periods: periods.map((p) => ({ period_id: p.periodId, period: p.period || p.periodName })),
      position_ids: positionIds ?? null,
      levels: levels ? [...levels] : null,
    },
    complete: pending.length === 0 && keptRows <= MAX_COMPLETE_ROWS,
    truncated,
    total_rows: pending.length === 0 ? keptRows : undefined,
    empty,
    pending,
    ...(pending.length
      ? {
        ...(retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {}),
        next_step:
          "Call get_data_series again with the same arguments" +
          (retryAfter !== undefined ? ` after ${retryAfter}s` : "") +
          ". Combinations already downloaded come from the cache and cost no DBW requests.",
      }
      : {}),
    ...(aggregation ? { aggregation } : {}),
    rounding: {
      mode: rounding.mode,
      decimals: rounding.decimals ??
        (rounding.mode === "none" ? "not rounded" : aggregate?.fn === "mean" ? "precision + 2 (2-6)" : "as published"),
    },
  };

  const revision = await sha256Hex(stableJson({ core: Object.fromEntries(Object.entries(core).filter(([k]) => k !== "pending" && k !== "complete")), groups: outputGroups.map((g) => [g.label, g.rows.length]) }));
  const storedAt = new Date().toISOString();
  const result: SeriesResult = { core, executed, dimensions, groups: outputGroups, revision, storedAt };
  if (resultKey && pending.length === 0) await ctx.cache.set(resultKey, result, DATA_TTL);
  return present(result, format, includeExecuted, false);
}
