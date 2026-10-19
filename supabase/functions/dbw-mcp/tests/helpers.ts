import { createDbwClient } from "../dbw-client.ts";
import { createMcpHandler } from "../server.ts";
import type { Cache, RateDecision, RateLimiter, RateRule, RateUsage } from "../store.ts";
import { tools } from "../tools.ts";

export function memoryCache(): Cache & { store: Map<string, unknown> } {
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
    set: (key: string, value: unknown) => {
      store.set(key, structuredClone(value));
      return Promise.resolve();
    },
  };
}

export function memoryLimiter(): RateLimiter & { calls: RateRule[][] } {
  const counts = new Map<string, number>();
  const calls: RateRule[][] = [];
  return {
    calls,
    consume(rules: RateRule[]): Promise<RateDecision> {
      calls.push(rules);
      for (const r of rules) {
        if ((counts.get(r.bucket) ?? 0) + 1 > r.limit) {
          return Promise.resolve({ allowed: false, bucket: r.bucket, retryAfterSeconds: r.windowSeconds });
        }
      }
      for (const r of rules) counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + 1);
      return Promise.resolve({ allowed: true });
    },
    peek(rules: RateRule[]): Promise<RateUsage[]> {
      return Promise.resolve(rules.map((r) => ({ bucket: r.bucket, hits: counts.get(r.bucket) ?? 0, resetAfterSeconds: r.windowSeconds })));
    },
  };
}

export const allowAll: RateLimiter = {
  consume: () => Promise.resolve({ allowed: true }),
  peek: (rules) => Promise.resolve(rules.map((r) => ({ bucket: r.bucket, hits: 0, resetAfterSeconds: r.windowSeconds }))),
};


const areas = [
  { id: 1, nazwa: "Prices", "id-nadrzedny-element": 727, "id-poziom": 1, "nazwa-poziom": "Domain", "czy-zmienne": false },
  { id: 7, nazwa: "Price indices", "id-nadrzedny-element": 1, "id-poziom": 2, "nazwa-poziom": "Information scope", "czy-zmienne": true },
  { id: 100, nazwa: "Industry", "id-nadrzedny-element": 727, "id-poziom": 1, "nazwa-poziom": "Domain", "czy-zmienne": true },
  { id: 200, nazwa: "Rynek pracy", "id-nadrzedny-element": 727, "id-poziom": 1, "nazwa-poziom": "Domain", "czy-zmienne": true },
];

const sectionPeriods = [
  { "id-zmienna": 1, "nazwa-zmienna": "Employed persons - LFS", "id-przekroj": 1163, "nazwa-przekroj": "Poland; Sex; Age", "id-okres": 270 },
  { "id-zmienna": 1, "nazwa-zmienna": "Employed persons - LFS", "id-przekroj": 1163, "nazwa-przekroj": "Poland; Sex; Age", "id-okres": 271 },
  { "id-zmienna": 1, "nazwa-zmienna": "Employed persons - LFS", "id-przekroj": 1164, "nazwa-przekroj": "Voivodeships; Education", "id-okres": 282 },
  { "id-zmienna": 814, "nazwa-zmienna": "Sold production of industry", "id-przekroj": 2, "nazwa-przekroj": "Poland, voivodeships", "id-okres": 282 },
  { "id-zmienna": 815, "nazwa-zmienna": "Industrial new orders", "id-przekroj": 3, "nazwa-przekroj": "Poland", "id-okres": 247 },
];

const meta = {
  "id-zmienna": 1,
  nazwa: "Employed persons - LFS",
  "nazwa-skrocona": "Employed LFS",
  tagi: [{ "id-tag": 1, "nazwa-tag": "labour market" }],
  pojecia: [{ "id-pojecie": 5, "nazwa-pojecie": "Employed", definicja: "<p>Persons who <b>worked</b> &amp; earned.</p>", uwagi: "" }],
  "wyjasnienia-metodologiczne": { notki: [{ "id-notka": 1, opis: "<p>\n\tSurvey based.</p>" }] },
  przekroje: [
    { "id-przekroj": 1163, "nazwa-przekroj": "Poland; Sex; Age", "szereg-czasowy": "2010 - 2020", "nazwa-czestotliwosc": "Quarter", "aktualizacja-ostatnia": "2024-01-01" },
    { "id-przekroj": 1164, "nazwa-przekroj": "Voivodeships; Education", "szereg-czasowy": "2015 - 2020", "nazwa-czestotliwosc": "Year", "aktualizacja-ostatnia": "2024-01-01" },
  ],
  zestawy: [{ "id-zestaw": 52, "symbol-zestaw": "BAEL", "nazwa-zestaw": "LFS", "nazwa-gestor": "Statistics Poland" }],
  badania: [{ "id-badanie": 1, "symbol-badanie": "1.23.02", "temat-badanie": "LFS" }],
  "akty-prawne": [{}],
  jednostki: [{ "id-jednostka": 1, "nazwa-jednostki": "Labour Market Department" }],
};

