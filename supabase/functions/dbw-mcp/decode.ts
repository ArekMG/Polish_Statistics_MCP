import { DBW_MAX_PAGE_SIZE, type DbwClient, type DbwPage, type Lang } from "./dbw-client.ts";
import { ToolError } from "./errors.ts";
import type { SectionPosition } from "./catalog.ts";

const DAY = 86400;

export const DICTIONARY_NAMES = ["periods", "units", "no_value", "confidentiality", "flags", "years"] as const;
export type DictionaryName = typeof DICTIONARY_NAMES[number];

const DICTIONARY_PATHS: Record<DictionaryName, string> = {
  periods: "/dictionaries/periods-dictionary",
  units: "/dictionaries/way-of-presentation",
  no_value: "/dictionaries/no-value-dictionary",
  confidentiality: "/dictionaries/confidentionality-dictionary",
  flags: "/dictionaries/flag-dictionary",
  years: "/dictionaries/date-dictionary",
};

export type DictEntry = { id: number; symbol: string; name: string; extra?: Record<string, unknown> };

type Raw = Record<string, unknown>;

function normalize(name: DictionaryName, r: Raw): DictEntry {
  switch (name) {
    case "periods":
      return {
        id: Number(r["id-okres"]),
        symbol: String(r.symbol ?? ""),
        name: String(r.opis ?? ""),
        extra: { frequency: r["nazwa-czestotliwosc"], frequency_id: r["id-czestotliwosc"], type: r["nazwa-typ"] },
      };
    case "units":
      return {
        id: Number(r["id-sposob-prezentacji-miara"]),
        symbol: stripHtml(String(r["oznaczenie-jednostki"] ?? "")),
        name: String(r.nazwa ?? ""),
        extra: { presentation: r["nazwa-sposob-prezentacji"], unit_name: r["nazwa-jednostki"] },
      };
    case "no_value":
      return { id: Number(r["id-brak-wartosci"]), symbol: String(r.oznaczenie ?? ""), name: String(r.nazwa ?? "") };
    case "confidentiality":
      return { id: Number(r["id-tajnosci"]), symbol: String(r.oznaczenie ?? ""), name: String(r.nazwa ?? "") };
    case "flags":
      return { id: Number(r["id-flaga"]), symbol: String(r.oznaczenie ?? ""), name: String(r.nazwa ?? "") };
    case "years":
      return { id: Number(r["id-rok"]), symbol: String(r["id-rok"]), name: String(r["id-rok"]) };
  }
}

export async function getDictionary(client: DbwClient, name: DictionaryName, lang: Lang): Promise<DictEntry[]> {
  const path = DICTIONARY_PATHS[name];
  const rows: Raw[] = [];
  let pageCount = 1;
  for (let page = 0; page < pageCount; page++) {
    const res = await client.get<DbwPage<Raw>>(path, { "page-size": DBW_MAX_PAGE_SIZE, page }, lang, {
      cacheTtlSeconds: DAY,
    });
    if (!res || !Array.isArray(res.data)) throw new ToolError("UPSTREAM_ERROR", `DBW returned an unexpected ${name} dictionary.`);
    rows.push(...res.data);
    pageCount = res["page-count"] ?? 1;
  }
  return rows.map((r) => normalize(name, r));
}

export type Dictionaries = Record<Exclude<DictionaryName, "years">, Map<number, DictEntry>>;

export async function getDecodingDictionaries(client: DbwClient, lang: Lang): Promise<Dictionaries> {
  const names = ["periods", "units", "no_value", "confidentiality", "flags"] as const;
  const out = {} as Dictionaries;
  for (const name of names) {
    out[name] = new Map((await getDictionary(client, name, lang)).map((e) => [e.id, e]));
  }
  return out;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|div|h\d)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type RawDataRow = Record<string, number | string | null>;

export type DecodedRow = {
  row: number;
  year: number;
  period: string;
  period_name: string;
  dimensions: Record<string, string>;
  value: number | null;
  precision: number | null;
  unit: string;
  no_value?: string;
  confidentiality?: string;
  flag?: string;
  codes?: Record<string, number | string | null>;
};

// DBW marks "nothing special" with an ND/nd code; those are omitted so only meaningful annotations remain.
function annotation(dict: Map<number, DictEntry>, id: unknown): string | undefined {
  if (id === null || id === undefined) return undefined;
  const entry = dict.get(Number(id));
  if (!entry) return `unknown code ${id}`;
  if (entry.symbol.toLowerCase() === "nd") return undefined;
  return `${entry.symbol} ${entry.name}`.trim();
}

function dimensionLabels(positions: SectionPosition[]): Map<number, string> {
  const labels = new Map<number, string>();
  const used = new Set<string>();
  for (const p of [...positions].sort((a, b) => a.dimensionId - b.dimensionId)) {
    if (labels.has(p.dimensionId)) continue;
    const label = used.has(p.dimensionName) ? `${p.dimensionName} (${p.dimensionId})` : p.dimensionName;
    used.add(label);
    labels.set(p.dimensionId, label);
  }
  return labels;
}

export function dimensionOrder(positions: SectionPosition[]): string[] {
  return [...dimensionLabels(positions).values()];
}

export function createRowDecoder(dicts: Dictionaries, positions: SectionPosition[], includeCodes = false) {
  const dimensionNames = dimensionLabels(positions);
  const positionNames = new Map<number, string>();
  for (const p of positions) positionNames.set(p.positionId, p.positionName);

  return (raw: RawDataRow): DecodedRow => {
    const dimensions: Record<string, string> = {};
    for (let n = 1; raw[`id-wymiar-${n}`] !== undefined; n++) {
      const dimId = Number(raw[`id-wymiar-${n}`]);
      const posId = Number(raw[`id-pozycja-${n}`]);
      const dimName = dimensionNames.get(dimId) ?? `dimension ${dimId}`;
      dimensions[dimName] = positionNames.get(posId) ?? `position ${posId}`;
    }
    const period = dicts.periods.get(Number(raw["id-okres"]));
    const unit = dicts.units.get(Number(raw["id-sposob-prezentacji-miara"]));
    const row: DecodedRow = {
      row: Number(raw.rownumber),
      year: Number(raw["id-daty"]),
      period: period?.symbol || String(raw["id-okres"]),
      period_name: period?.name ?? `period ${raw["id-okres"]}`,
      dimensions,
      value: raw.wartosc === null || raw.wartosc === undefined ? null : Number(raw.wartosc),
      precision: raw.precyzja === null || raw.precyzja === undefined ? null : Number(raw.precyzja),
      unit: unit?.name ?? `unit ${raw["id-sposob-prezentacji-miara"]}`,
    };
    const noValue = annotation(dicts.no_value, raw["id-brak-wartosci"]);
    const confidentiality = annotation(dicts.confidentiality, raw["id-tajnosci"]);
    const flag = annotation(dicts.flags, raw["id-flaga"]);
    if (noValue) row.no_value = noValue;
    if (confidentiality) row.confidentiality = confidentiality;
    if (flag) row.flag = flag;
    if (includeCodes) row.codes = { ...raw };
    return row;
  };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: DecodedRow[], dimensionOrder: string[]): string {
  const header = ["year", "period", ...dimensionOrder, "value", "precision", "unit", "no_value", "confidentiality", "flag"];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push([
      r.year,
      r.period,
      ...dimensionOrder.map((d) => r.dimensions[d]),
      r.value,
      r.precision,
      r.unit,
      r.no_value,
      r.confidentiality,
      r.flag,
    ].map(csvCell).join(","));
  }
  return lines.join("\n");
}
