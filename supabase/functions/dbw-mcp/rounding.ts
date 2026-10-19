import { type Args, enumArg, intArg } from "./args.ts";
import { ToolError } from "./errors.ts";

export const ROUND_MODES = ["half_up", "half_even", "none"] as const;
export type RoundMode = typeof ROUND_MODES[number];
export type Rounding = { mode: RoundMode; decimals?: number };

export function parseRounding(args: Args): Rounding {
  const mode = enumArg(args, "round", ROUND_MODES, "half_up");
  const decimals = args.decimals === undefined || args.decimals === null
    ? undefined
    : intArg(args, "decimals", { min: 0, max: 10 });
  if (mode === "none" && decimals !== undefined) {
    throw new ToolError("INVALID_ARGUMENT", '"decimals" cannot be combined with round: "none".');
  }
  return { mode, decimals };
}

// Exact decimal: value = int / 10^scale.
export type Decimal = { int: bigint; scale: number };

export function toDecimal(v: number): Decimal {
  let text = String(v);
  if (/e/i.test(text)) {
    if (Number.isInteger(v)) return { int: BigInt(v), scale: 0 };
    text = v.toFixed(20).replace(/0+$/, "");
  }
  const negative = text.startsWith("-");
  const [whole, frac = ""] = (negative ? text.slice(1) : text).split(".");
  const int = BigInt(whole + frac);
  return { int: negative ? -int : int, scale: frac.length };
}

const pow10 = (n: number) => 10n ** BigInt(n);

export function rescale(d: Decimal, scale: number): bigint {
  return d.int * pow10(scale - d.scale);
}

// Rounds the exact fraction num / den (den > 0) to `decimals` places, ties resolved by `mode`.
export function roundFraction(num: bigint, den: bigint, decimals: number, mode: Exclude<RoundMode, "none">): number {
  const negative = num < 0n;
  const scaled = (negative ? -num : num) * pow10(decimals);
  let q = scaled / den;
  const twice = (scaled % den) * 2n;
  if (twice > den || (twice === den && (mode === "half_up" || q % 2n === 1n))) q += 1n;
  const digits = q.toString().padStart(decimals + 1, "0");
  const text = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits;
  return Number(negative && q !== 0n ? `-${text}` : text);
}

export function roundValue(v: number, rounding: Rounding): number {
  if (rounding.mode === "none" || rounding.decimals === undefined) return v;
  const d = toDecimal(v);
  return roundFraction(d.int, pow10(d.scale), rounding.decimals, rounding.mode);
}
