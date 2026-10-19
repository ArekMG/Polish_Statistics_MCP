import { type Args, boolArg } from "./args.ts";
import type { DecodedRow } from "./decode.ts";
import { ToolError } from "./errors.ts";

export const AGGREGATE_FNS = ["mean", "sum", "min", "max", "first", "last"] as const;
type AggregateFn = typeof AGGREGATE_FNS[number];

export type Aggregation = { fn: AggregateFn; window: "year"; allowPartial: boolean };

export type AggregatedRow = DecodedRow & {
  periods_used: number;
  periods_expected: number;
  complete: boolean;
  source_period?: string;
};

// DBW period ids are not chronological across period families, so order by the month a period ends in.
export function periodRank(symbol: string, id: number): number {
  const m = /^(M|Q|K|P)(\d{1,2})$/i.exec(symbol);
  const monthEnd = !m ? 13 : m[1].toUpperCase() === "M" ? Number(m[2]) : m[1].toUpperCase() === "P" ? Number(m[2]) * 6 : Number(m[2]) * 3;
  return monthEnd * 1_000_000 + id;
}

export function parseAggregate(args: Args): Aggregation | undefined {
  const raw = args.aggregate;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ToolError("INVALID_ARGUMENT", '"aggregate" must be an object, e.g. {"fn": "mean", "window": "year"}.');
  }
  const obj = raw as Args;
  const fn = obj.fn;
  if (typeof fn !== "string" || !(AGGREGATE_FNS as readonly string[]).includes(fn)) {
    throw new ToolError("INVALID_ARGUMENT", `"aggregate.fn" must be one of: ${AGGREGATE_FNS.join(", ")}.`);
  }
  if (obj.window !== undefined && obj.window !== "year") {
    throw new ToolError("INVALID_ARGUMENT", '"aggregate.window" supports only "year".');
  }
  return { fn: fn as AggregateFn, window: "year", allowPartial: boolArg(obj, "allow_partial", false) };
}

function apply(fn: AggregateFn, values: number[]): number {
  if (fn === "first") return values[0];
  if (fn === "last") return values[values.length - 1];
  if (fn === "sum") return values.reduce((a, b) => a + b, 0);
  if (fn === "min") return Math.min(...values);
  if (fn === "max") return Math.max(...values);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function roundTo(fn: AggregateFn, value: number, precision: number | null): number {
  if (fn !== "mean") return value;
  const digits = Math.min(Math.max((precision ?? 1) + 2, 2), 6);
  return Number(value.toFixed(digits));
}

// Incomplete years return null unless allow_partial, so a mean of 11 months is never mistaken for an annual figure.
export function aggregateByYear(
  rows: DecodedRow[],
  dimensions: string[],
  agg: Aggregation,
  periodsExpected: number,
  rank: (row: DecodedRow) => number,
) {
  const groups = new Map<string, DecodedRow[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.year, ...dimensions.map((d) => r.dimensions[d]), r.unit]);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: AggregatedRow[] = [];
  let incomplete = 0;
  groups.forEach((unsorted) => {
    const list = [...unsorted].sort((a, b) => rank(a) - rank(b));
    const withValues = list.filter((r): r is DecodedRow & { value: number } => typeof r.value === "number");
    const values = withValues.map((r) => r.value);
    const complete = values.length === periodsExpected;
    if (!complete) incomplete++;
    const usable = values.length > 0 && (complete || agg.allowPartial);
    const first = list[0];
    const source = agg.fn === "first" ? withValues[0] : agg.fn === "last" ? withValues.at(-1) : undefined;
    out.push({
      row: out.length + 1,
      year: first.year,
      period: "",
      period_name: `${agg.fn} of ${values.length}/${periodsExpected} periods`,
      dimensions: first.dimensions,
      value: usable ? roundTo(agg.fn, apply(agg.fn, values), first.precision) : null,
      precision: first.precision,
      unit: first.unit,
      periods_used: values.length,
      periods_expected: periodsExpected,
      complete,
      ...(source && usable ? { source_period: source.period || source.period_name } : {}),
    });
  });
  return { rows: out, incomplete };
}
