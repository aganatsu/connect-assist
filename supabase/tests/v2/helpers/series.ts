// Small hand-built series for module tests. Prices in pips relative to a pair base; null = MISSING.
import { buildGrid, buildSeries, type RawBar, type Series } from "../../../functions/_shared/v2/barStore.ts";
import { type Pair, PIP, STEP_MS, type TF } from "../../../functions/_shared/v2/spec.ts";
import { nyLocalToUtc } from "../../../functions/_shared/v2/calendar.ts";
import type { OHLC } from "./scenario.ts";
import { BASE } from "./scenario.ts";

/** Monday 2026-09-14 00:00 NY — a weekday start so short series never cross the weekend. */
export const MON = nyLocalToUtc(2026, 9, 14, 0, 0);

export function pipsToRaw(pair: Pair, t: number, b: OHLC): RawBar {
  const r = (x: number) => +(BASE[pair] + x * PIP[pair]).toFixed(PIP[pair] === 0.01 ? 3 : 5);
  return { t, o: r(b[0]), h: r(b[1]), l: r(b[2]), c: r(b[3]) };
}

export function mkSeries(bars: (OHLC | null)[], tf: TF = "1h", pair: Pair = "EUR/USD", start = MON): Series {
  const grid = buildGrid(tf, start, start + (bars.length + 200) * STEP_MS[tf]).slice(0, bars.length);
  const raw: RawBar[] = [];
  bars.forEach((b, i) => { if (b) raw.push(pipsToRaw(pair, grid[i], b)); });
  return buildSeries(pair, tf, raw, grid);
}

/** points per pip helper for EUR/USD-style assertions */
export const P = (pips: number, pair: Pair = "EUR/USD") => Math.round((BASE[pair] + pips * PIP[pair]) * (1000 / PIP[pair]));
export const D = (pips: number) => Math.round(pips * 1000);
