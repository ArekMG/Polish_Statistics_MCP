import { type Args, boolArg } from "./args.ts";
import type { DecodedRow } from "./decode.ts";
import { ToolError } from "./errors.ts";

export const AGGREGATE_FNS = ["mean", "sum", "min", "max"] as const;
type AggregateFn = typeof AGGREGATE_FNS[number];

export type Aggregation = { fn: AggregateFn; window: "year"; allowPartial: boolean };

export type AggregatedRow = DecodedRow & { periods_used: number; periods_expected: number; complete: boolean };

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
  if (fn === "sum") return values.reduce((a, b) => a + b, 0);
  if (fn === "min") return Math.min(...values);
  if (fn === "max") return Math.max(...values);
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function roundTo(value: number, precision: number | null): number {
  const digits = Math.min(Math.max((precision ?? 1) + 2, 2), 6);
  return Number(value.toFixed(digits));
}

// Incomplete years return null unless allow_partial, so a mean of 11 months is never mistaken for an annual figure.
export function aggregateByYear(rows: DecodedRow[], dimensions: string[], agg: Aggregation, periodsExpected: number) {
  const groups = new Map<string, DecodedRow[]>();
  for (const r of rows) {
    const key = JSON.stringify([r.year, ...dimensions.map((d) => r.dimensions[d]), r.unit]);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const out: AggregatedRow[] = [];
  let incomplete = 0;
  groups.forEach((list) => {
    const values = list.map((r) => r.value).filter((v): v is number => typeof v === "number");
    const complete = values.length === periodsExpected;
    if (!complete) incomplete++;
    const usable = values.length > 0 && (complete || agg.allowPartial);
    const first = list[0];
    out.push({
      row: out.length + 1,
      year: first.year,
      period: "",
      period_name: `${agg.fn} of ${values.length}/${periodsExpected} periods`,
      dimensions: first.dimensions,
      value: usable ? roundTo(apply(agg.fn, values), first.precision) : null,
      precision: first.precision,
      unit: first.unit,
      periods_used: values.length,
      periods_expected: periodsExpected,
      complete,
    });
  });
  return { rows: out, incomplete };
}
