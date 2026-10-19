import { DBW_MAX_PAGE_SIZE, type DbwClient, type DbwPage, type Lang } from "./dbw-client.ts";
import { isToolError, ToolError } from "./errors.ts";
import type { Cache } from "./store.ts";

const DAY = 86400;
const CATALOG_TTL = 12 * 3600;

export type Area = {
  id: number;
  name: string;
  parentId: number | null;
  level: number;
  levelName: string;
  hasVariables: boolean;
};

export type CatalogSection = { id: number; name: string; periodIds: number[] };
export type CatalogVariable = { id: number; name: string; sections: CatalogSection[] };

export type SectionPosition = {
  dimensionId: number;
  dimensionName: string;
  positionId: number;
  positionName: string;
  symbol: string;
  validFrom: string | null;
  validTo: string | null;
};

type RawArea = {
  id: number;
  nazwa: string;
  "id-nadrzedny-element": number | null;
  "id-poziom": number;
  "nazwa-poziom": string;
  "czy-zmienne": boolean;
};

type RawAreaVariable = { id: number; nazwa: string; "id-zmienna": number; "nazwa-zmienna": string };

type RawSectionPeriod = {
  "id-zmienna": number;
  "nazwa-zmienna": string;
  "id-przekroj": number;
  "nazwa-przekroj": string;
  "id-okres": number;
};

type RawPosition = {
  "id-wymiar": number;
  "nazwa-wymiar": string;
  "id-pozycja": number;
  "nazwa-pozycja": string;
  symbol: string;
  "data-poczatku"?: string;
  "data-konca"?: string;
};

export async function getAreas(client: DbwClient, lang: Lang): Promise<Area[]> {
  const raw = await client.get<RawArea[]>("/area/area-area", {}, lang, { cacheTtlSeconds: DAY });
  if (!Array.isArray(raw)) throw new ToolError("UPSTREAM_ERROR", "DBW returned an unexpected area list.");
  return raw.map((a) => ({
    id: a.id,
    name: a.nazwa,
    parentId: a["id-nadrzedny-element"] ?? null,
    level: a["id-poziom"],
    levelName: a["nazwa-poziom"],
    hasVariables: Boolean(a["czy-zmienne"]),
  }));
}

export async function getAreaVariables(client: DbwClient, areaId: number, lang: Lang) {
  let raw: RawAreaVariable[];
  try {
    raw = await client.get<RawAreaVariable[]>("/area/area-variable", { "id-obszaru": areaId }, lang, {
      cacheTtlSeconds: DAY,
    });
  } catch (err) {
    if (isToolError(err, "NOT_FOUND")) {
      throw new ToolError("NOT_FOUND", `Area ${areaId} has no variables attached directly.`, {
        hint: "Use search_areas with parent_id to find child areas where has_variables is true.",
      });
    }
    throw err;
  }
  if (!Array.isArray(raw)) throw new ToolError("UPSTREAM_ERROR", "DBW returned an unexpected variable list.");
  return raw.map((v) => ({ variable_id: v["id-zmienna"], name: v["nazwa-zmienna"], area_id: v.id, area_name: v.nazwa }));
}

async function fetchSectionPeriodPage(client: DbwClient, page: number, lang: Lang) {
  const res = await client.get<DbwPage<RawSectionPeriod>>(
    "/variable/variable-section-periods",
    { "ile-na-stronie": DBW_MAX_PAGE_SIZE, "numer-strony": page },
    lang,
  );
  if (!res || !Array.isArray(res.data)) {
    throw new ToolError("UPSTREAM_ERROR", "DBW returned an unexpected variable/section/period list.");
  }
  return res;
}

export function buildCatalog(rows: RawSectionPeriod[]): CatalogVariable[] {
  const vars = new Map<number, { id: number; name: string; sections: Map<number, CatalogSection> }>();
  for (const r of rows) {
    let v = vars.get(r["id-zmienna"]);
    if (!v) {
      v = { id: r["id-zmienna"], name: r["nazwa-zmienna"], sections: new Map() };
      vars.set(v.id, v);
    }
    let s = v.sections.get(r["id-przekroj"]);
    if (!s) {
      s = { id: r["id-przekroj"], name: r["nazwa-przekroj"], periodIds: [] };
      v.sections.set(s.id, s);
    }
    if (!s.periodIds.includes(r["id-okres"])) s.periodIds.push(r["id-okres"]);
  }
  return [...vars.values()]
    .map((v) => ({ id: v.id, name: v.name, sections: [...v.sections.values()] }))
    .sort((a, b) => a.id - b.id);
}

// The full variable -> section -> period list is only exposed as one paged list, so it is fetched once and cached.
export async function getCatalog(client: DbwClient, cache: Cache, lang: Lang): Promise<CatalogVariable[]> {
  const key = `catalog|${lang}`;
  const stored = await cache.get<CatalogVariable[]>(key);
  if (stored) return stored;
  const first = await fetchSectionPeriodPage(client, 0, lang);
  const rows = [...first.data];
  for (let page = 1; page < first["page-count"]; page++) {
    rows.push(...(await fetchSectionPeriodPage(client, page, lang)).data);
  }
  const catalog = buildCatalog(rows);
  await cache.set(key, catalog, CATALOG_TTL);
  return catalog;
}

export async function getVariableMeta(client: DbwClient, variableId: number, lang: Lang) {
  try {
    const meta = await client.get<Record<string, unknown>>(
      "/variable/variable-meta",
      { "id-zmiennej": variableId },
      lang,
      { cacheTtlSeconds: DAY },
    );
    if (!meta || typeof meta !== "object") throw new ToolError("UPSTREAM_ERROR", "DBW returned unexpected metadata.");
    return meta;
  } catch (err) {
    if (isToolError(err, "NOT_FOUND")) {
      throw new ToolError("NOT_FOUND", `Variable ${variableId} does not exist in DBW.`, {
        hint: "Use find_variables to look up valid variable ids.",
      });
    }
    throw err;
  }
}

export async function getSectionPositions(client: DbwClient, sectionId: number, lang: Lang): Promise<SectionPosition[]> {
  let raw: RawPosition[];
  try {
    raw = await client.get<RawPosition[]>("/variable/variable-section-position", { "id-przekroj": sectionId }, lang, {
      cacheTtlSeconds: DAY,
    });
  } catch (err) {
    if (isToolError(err, "NOT_FOUND")) {
      throw new ToolError("NOT_FOUND", `Section ${sectionId} does not exist in DBW.`, {
        hint: "Use list_sections_and_periods to find valid section ids for a variable.",
      });
    }
    throw err;
  }
  if (!Array.isArray(raw)) throw new ToolError("UPSTREAM_ERROR", "DBW returned unexpected section positions.");
  return raw.map((p) => ({
    dimensionId: p["id-wymiar"],
    dimensionName: p["nazwa-wymiar"],
    positionId: p["id-pozycja"],
    positionName: p["nazwa-pozycja"],
    symbol: p.symbol,
    validFrom: p["data-poczatku"] ?? null,
    validTo: p["data-konca"] ?? null,
  }));
}
