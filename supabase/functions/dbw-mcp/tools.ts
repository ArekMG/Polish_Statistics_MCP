import {
  type Args,
  boolArg,
  enumArg,
  intArg,
  langArg,
  matchesLoosely,
  matchesQuery,
  paginate,
  strArg,
} from "./args.ts";
import {
  type Area,
  getAreas,
  getAreaVariables,
  getCatalog,
  getSectionPositions,
  type SectionPosition,
  getVariableMeta,
  TERRITORIAL_LEVELS,
} from "./catalog.ts";
import { CACHED_TOOLS, DBW_MAX_PAGE_SIZE } from "./dbw-client.ts";
import { DICTIONARY_NAMES, type DecodedRow, getDictionary, rowsToCsv, stripHtml } from "./decode.ts";
import {
  countRows,
  createDecoderFor,
  fetchDataPage,
  findCatalogVariable,
  MAX_COMPLETE_ROWS,
  parseYearRange,
  PREVIEW_ROWS,
  requestSummary,
  resolveDataRequest,
  sectionMetaList,
  type ToolContext,
  withUsage,
} from "./data.ts";
import { ToolError } from "./errors.ts";
import { AGGREGATE_FNS } from "./aggregate.ts";
import { ROUND_MODES } from "./rounding.ts";
import { getDataSeries, MAX_SERIES_COMBINATIONS, MAX_SERIES_YEARS } from "./series.ts";

export type { ToolContext } from "./data.ts";

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Args, ctx: ToolContext) => Promise<Record<string, unknown>>;
};

const lang = {
  type: "string",
  enum: ["en", "pl"],
  description:
    "Language of names and descriptions returned by DBW. Default: the lang set in the server address (e.g. ?lang=pl), otherwise en.",
};
const offset = { type: "integer", minimum: 0, default: 0, description: "Number of items to skip (pagination)." };
const limit = (def: number, max: number) => ({
  type: "integer",
  minimum: 1,
  maximum: max,
  default: def,
  description: `Maximum items to return (1-${max}).`,
});
const id = (description: string) => ({ type: "integer", minimum: 1, description });
const dataSelectors = {
  variable_id: id("Variable id (from find_variables)."),
  section_id: id("Section (cross-section) id for the variable (from list_sections_and_periods)."),
  year: { type: "integer", minimum: 1800, maximum: 2200, description: "Year, e.g. 2023." },
  period_id: id("Period id available for the section (from list_sections_and_periods)."),
};
const formatProp = (def: "json" | "csv") => ({
  type: "string",
  enum: ["json", "csv"],
  default: def,
  description: "json returns decoded row objects; csv returns one compact CSV string.",
});
const includeCodes = {
  type: "boolean",
  default: false,
  description: "Also include the raw DBW codes for each row.",
};
const dataRequired = ["variable_id", "section_id", "year", "period_id"];

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties: { ...properties, lang }, required, additionalProperties: false };
}

function areaPath(area: Area, byId: Map<number, Area>): string {
  const names = [area.name];
  const seen = new Set([area.id]);
  let parent = area.parentId === null ? undefined : byId.get(area.parentId);
  while (parent && !seen.has(parent.id)) {
    names.unshift(parent.name);
    seen.add(parent.id);
    parent = parent.parentId === null ? undefined : byId.get(parent.parentId);
  }
  return names.join(" > ");
}

function formatRows(rows: DecodedRow[], format: "json" | "csv", dimensions: string[]) {
  return format === "csv" ? { format, dimensions, csv: rowsToCsv(rows, dimensions) } : { format, dimensions, rows };
}

function cleanDeep(value: unknown): unknown {
  if (typeof value === "string") return stripHtml(value);
  if (Array.isArray(value)) return value.map(cleanDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanDeep(v)]));
  }
  return value;
}

// Exact matches first, then matches on word stems (Polish inflection), without duplicates.
function rankMatches<T>(items: T[], query: string | undefined, ...texts: ((item: T) => string)[]): T[] {
  if (!query) return items;
  const out = new Set<T>();
  for (const text of texts) for (const item of items) if (matchesQuery(text(item), query)) out.add(item);
  for (const text of texts) for (const item of items) if (matchesLoosely(text(item), query)) out.add(item);
  return [...out];
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v) => v && typeof v === "object") : [];
}

