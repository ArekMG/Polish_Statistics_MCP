import type { Lang } from "./dbw-client.ts";
import { ToolError } from "./errors.ts";

export type Args = Record<string, unknown>;

function invalid(message: string, hint?: string): never {
  throw new ToolError("INVALID_ARGUMENT", message, { hint });
}

type IntOptions = { min?: number; max?: number; default?: number };

export function intArg(args: Args, name: string, options: IntOptions & { required: true }): number;
export function intArg(args: Args, name: string, options?: IntOptions): number | undefined;
export function intArg(args: Args, name: string, options: IntOptions & { required?: boolean } = {}) {
  let value = args[name];
  if (value === undefined || value === null || value === "") {
    if (options.required) invalid(`"${name}" is required.`);
    return options.default;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) value = Number(value.trim());
  if (typeof value !== "number" || !Number.isInteger(value)) invalid(`"${name}" must be an integer.`);
  if (options.min !== undefined && value < options.min) invalid(`"${name}" must be at least ${options.min}.`);
  if (options.max !== undefined && value > options.max) invalid(`"${name}" must be at most ${options.max}.`);
  return value;
}

export function strArg(args: Args, name: string, maxLength = 200): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") invalid(`"${name}" must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) invalid(`"${name}" must be at most ${maxLength} characters.`);
  return trimmed || undefined;
}

export function enumArg<T extends string>(args: Args, name: string, allowed: readonly T[], fallback: T): T {
  const value = args[name];
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(`"${name}" must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function boolArg(args: Args, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") invalid(`"${name}" must be true or false.`);
  return value;
}

export function langArg(args: Args): Lang {
  return enumArg(args, "lang", ["en", "pl"] as const, "en");
}

export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/ł/g, "l").replace(/Ł/g, "L").toLowerCase();
}

// Common Polish-English synonym pairs so searching in English finds Polish DBW names and vice versa.
const SYNONYMS: Record<string, string[]> = {
  unemployment: ["bezrobocie", "bezrobotni"],
  employed: ["zatrudnieni", "pracujacy"],
  employment: ["zatrudnienie", "praca"],
  salary: ["wynagrodzenie", "placa"],
  wages: ["wynagrodzenia", "place"],
  population: ["ludnosc", "populacja"],
  industry: ["przemysl"],
  agriculture: ["rolnictwo"],
  inflation: ["inflacja"],
  prices: ["ceny", "cena"],
  gdp: ["pkb"],
  exports: ["eksport"],
  imports: ["import"],
  retail: ["handel", "detal"],
  construction: ["budownictwo"],
  tourism: ["turystyka"],
  education: ["edukacja", " szkolnictwo"],
  health: ["zdrowie"],
  energy: ["energia", "paliwa"],
  transport: ["transport"],
  environment: ["srodowisko"],
  demography: ["demografia"],
  migration: ["migracje", "migracja"],
  natural: ["ruch naturalny", "ruch"],
  births: ["urodzenia", "urodzenie"],
  deaths: ["zgony", "zgon"],
  housing: ["mieszkania", "budynki"],
};

const REVERSE_SYNONYMS: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [en, plList] of Object.entries(SYNONYMS)) {
    for (const pl of plList) {
      m.set(normalizeText(pl), en);
      m.set(normalizeText(pl).slice(0, Math.max(4, pl.length - 3)), en);
    }
  }
  return m;
})();

function expandQuery(query: string): string[] {
  const normalized = normalizeText(query);
  const words = normalized.split(/\s+/).filter(Boolean);
  const expanded = new Set<string>([normalized]);
  for (const word of words) {
    const en = SYNONYMS[word];
    if (en) for (const pl of en) {
      const np = normalizeText(pl);
      expanded.add(np);
      expanded.add(stem(np));
    }
    const reverse = REVERSE_SYNONYMS.get(word) ?? REVERSE_SYNONYMS.get(stem(word));
    if (reverse) {
      expanded.add(reverse);
      expanded.add(stem(reverse));
    }
  }
  return [...expanded];
}

export function matchesQuery(text: string, query: string | undefined): boolean {
  if (!query) return true;
  const haystack = normalizeText(text);
  return expandQuery(query).some((variant) =>
    variant.split(/\s+/).filter(Boolean).every((word) => haystack.includes(word))
  );
}

// Polish words inflect at the end (bezrobocie / bezrobotni, wynagrodzenia / wynagrodzenie), so loose matching
// compares a shortened stem of each query word.
function stem(word: string): string {
  return word.length <= 4 ? word : word.slice(0, Math.max(4, word.length - 3));
}

export function matchesLoosely(text: string, query: string | undefined): boolean {
  if (!query) return true;
  const haystack = normalizeText(text);
  return expandQuery(query).some((variant) =>
    variant.split(/\s+/).filter(Boolean).every((word) => haystack.includes(stem(word)))
  );
}

export function intListArg(args: Args, name: string, options: { min: number; max: number; maxItems: number }) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) invalid(`"${name}" must be a non-empty list of integers.`);
  if (value.length > options.maxItems) invalid(`"${name}" can have at most ${options.maxItems} items.`);
  for (const v of value) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < options.min || v > options.max) {
      invalid(`"${name}" must contain integers between ${options.min} and ${options.max}.`);
    }
  }
  return [...new Set(value as number[])];
}

export function strListArg(args: Args, name: string, maxItems: number) {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== "string" || !v.trim())) {
    invalid(`"${name}" must be a non-empty list of strings.`);
  }
  if (value.length > maxItems) invalid(`"${name}" can have at most ${maxItems} items.`);
  return [...new Set((value as string[]).map((v) => v.trim()))];
}

export function paginate<T>(items: T[], offset: number, limit: number) {
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length < items.length ? offset + page.length : null;
  return { total: items.length, offset, limit, next_offset: nextOffset, items: page };
}
