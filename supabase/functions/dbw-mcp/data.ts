import { type Args, intArg, langArg } from "./args.ts";
import {
  type CatalogSection,
  type CatalogVariable,
  getCatalog,
  getSectionPositions,
  getVariableMeta,
} from "./catalog.ts";
import type { DbwClient, DbwPage, Lang } from "./dbw-client.ts";
import { createRowDecoder, dimensionOrder, getDecodingDictionaries, getDictionary, type RawDataRow } from "./decode.ts";
import { isToolError, ToolError } from "./errors.ts";
import type { Cache } from "./store.ts";

export type ToolContext = { client: DbwClient; cache: Cache };

export const PREVIEW_ROWS = 1000;
export const MAX_COMPLETE_ROWS = 20000;
const COUNT_TTL = 3600;

export type DataRequest = {
  variableId: number;
  variableName: string;
  sectionId: number;
  sectionName: string;
  year: number;
  periodId: number;
  lang: Lang;
};

export type SectionMeta = {
  "id-przekroj": number;
  "nazwa-przekroj"?: string;
  "szereg-czasowy"?: string;
  "nazwa-czestotliwosc"?: string;
  "aktualizacja-ostatnia"?: string;
};

export function parseYearRange(series: string | undefined): { from: number; to: number } | null {
  const years = series?.match(/\d{4}/g)?.map(Number);
  if (!years || years.length === 0) return null;
  return { from: years[0], to: years[years.length - 1] };
}

export function sectionMetaList(meta: Record<string, unknown>): SectionMeta[] {
  return Array.isArray(meta.przekroje) ? meta.przekroje as SectionMeta[] : [];
}

export async function findCatalogVariable(ctx: ToolContext, variableId: number, lang: Lang): Promise<CatalogVariable> {
  const variable = (await getCatalog(ctx.client, ctx.cache, lang)).find((v) => v.id === variableId);
  if (!variable) {
    throw new ToolError("NOT_FOUND", `Variable ${variableId} has no published data sections in DBW.`, {
      hint: "Use find_variables to look up variables that have data.",
    });
  }
  return variable;
}

function describeSections(sections: CatalogSection[]) {
  const listed = sections.slice(0, 25).map((s) => `${s.id} (${s.name})`).join("; ");
  return sections.length > 25 ? `${listed}; and ${sections.length - 25} more` : listed;
}

export async function resolveDataRequest(ctx: ToolContext, args: Args): Promise<DataRequest> {
  const variableId = intArg(args, "variable_id", { required: true, min: 1 });
  const sectionId = intArg(args, "section_id", { required: true, min: 1 });
  const year = intArg(args, "year", { required: true, min: 1800, max: 2200 });
  const periodId = intArg(args, "period_id", { required: true, min: 1 });
  const lang = langArg(args);

  const variable = await findCatalogVariable(ctx, variableId, lang);
  const section = variable.sections.find((s) => s.id === sectionId);
  if (!section) {
    throw new ToolError("NOT_FOUND", `Section ${sectionId} is not available for variable ${variableId}.`, {
      hint: `Available sections: ${describeSections(variable.sections)}.`,
    });
  }
  if (!section.periodIds.includes(periodId)) {
    const periods = new Map((await getDictionary(ctx.client, "periods", lang)).map((p) => [p.id, p]));
    const available = section.periodIds
      .map((id) => `${id} (${periods.get(id)?.name || periods.get(id)?.symbol || "unknown"})`)
      .join("; ");
    throw new ToolError("NOT_FOUND", `Period ${periodId} is not available for variable ${variableId}, section ${sectionId}.`, {
      hint: `Available periods: ${available}.`,
    });
  }

  const meta = await getVariableMeta(ctx.client, variableId, lang);
  const range = parseYearRange(sectionMetaList(meta).find((s) => s["id-przekroj"] === sectionId)?.["szereg-czasowy"]);
  if (range && (year < range.from || year > range.to)) {
    throw new ToolError("NO_DATA", `Year ${year} is outside the published time series for this section.`, {
      hint: `Section ${sectionId} covers ${range.from}-${range.to}.`,
    });
  }

  return {
    variableId,
    variableName: variable.name,
    sectionId,
    sectionName: section.name,
    year,
    periodId,
    lang,
  };
}

function dataParams(req: DataRequest, page: number, pageSize: number) {
  return {
    "id-zmienna": req.variableId,
    "id-przekroj": req.sectionId,
    "id-rok": req.year,
    "id-okres": req.periodId,
    "ile-na-stronie": pageSize,
    "numer-strony": page,
  };
}

function noData(req: DataRequest) {
  return new ToolError(
    "NO_DATA",
    `DBW has no data for variable ${req.variableId}, section ${req.sectionId}, year ${req.year}, period ${req.periodId}.`,
    { hint: "Try another year or period from list_sections_and_periods." },
  );
}

export async function countRows(ctx: ToolContext, req: DataRequest): Promise<number> {
  try {
    const res = await ctx.client.get<DbwPage<RawDataRow>>(
      "/variable/variable-data-section",
      dataParams(req, 0, 1),
      req.lang,
      { cacheTtlSeconds: COUNT_TTL },
    );
    if (!res || typeof res["page-count"] !== "number") {
      throw new ToolError("UPSTREAM_ERROR", "DBW returned an unexpected data page.");
    }
    return res["page-count"];
  } catch (err) {
    if (isToolError(err, "NOT_FOUND")) return 0;
    throw err;
  }
}

export async function fetchDataPage(ctx: ToolContext, req: DataRequest, page: number, pageSize: number) {
  try {
    const res = await ctx.client.get<DbwPage<RawDataRow>>(
      "/variable/variable-data-section",
      dataParams(req, page, pageSize),
      req.lang,
    );
    if (!res || !Array.isArray(res.data) || typeof res["page-count"] !== "number") {
      throw new ToolError("UPSTREAM_ERROR", "DBW returned an unexpected data page.");
    }
    return { rows: res.data, pageCount: res["page-count"] };
  } catch (err) {
    if (!isToolError(err, "NOT_FOUND")) throw err;
    if (page === 0) throw noData(req);
    const total = await countRows(ctx, req);
    if (total === 0) throw noData(req);
    const lastPage = Math.ceil(total / pageSize) - 1;
    throw new ToolError("PAGE_OUT_OF_RANGE", `Page ${page} does not exist at page_size ${pageSize}.`, {
      hint: `There are ${total} rows; valid pages are 0-${lastPage}.`,
    });
  }
}

export async function createDecoderFor(ctx: ToolContext, req: DataRequest, includeCodes: boolean) {
  const dicts = await getDecodingDictionaries(ctx.client, req.lang);
  const positions = await getSectionPositions(ctx.client, req.sectionId, req.lang);
  return { decode: createRowDecoder(dicts, positions, includeCodes), dimensions: dimensionOrder(positions) };
}

export function requestSummary(req: DataRequest) {
  return {
    variable_id: req.variableId,
    variable_name: req.variableName,
    section_id: req.sectionId,
    section_name: req.sectionName,
    year: req.year,
    period_id: req.periodId,
    lang: req.lang,
  };
}