const positions = [
  { "id-przekroj": 1163, "id-wymiar": 1, "nazwa-wymiar": "Sex", "id-pozycja": 10, "nazwa-pozycja": "Males", symbol: "1" },
  { "id-przekroj": 1163, "id-wymiar": 1, "nazwa-wymiar": "Sex", "id-pozycja": 11, "nazwa-pozycja": "Females", symbol: "2" },
  { "id-przekroj": 1163, "id-wymiar": 1, "nazwa-wymiar": "Sex", "id-pozycja": 12, "nazwa-pozycja": "Total", symbol: "0" },
  { "id-przekroj": 1163, "id-wymiar": 2, "nazwa-wymiar": "Poland", "id-pozycja": 20, "nazwa-pozycja": "POLAND", symbol: "10" },
  { "id-przekroj": 1163, "id-wymiar": 15, "nazwa-wymiar": "Age", "id-pozycja": 40, "nazwa-pozycja": "15-24", symbol: "a" },
  { "id-przekroj": 1163, "id-wymiar": 15, "nazwa-wymiar": "Age", "id-pozycja": 41, "nazwa-pozycja": "25 and over, \"total\"", symbol: "b" },
];

const regionalPositions = [
  { "id-przekroj": 1164, "id-wymiar": 3, "nazwa-wymiar": "Territory", "id-pozycja": 30, "nazwa-pozycja": "POLAND", symbol: "10000000000000" },
  { "id-przekroj": 1164, "id-wymiar": 3, "nazwa-wymiar": "Territory", "id-pozycja": 31, "nazwa-pozycja": "MAŁOPOLSKIE", symbol: "10011200000000" },
  { "id-przekroj": 1164, "id-wymiar": 3, "nazwa-wymiar": "Territory", "id-pozycja": 32, "nazwa-pozycja": "ŚLĄSKIE", symbol: "10012400000000" },
  { "id-przekroj": 1164, "id-wymiar": 3, "nazwa-wymiar": "Territory", "id-pozycja": 33, "nazwa-pozycja": "Powiat krakowski", symbol: "10011213061000" },
  { "id-przekroj": 1164, "id-wymiar": 4, "nazwa-wymiar": "Education", "id-pozycja": 50, "nazwa-pozycja": "Total", symbol: "0" },
  { "id-przekroj": 1164, "id-wymiar": 4, "nazwa-wymiar": "Education", "id-pozycja": 51, "nazwa-pozycja": "Higher", symbol: "1" },
];

export const REGIONAL_YEARS = [2019, 2020];

function regionalRows(year: number) {
  const rows = [];
  for (const territory of [30, 31, 32, 33]) {
    for (const edu of [50, 51]) {
      rows.push({
        rownumber: rows.length + 1,
        "id-zmienna": 1,
        "id-przekroj": 1164,
        "id-wymiar-1": 3,
        "id-pozycja-1": territory,
        "id-wymiar-2": 4,
        "id-pozycja-2": edu,
        "id-okres": 282,
        "id-sposob-prezentacji-miara": 98,
        "id-daty": year,
        "id-brak-wartosci": 253,
        "id-tajnosci": 43,
        "id-flaga": 36,
        wartosc: territory * 10 + (edu - 50) + (year - 2019) * 1000,
        precyzja: 0,
      });
    }
  }
  return rows;
}

const dictionaries: Record<string, unknown[]> = {
  "periods-dictionary": [
    { "id-okres": 247, symbol: "M01", opis: "month - January", "id-czestotliwosc": 3, "nazwa-czestotliwosc": "Month" },
    { "id-okres": 270, symbol: "Q1", opis: "quarter - Q1", "id-czestotliwosc": 2, "nazwa-czestotliwosc": "Quarter" },
    { "id-okres": 271, symbol: "Q2", opis: "quarter - Q2", "id-czestotliwosc": 2, "nazwa-czestotliwosc": "Quarter" },
    { "id-okres": 282, symbol: "", opis: "year", "id-czestotliwosc": 1, "nazwa-czestotliwosc": "Year" },
  ],
  "way-of-presentation": [
    { "id-sposob-prezentacji-miara": 98, nazwa: "[thousand persons]", "oznaczenie-jednostki": "<p>thousand persons</p>", "nazwa-jednostki": "thousand persons" },
  ],
  "no-value-dictionary": [
    { "id-brak-wartosci": 38, oznaczenie: "(.)", nazwa: "data not available" },
    { "id-brak-wartosci": 253, oznaczenie: "ND", nazwa: "Not applicable" },
  ],
  "confidentionality-dictionary": [
    { "id-tajnosci": 43, oznaczenie: "nd", nazwa: "Uncovered data" },
    { "id-tajnosci": 601, oznaczenie: "(:)", nazwa: "Confidential data" },
  ],
  "flag-dictionary": [
    { "id-flaga": 29, oznaczenie: "s", nazwa: "Estimated value" },
    { "id-flaga": 36, oznaczenie: "nd", nazwa: "Not applicable" },
  ],
  "date-dictionary": [{ "id-rok": 2019 }, { "id-rok": 2020 }],
};

