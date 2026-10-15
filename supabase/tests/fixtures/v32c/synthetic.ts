// Deterministic SYNTHETIC 1H bars for the V3.2c parity tests. Not market data: no provider candles are committed.
//
// A seeded integer PRNG (mulberry32) drives a regime-switching random walk: drift segments of random length and sign
// with noise, so the frozen engine meets seeds, ≥ 50% corrections, continuations (BOS), pending confirmations, protected
// swing changes and flips on D / 4H / 1H. Only + − × ÷ and Math.round are used, so the series is bit-identical on every
// platform. Bars exist only in FX-open hours (frozen fxOpen); a few hours are deliberately removed so the frozen
// aggregation must skip incomplete Daily / 4H buckets. The span covers both 2025 US DST transitions.
import { fxOpen } from "../../../functions/_shared/structure/v32c/timeframes.ts";

export type H1 = { t: number; o: number; h: number; l: number; c: number };

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SYNTHETIC_SPAN = { start: Date.parse("2025-01-05T22:00:00Z"), end: Date.parse("2025-12-05T22:00:00Z") };

/** Hours removed on purpose (UTC): each makes its Daily and 4H bucket incomplete → skipped by the frozen aggregation. */
export const SYNTHETIC_HOLES = [
  Date.parse("2025-04-06T21:00:00Z"), Date.parse("2025-04-06T22:00:00Z"), // Sunday 17:00–19:00 NY (EDT), like the 2025 provider gap
  Date.parse("2025-06-18T14:00:00Z"), // one mid-week hour
  Date.parse("2025-09-21T21:00:00Z"), Date.parse("2025-09-21T22:00:00Z"),
];

export function syntheticHours(seed: number, base: number, scale: number): H1[] {
  const rnd = mulberry32(seed), round = (x: number) => Math.round(x * 1e5) / 1e5, holes = new Set(SYNTHETIC_HOLES);
  const out: H1[] = [];
  let price = base, drift = 0, left = 0;
  for (let t = SYNTHETIC_SPAN.start; t < SYNTHETIC_SPAN.end; t += 3_600_000) {
    if (!fxOpen(t)) continue;
    if (left <= 0) { left = 40 + Math.floor(rnd() * 260); drift = (rnd() - 0.5) * 0.9 * scale; } // regime: 40–300 open hours
    left--;
    const o = price, c = price + drift + (rnd() - 0.5) * 2.4 * scale;
    const h = Math.max(o, c) + rnd() * 1.1 * scale, l = Math.min(o, c) - rnd() * 1.1 * scale;
    price = c;
    if (holes.has(t)) continue;
    out.push({ t, o: round(o), h: round(h), l: round(l), c: round(c) });
  }
  return out;
}

/** The two synthetic series used by the tests (a 1.x-priced and a 1xx-priced instrument). */
export const SYNTHETIC_SERIES: Record<string, () => H1[]> = {
  "SYN-A": () => syntheticHours(20251014, 1.1, 0.0009),
  "SYN-B": () => syntheticHours(77731, 160, 0.09),
};