export const tools: ToolDefinition[] = [
  {
    name: "search_areas",
    title: "Search DBW subject areas",
    description:
      "Browse or search the DBW subject-area tree (domains and information scopes). Start here to discover topics. " +
      "Areas with has_variables=true can be passed to find_variables.",
    inputSchema: schema({
      query: {
        type: "string",
        description: "Words to match in the area name or its parent path (accent-insensitive, tolerant of Polish word endings).",
      },
      parent_id: id("Only return direct children of this area."),
      has_variables: { type: "boolean", description: "Only return areas that directly contain variables." },
      offset,
      limit: limit(50, 200),
    }),
    async handler(args, ctx) {
      const query = strArg(args, "query");
      const parentId = intArg(args, "parent_id", { min: 1 });
      const onlyWithVariables = args.has_variables === undefined ? undefined : boolArg(args, "has_variables", false);
      const off = intArg(args, "offset", { min: 0, default: 0 })!;
      const lim = intArg(args, "limit", { min: 1, max: 200, default: 50 })!;
      const areas = await getAreas(ctx.client, langArg(args));
      const byId = new Map(areas.map((a) => [a.id, a]));
      const candidates = areas
        .filter((a) => parentId === undefined || a.parentId === parentId)
        .filter((a) => onlyWithVariables === undefined || a.hasVariables === onlyWithVariables)
        .map((a) => ({ area: a, path: areaPath(a, byId) }));
      const matches = rankMatches(candidates, query, (c) => c.area.name, (c) => c.path);
      const page = paginate(matches, off, lim);
      return {
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        next_offset: page.next_offset,
        areas: page.items.map(({ area, path }) => ({
          area_id: area.id,
          name: area.name,
          path,
          parent_id: area.parentId,
          level: area.level,
          level_name: area.levelName,
          has_variables: area.hasVariables,
        })),
      };
    },
  },
  {
    name: "find_variables",
    title: "Find DBW variables",
    description:
      "Find statistical variables either inside an area (area_id) or by searching variable and section names across " +
      "all of DBW (query). Provide at least one of them.",
    inputSchema: schema({
      area_id: id("Area id from search_areas (must have has_variables=true)."),
      query: {
        type: "string",
        description:
          "Words to match in variable or section names (accent-insensitive; exact matches first, then matches on " +
          "word stems so e.g. 'bezrobocie' also finds 'bezrobotni').",
      },
      offset,
      limit: limit(50, 200),
    }),
    async handler(args, ctx) {
      const areaId = intArg(args, "area_id", { min: 1 });
      const query = strArg(args, "query");
      const off = intArg(args, "offset", { min: 0, default: 0 })!;
      const lim = intArg(args, "limit", { min: 1, max: 200, default: 50 })!;
      const lng = langArg(args);
      if (areaId === undefined && !query) {
        throw new ToolError("INVALID_ARGUMENT", 'Provide "area_id", "query", or both.', {
          hint: "Use search_areas to find an area id, or pass a search phrase as query.",
        });
      }
      let variables: Record<string, unknown>[];
      if (areaId !== undefined) {
        variables = rankMatches(await getAreaVariables(ctx.client, areaId, lng), query, (v) => v.name);
      } else {
        const catalog = await getCatalog(ctx.client, ctx.cache, lng);
        variables = rankMatches(
          catalog,
          query,
          (v) => v.name,
          (v) => `${v.name} ${v.sections.map((s) => s.name).join(" ")}`,
        ).map((v) => ({ variable_id: v.id, name: v.name, section_count: v.sections.length }));
      }
      const page = paginate(variables, off, lim);
      return { total: page.total, offset: page.offset, limit: page.limit, next_offset: page.next_offset, variables: page.items };
    },
  },
  {
    name: "get_variable_metadata",
    title: "Get variable metadata",
    description:
      "Full metadata for a variable: definitions, methodological notes, sections with time coverage and last update, " +
      "source surveys, datasets and responsible units. HTML is converted to plain text.",
    inputSchema: schema({
      variable_id: dataSelectors.variable_id,
      include_definitions: {
        type: "boolean",
        default: true,
        description: "Include long concept definitions and methodological notes.",
      },
    }, ["variable_id"]),
    async handler(args, ctx) {
      const variableId = intArg(args, "variable_id", { required: true, min: 1 });
      const withDefinitions = boolArg(args, "include_definitions", true);
      const meta = await getVariableMeta(ctx.client, variableId, langArg(args));
      return {
        variable_id: meta["id-zmienna"] ?? variableId,
        name: meta.nazwa,
        short_name: meta["nazwa-skrocona"],
        tags: list(meta.tagi).map((t) => t["nazwa-tag"]),
        concepts: list(meta.pojecia).map((c) => ({
          name: c["nazwa-pojecie"],
          ...(withDefinitions
            ? { definition: stripHtml(String(c.definicja ?? "")), remarks: stripHtml(String(c.uwagi ?? "")) }
            : {}),
        })),
        ...(withDefinitions ? { methodology: cleanDeep(meta["wyjasnienia-metodologiczne"] ?? null) } : {}),
        sections: sectionMetaList(meta).map((s) => ({
          section_id: s["id-przekroj"],
          name: s["nazwa-przekroj"],
          time_series: s["szereg-czasowy"],
          frequency: s["nazwa-czestotliwosc"],
          last_update: s["aktualizacja-ostatnia"],
        })),
        datasets: list(meta.zestawy).map((z) => ({
          symbol: z["symbol-zestaw"],
          name: z["nazwa-zestaw"],
          manager: z["nazwa-gestor"],
        })),
        surveys: list(meta.badania).map((b) => ({ symbol: b["symbol-badanie"], topic: b["temat-badanie"] })),
        legal_acts: cleanDeep(list(meta["akty-prawne"]).filter((a) => Object.keys(a).length > 0)),
        responsible_units: list(meta.jednostki).map((j) => j["nazwa-jednostki"]),
      };
    },
  },
  {
    name: "list_sections_and_periods",
    title: "List available sections and periods",
    description:
      "For a variable, list every section (cross-section/breakdown) with its available periods (month, quarter, " +
      "year...), frequency and covered years. Use the ids with estimate_data_size and the data tools.",
    inputSchema: schema({ variable_id: dataSelectors.variable_id }, ["variable_id"]),
    async handler(args, ctx) {
      const variableId = intArg(args, "variable_id", { required: true, min: 1 });
      const lng = langArg(args);
      const variable = await findCatalogVariable(ctx, variableId, lng);
      const meta = await getVariableMeta(ctx.client, variableId, lng);
      const sectionMeta = new Map(sectionMetaList(meta).map((s) => [s["id-przekroj"], s]));
      const periods = new Map((await getDictionary(ctx.client, "periods", lng)).map((p) => [p.id, p]));
      return {
        variable_id: variable.id,
        name: variable.name,
        sections: variable.sections.map((s) => {
          const m = sectionMeta.get(s.id);
          return {
            section_id: s.id,
            name: s.name,
            frequency: m?.["nazwa-czestotliwosc"] ?? null,
            time_series: m?.["szereg-czasowy"] ?? null,
            years: parseYearRange(m?.["szereg-czasowy"]),
            last_update: m?.["aktualizacja-ostatnia"] ?? null,
            periods: s.periodIds.map((pid) => ({
              period_id: pid,
              symbol: periods.get(pid)?.symbol ?? null,
              name: periods.get(pid)?.name ?? null,
            })),
          };
        }),
        note: "Not every year in the range is guaranteed to have data for every period; use estimate_data_size to check.",
      };
    },
  },
  {
    name: "get_section_dimensions",
    title: "Get section dimensions",
    description:
      "List the dimensions of a section (e.g. Sex, Voivodeship, Age group) and their positions (categories). " +
      "Territorial positions carry a level (poland, macroregion, voivodeship, region, subregion, county, " +
      "municipality) derived from the official unit code, plus validity dates (valid_from, valid_to, is_current). " +
      "Positions with a valid_to in the past are historical; by default only current positions are returned. " +
      "Positions are paginated; filter with dimension_id, level or query.",
    inputSchema: schema({
      section_id: dataSelectors.section_id,
      dimension_id: id("Only return positions of this dimension."),
      level: { type: "string", enum: [...TERRITORIAL_LEVELS], description: "Only return territorial positions of this level." },
      query: { type: "string", description: "Words to match in position names." },
      include_historical: { type: "boolean", default: false, description: "Include historical positions (valid_to in the past). Default: only current." },
      offset,
      limit: limit(200, 1000),
    }, ["section_id"]),
    async handler(args, ctx) {
      const sectionId = intArg(args, "section_id", { required: true, min: 1 });
      const dimensionId = intArg(args, "dimension_id", { min: 1 });
      const level = args.level === undefined ? undefined : enumArg(args, "level", TERRITORIAL_LEVELS, "poland");
      const query = strArg(args, "query");
      const includeHistorical = boolArg(args, "include_historical", false);
      const off = intArg(args, "offset", { min: 0, default: 0 })!;
      const lim = intArg(args, "limit", { min: 1, max: 1000, default: 200 })!;
      const now = new Date().toISOString();
      const isCurrent = (p: SectionPosition) => !p.validTo || p.validTo >= now;
      const positions = await getSectionPositions(ctx.client, sectionId, langArg(args));
      const dimensions = new Map<
        number,
        { dimension_id: number; name: string; position_count: number; levels?: Record<string, number> }
      >();
      for (const p of positions) {
        if (!includeHistorical && !isCurrent(p)) continue;
        const d = dimensions.get(p.dimensionId) ?? { dimension_id: p.dimensionId, name: p.dimensionName, position_count: 0 };
        d.position_count++;
        if (p.level) {
          d.levels ??= {};
          d.levels[p.level] = (d.levels[p.level] ?? 0) + 1;
        }
        dimensions.set(p.dimensionId, d);
      }
      const filtered = positions
        .filter((p) => includeHistorical || isCurrent(p))
        .filter((p) => dimensionId === undefined || p.dimensionId === dimensionId)
        .filter((p) => level === undefined || p.level === level)
        .filter((p) => matchesQuery(p.positionName, query));
      const page = paginate(filtered, off, lim);
      return {
        section_id: sectionId,
        dimensions: [...dimensions.values()].sort((a, b) => a.dimension_id - b.dimension_id),
        positions: {
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          next_offset: page.next_offset,
          items: page.items.map((p) => ({
            dimension_id: p.dimensionId,
            dimension: p.dimensionName,
            position_id: p.positionId,
            name: p.positionName,
            symbol: p.symbol,
            ...(p.level ? { level: p.level, level_name: p.level } : {}),
            ...(p.validFrom ? { valid_from: p.validFrom } : {}),
            ...(p.validTo ? { valid_to: p.validTo } : {}),
            is_current: isCurrent(p),
          })),
        },
      };
    },
  },
  {
    name: "estimate_data_size",
    title: "Estimate data size",
    description:
      "Count the rows for a variable/section/year/period selection before downloading, and report how many pages " +
      "and upstream requests a complete download needs and whether get_complete_data will accept it.",
    inputSchema: schema(dataSelectors, dataRequired),
    handler: (args, ctx) => withUsage(ctx, async (ctx) => {
      const req = await resolveDataRequest(ctx, args);
      const total = await countRows(ctx, req);
      const pages = Math.ceil(total / DBW_MAX_PAGE_SIZE);
      const allowed = total > 0 && total <= MAX_COMPLETE_ROWS;
      return {
        ...requestSummary(req),
        total_rows: total,
        max_page_size: DBW_MAX_PAGE_SIZE,
        pages_at_max_page_size: pages,
        preview_rows: Math.min(total, PREVIEW_ROWS),
        complete_retrieval: { allowed, row_limit: MAX_COMPLETE_ROWS, upstream_requests: pages },
        recommendation: total === 0
          ? "No data for this selection. Try another year or period."
          : allowed
          ? "Use preview_data to inspect, then get_complete_data (csv is most compact)."
          : `Too large for one call. Use get_data_page with page_size ${DBW_MAX_PAGE_SIZE} for pages 0-${pages - 1}.`,
      };
    }),
  },
  {
    name: "preview_data",
    title: "Preview data (first 1000 rows)",
    description:
      `Return up to the first ${PREVIEW_ROWS} decoded rows of a selection, with dimension, period, unit and ` +
      "annotation codes translated to names, plus the total row count.",
    inputSchema: schema({ ...dataSelectors, format: formatProp("json"), include_codes: includeCodes }, dataRequired),
    handler: (args, ctx) => withUsage(ctx, async (ctx) => {
      const req = await resolveDataRequest(ctx, args);
      const format = enumArg(args, "format", ["json", "csv"] as const, "json");
      const { decode, dimensions } = await createDecoderFor(ctx, req, boolArg(args, "include_codes", false));
      // One full-size page usually holds the whole selection, giving the exact total without a separate count request.
      const first = await fetchDataPage(ctx, req, 0, DBW_MAX_PAGE_SIZE);
      const total = first.pageCount === 1 ? first.rows.length : await countRows(ctx, req);
      const rows = first.rows.slice(0, PREVIEW_ROWS);
      return {
        ...requestSummary(req),
        total_rows: total,
        returned_rows: rows.length,
        truncated: total > rows.length,
        ...formatRows(rows.map(decode), format, dimensions),
      };
    }),
  },
  {
    name: "get_data_page",
    title: "Get one page of data",
    description:
      "Return one page of decoded rows. Pages are 0-based; follow next_page until it is null. " +
      `page_size up to ${DBW_MAX_PAGE_SIZE}.`,
    inputSchema: schema({
      ...dataSelectors,
      page: { type: "integer", minimum: 0, default: 0, description: "0-based page number." },
      page_size: {
        type: "integer",
        minimum: 1,
        maximum: DBW_MAX_PAGE_SIZE,
        default: 1000,
        description: `Rows per page (1-${DBW_MAX_PAGE_SIZE}).`,
      },
      format: formatProp("json"),
      include_codes: includeCodes,
    }, dataRequired),
    handler: (args, ctx) => withUsage(ctx, async (ctx) => {
      const req = await resolveDataRequest(ctx, args);
      const page = intArg(args, "page", { min: 0, max: 100000, default: 0 })!;
      const pageSize = intArg(args, "page_size", { min: 1, max: DBW_MAX_PAGE_SIZE, default: 1000 })!;
      const format = enumArg(args, "format", ["json", "csv"] as const, "json");
      const { decode, dimensions } = await createDecoderFor(ctx, req, boolArg(args, "include_codes", false));
      const { rows, pageCount } = await fetchDataPage(ctx, req, page, pageSize);
      return {
        ...requestSummary(req),
        page,
        page_size: pageSize,
        page_count: pageCount,
        next_page: page + 1 < pageCount ? page + 1 : null,
        returned_rows: rows.length,
        ...formatRows(rows.map(decode), format, dimensions),
      };
    }),
  },
  {
    name: "get_complete_data",
    title: "Get complete data",
    description:
      `Download every row of a selection in one call (up to ${MAX_COMPLETE_ROWS} rows), fetching all DBW pages ` +
      "server-side. Larger selections are refused with instructions to use get_data_page. Run estimate_data_size first.",
    inputSchema: schema({ ...dataSelectors, format: formatProp("csv"), include_codes: includeCodes }, dataRequired),
    handler: (args, ctx) => withUsage(ctx, async (ctx) => {
      const req = await resolveDataRequest(ctx, args);
      const format = enumArg(args, "format", ["json", "csv"] as const, "csv");
      const first = await fetchDataPage(ctx, req, 0, DBW_MAX_PAGE_SIZE);
      const pages = first.pageCount;
      if (pages * DBW_MAX_PAGE_SIZE > MAX_COMPLETE_ROWS) {
        const total = await countRows(ctx, req);
        if (total > MAX_COMPLETE_ROWS) {
          throw new ToolError("TOO_LARGE", `This selection has ${total} rows; the limit for one call is ${MAX_COMPLETE_ROWS}.`, {
            hint: `Use get_data_page with page_size ${DBW_MAX_PAGE_SIZE} for pages 0-${pages - 1} (csv format is most compact).`,
          });
        }
      }
      const { decode, dimensions } = await createDecoderFor(ctx, req, boolArg(args, "include_codes", false));
      const decoded: DecodedRow[] = first.rows.map(decode);
      for (let page = 1; page < pages; page++) {
        const { rows } = await fetchDataPage(ctx, req, page, DBW_MAX_PAGE_SIZE);
        for (const r of rows) decoded.push(decode(r));
      }
      return {
        ...requestSummary(req),
        total_rows: decoded.length,
        returned_rows: decoded.length,
        upstream_pages: pages,
        complete: true,
        ...formatRows(decoded, format, dimensions),
      };
    }),
  },
  {
    name: "get_data_series",
    title: "Get data for several years and periods",
    description:
      "Download a variable/section for several years and periods in one call, optionally keeping only some positions " +
      "(e.g. levels: ['voivodeship'] for the 16 voivodeships, or position_ids). DBW serves one year+period per request, " +
      "so each combination costs at least one DBW request; downloaded combinations are cached for 6 hours and then cost " +
      "nothing. The reply lists executed, empty (no data, with reason) and pending combinations. If the request budget " +
      "runs out, partial results are returned with retry_after_seconds: call again with the same arguments to finish. " +
      "format 'wide' returns one row per position with a column per year (or year+period). Use dry_run: true first to " +
      "see a year x period coverage matrix (cached / empty / outside_range / to_fetch) and the exact number of DBW " +
      "requests the call would cost, without downloading anything. aggregate {fn, window: 'year'} returns yearly " +
      "mean/sum/min/max computed on the server, or first/last (e.g. last = state at the end of the year), with " +
      "periods_used per value. include_executed: false keeps the reply short (only counts, plus empty/pending lists).",
    inputSchema: schema({
      variable_id: dataSelectors.variable_id,
      section_id: dataSelectors.section_id,
      years: {
        type: "array",
        items: { type: "integer", minimum: 1800, maximum: 2200 },
        minItems: 1,
        maxItems: MAX_SERIES_YEARS,
        description: "Years to fetch, e.g. [2020, 2021, 2022].",
      },
      period_ids: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        minItems: 1,
        maxItems: 60,
        description: "Period ids from list_sections_and_periods. Default: every period of the section.",
      },
      period_symbols: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 60,
        description: "Alternative to period_ids, e.g. ['M12'] or ['Q1','Q2'].",
      },
      levels: {
        type: "array",
        items: { type: "string", enum: [...TERRITORIAL_LEVELS] },
        minItems: 1,
        description: "Keep only territorial positions of these levels, e.g. ['voivodeship'] or ['poland','voivodeship'].",
      },
      position_ids: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        minItems: 1,
        maxItems: 1000,
        description: "Keep only these positions (from get_section_dimensions); other dimensions are not filtered.",
      },
      format: {
        type: "string",
        enum: ["json", "csv", "wide"],
        default: "json",
        description: "json rows, one csv string, or a wide table (positions x periods).",
      },
      include_codes: includeCodes,
      dry_run: {
        type: "boolean",
        default: false,
        description: "Only plan: return the coverage matrix and the DBW request cost; downloads nothing.",
      },
      force_refresh: {
        type: "boolean",
        default: false,
        description: "Skip the result cache and re-download from DBW. Useful when data may have been updated.",
      },
      max_requests: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Cap the number of DBW data requests this call can make. Combinations beyond the cap are returned as pending.",
      },
      budget_strategy: {
        type: "string",
        enum: ["partial", "strict", "wait"],
        default: "partial",
        description: '"partial" fetches what fits and returns pending for the rest; "strict" refuses with BUDGET_EXHAUSTED if estimated > remaining; "wait" is not yet implemented.',
      },
      include_executed: {
        type: "boolean",
        default: true,
        description: "List every downloaded combination. Set false to return only executed_count.",
      },
      round: {
        type: "string",
        enum: [...ROUND_MODES],
        default: "half_up",
        description: "Tie rule for rounding, computed in exact decimal arithmetic (5.425 -> 5.43 half_up, 5.42 half_even). " +
          "'none' returns unrounded floating-point results.",
      },
      decimals: {
        type: "integer",
        minimum: 0,
        maximum: 10,
        description: "Round every returned value to this many decimal places. Default: means get precision + 2 " +
          "decimals (2-6), other values are returned as published.",
      },
      aggregate: {
        type: "object",
        properties: {
          fn: { type: "string", enum: [...AGGREGATE_FNS] },
          window: { type: "string", enum: ["year"], default: "year" },
          allow_partial: {
            type: "boolean",
            default: false,
            description: "Compute years missing some periods instead of returning null.",
          },
        },
        required: ["fn"],
        additionalProperties: false,
        description: "Aggregate the selected periods into one value per year, e.g. {\"fn\": \"mean\"} or {\"fn\": \"last\"}.",
      },
    }, ["variable_id", "section_id", "years"]),
    handler: (args, ctx) => withUsage(ctx, (ctx) => getDataSeries(args, ctx)),
  },
  {
    name: "quota_status",
    title: "Check the DBW request budget",
    description:
      "Show how many DBW data requests this server can still make in each limit window, without using any. " +
      `Each uncached year+period in get_data_series (up to ${MAX_SERIES_COMBINATIONS} per call) costs at least one request.`,
    inputSchema: schema({}),
    async handler(_args, ctx) {
      const buckets = await ctx.client.quota();
      if (!buckets) {
        throw new ToolError("UPSTREAM_ERROR", "The request budget could not be read right now.", { hint: "Retry shortly." });
      }
      const cacheStats = await ctx.cache.stats();
      return {
        authenticated: ctx.client.registered,
        shared: !ctx.client.registered,
        key_source: ctx.client.keySource,
        limits: buckets,
        cached_tools_available: CACHED_TOOLS,
        cache: cacheStats,
        ...(ctx.client.registered ? {} : { upgrade_hint: "Provide a personal DBW API key (X-DBW-Key header) for a separate, larger request budget." }),
        note: ctx.client.registered
          ? "Your DBW key has its own request budget. Data already downloaded is cached for 6 hours and costs nothing."
          : "The budget is shared by everyone using this server without a personal DBW key. Data already downloaded is cached for 6 hours and costs nothing.",
      };
    },
  },
  {
    name: "get_dictionary",
    title: "Look up a DBW dictionary",
    description:
      "Look up DBW code dictionaries used when decoding data: periods, units (way of presentation / measure units), " +
      "no_value markers, confidentiality markers, flags, and years.",
    inputSchema: schema({
      name: { type: "string", enum: [...DICTIONARY_NAMES], description: "Dictionary to read." },
      query: { type: "string", description: "Words to match in entry names or symbols." },
      offset,
      limit: limit(100, 500),
    }, ["name"]),
    async handler(args, ctx) {
      if (args.name === undefined) throw new ToolError("INVALID_ARGUMENT", '"name" is required.');
      const name = enumArg(args, "name", DICTIONARY_NAMES, "periods");
      const query = strArg(args, "query");
      const off = intArg(args, "offset", { min: 0, default: 0 })!;
      const lim = intArg(args, "limit", { min: 1, max: 500, default: 100 })!;
      const entries = (await getDictionary(ctx.client, name, langArg(args)))
        .filter((e) => matchesQuery(`${e.symbol} ${e.name}`, query));
      const page = paginate(entries, off, lim);
      return {
        dictionary: name,
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        next_offset: page.next_offset,
        entries: page.items.map((e) => ({ id: e.id, symbol: e.symbol, name: e.name, ...(e.extra ?? {}) })),
      };
    },
  },
];