function dataRow(i: number) {
  return {
    rownumber: i + 1,
    "id-zmienna": 1,
    "id-przekroj": 1163,
    "id-wymiar-1": 2,
    "id-pozycja-1": 20,
    "id-wymiar-2": 1,
    "id-pozycja-2": [10, 11, 12][i % 3],
    "id-wymiar-3": 15,
    "id-pozycja-3": [40, 41][Math.floor(i / 3) % 2],
    "id-okres": 270,
    "id-sposob-prezentacji-miara": 98,
    "id-daty": 2019,
    "id-brak-wartosci": i === 0 ? 38 : 253,
    "id-tajnosci": 43,
    "id-flaga": i === 0 ? 29 : 36,
    wartosc: i === 0 ? null : 1000 + i,
    precyzja: 1,
  };
}

export type FakeDbwOptions = { dataRows?: number; failWith?: { status: number; headers?: Record<string, string> } };
export type RecordedCall = { url: URL; headers: Headers };

function page<T>(items: T[], pageNumber: number, size: number) {
  const pageCount = Math.ceil(items.length / size);
  if (pageNumber >= pageCount) return null;
  return { "page-number": pageNumber, "page-size": size, "page-count": pageCount, data: items.slice(pageNumber * size, (pageNumber + 1) * size) };
}

export function fakeDbw(options: FakeDbwOptions = {}) {
  const calls: RecordedCall[] = [];
  const dataRows = options.dataRows ?? 18;
  const notFound = () => new Response(JSON.stringify({ "error-reason": "Not Found", status: "404" }), { status: 404 });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init?.headers) });
    if (options.failWith) {
      return Promise.resolve(new Response("{}", { status: options.failWith.status, headers: options.failWith.headers }));
    }
    const path = url.pathname.replace(/^\/api\/1\.2\.0/, "");
    const q = (k: string) => url.searchParams.get(k);
    const n = (k: string) => Number(q(k));
    let body: unknown = null;

    if (path === "/area/area-area") body = areas;
    else if (path === "/area/area-variable") {
      body = n("id-obszaru") === 100
        ? [{ id: 100, nazwa: "Industry", "id-zmienna": 814, "nazwa-zmienna": "Sold production of industry" },
          { id: 100, nazwa: "Industry", "id-zmienna": 815, "nazwa-zmienna": "Industrial new orders" }]
        : null;
    } else if (path === "/variable/variable-section-periods") {
      body = page(sectionPeriods, n("numer-strony"), n("ile-na-stronie"));
    } else if (path === "/variable/variable-meta") body = n("id-zmiennej") === 1 ? meta : null;
    else if (path === "/variable/variable-section-position") {
      body = n("id-przekroj") === 1163 ? positions : n("id-przekroj") === 1164 ? regionalPositions : null;
    } else if (path === "/variable/variable-data-section" && n("id-przekroj") === 1164) {
      const match = n("id-zmienna") === 1 && REGIONAL_YEARS.includes(n("id-rok")) && n("id-okres") === 282;
      body = match ? page(regionalRows(n("id-rok")), n("numer-strony"), n("ile-na-stronie")) : null;
    } else if (path === "/variable/variable-data-section") {
      const match = n("id-zmienna") === 1 && n("id-przekroj") === 1163 && n("id-rok") === 2019 && n("id-okres") === 270;
      const size = n("ile-na-stronie");
      body = match && size <= 5000
        ? page(Array.from({ length: dataRows }, (_, i) => dataRow(i)), n("numer-strony"), size)
        : null;
    } else if (path.startsWith("/dictionaries/")) {
      const items = dictionaries[path.slice("/dictionaries/".length)];
      body = items ? page(items, n("page"), n("page-size")) : null;
    }
    return Promise.resolve(body === null ? notFound() : ok(body));
  }) as typeof fetch;

  return { fetchImpl, calls };
}

export function setup(
  options: FakeDbwOptions & { apiKey?: string; accessToken?: string; limiter?: RateLimiter; dbwLimiter?: RateLimiter } = {},
) {
  const dbw = fakeDbw(options);
  const cache = memoryCache();
  const client = createDbwClient({
    apiKey: options.apiKey,
    limiter: options.dbwLimiter ?? allowAll,
    cache,
    fetchImpl: dbw.fetchImpl,
    sleep: () => Promise.resolve(),
  });
  const handler = createMcpHandler({
    tools,
    context: { client, cache },
    limiter: options.limiter ?? allowAll,
    accessToken: options.accessToken,
  });
  let nextId = 1;

  async function rpc(method: string, params?: unknown, headers: Record<string, string> = {}) {
    const res = await handler(new Request("http://localhost/dbw-mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
    }));
    return { status: res.status, headers: res.headers, body: await res.json() };
  }

  async function call(name: string, args: Record<string, unknown> = {}) {
    const { body } = await rpc("tools/call", { name, arguments: args });
    if (body.error) throw new Error(`JSON-RPC error: ${JSON.stringify(body.error)}`);
    return body.result as { isError?: boolean; structuredContent: Record<string, any>; content: { text: string }[] };
  }

  return { handler, rpc, call, dbw, cache };
}

export const DATA_ARGS = { variable_id: 1, section_id: 1163, year: 2019, period_id: 270 };
