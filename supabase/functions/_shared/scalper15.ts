/**
 * Scalper15 — 15m Impulse zones traded in the 1H direction (owner spec 2026-11-05;
 * docs/SCALPER15_PREREG_V1.md).
 *
 *   direction  1H structure: long after a 1H CLOSE above the last confirmed swing high,
 *              short after a close below the last swing low; held until the opposite break.
 *   zone       findBestEntryZone with the 15m series in the impulse slot (engine unmodified).
 *   entry      the Route 2 hunt: touch → detectZoneConfirmation on 5m → fill at market.
 *   stop       beyond the zone's far edge (+ buffer; optional floor).
 *   target     the 1H leg extreme (variable R), admitted only at ≥ minPlannedR.
 *
 * ONE implementation for bot-scanner (live / dry run) and local-runner/scalper15-backtest.ts,
 * so the backtest measures the code that trades. Pure: no I/O.
 */

import type { Candle } from "./smcAnalysis.ts";
import { findBestEntryZone } from "./impulseZoneEngine.ts";

/** Order tag: pending_orders.entry_zone_type = "S15-OB" / "S15-FVG". */
export const S15_ZONE_PREFIX = "S15";
export const isScalper15Order = (o: { entry_zone_type?: string | null }) =>
  typeof o.entry_zone_type === "string" && o.entry_zone_type.startsWith(`${S15_ZONE_PREFIX}-`);

/**
 * Bars read per decision. h1 = what the scanner's 1H fetch ("5d") returns, so live and the
 * backtest see the same window; m15 / m5 = the "5d" fetches (the production scalper depths).
 */
export const S15_DEPTH = { h1: 120, m15: 480, m5: 1440 } as const;

export interface Scalper15Settings {
  enabled: boolean;
  /** Minimum planned R to the 1H target, checked at placement (from the zone midpoint) and again at the fill. */
  minPlannedR: number;
  /** Stop distance beyond the zone's far edge, pips. */
  stopBufferPips: number;
  /** Optional minimum stop distance from the entry, pips. 0 = none (the owner spec). */
  minStopPips: number;
}
export const SCALPER15_DEFAULTS: Scalper15Settings = { enabled: false, minPlannedR: 1.0, stopBufferPips: 1, minStopPips: 0 };

const num = (v: unknown, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return v === undefined || v === null || !Number.isFinite(n) ? d : Math.min(hi, Math.max(lo, n));
};

/** Reads config_json.strategy.scalper15* (Bot Config). Anything absent takes the default; enabled only on an explicit true. */
export function resolveScalper15(raw: unknown): Scalper15Settings {
  const s = ((raw as Record<string, any> | null)?.strategy ?? {}) as Record<string, unknown>;
  return {
    enabled: s.scalper15Enabled === true,
    minPlannedR: num(s.scalper15MinPlannedR, SCALPER15_DEFAULTS.minPlannedR, 0.5, 10),
    stopBufferPips: num(s.scalper15StopBufferPips, SCALPER15_DEFAULTS.stopBufferPips, 0, 20),
    minStopPips: num(s.scalper15MinStopPips, SCALPER15_DEFAULTS.minStopPips, 0, 100),
  };
}

const TF_MIN: Record<string, number> = { "1m": 1, "5m": 5, "15m": 15, "1h": 60 };
/** Only bars that have CLOSED by `nowMs` (open + timeframe ≤ now): the forming bar is dropped. */
export function closedBars(bars: Candle[], tf: "1m" | "5m" | "15m" | "1h", nowMs: number): Candle[] {
  const ms = TF_MIN[tf] * 60_000;
  let end = bars.length;
  while (end > 0 && Date.parse(bars[end - 1].datetime) + ms > nowMs) end--;
  return end === bars.length ? bars : bars.slice(0, end);
}

export type Dir = 1 | -1;
export interface BiasState { bias: Dir | 0; legHigh: number; legLow: number }

/**
 * 1H bias per bar. Swing high = strictly above the two bars each side, known at the close of
 * the second bar after it (swing low mirrored). Bias flips on a CLOSE beyond the latest
 * confirmed swing; the leg extreme runs from the flip bar on.
 */
export function buildBiasStates(h1: Candle[]): BiasState[] {
  const out: BiasState[] = [];
  let lastSH = NaN, lastSL = NaN;
  let bias: Dir | 0 = 0, legHigh = NaN, legLow = NaN;
  for (let i = 0; i < h1.length; i++) {
    const j = i - 2;
    if (j >= 2) {
      const hj = h1[j].high, lj = h1[j].low;
      if (hj > h1[j - 1].high && hj > h1[j - 2].high && hj > h1[j + 1].high && hj > h1[i].high) lastSH = hj;
      if (lj < h1[j - 1].low && lj < h1[j - 2].low && lj < h1[j + 1].low && lj < h1[i].low) lastSL = lj;
    }
    const c = h1[i].close;
    if (bias !== 1 && Number.isFinite(lastSH) && c > lastSH) { bias = 1; legHigh = h1[i].high; legLow = h1[i].low; }
    else if (bias !== -1 && Number.isFinite(lastSL) && c < lastSL) { bias = -1; legHigh = h1[i].high; legLow = h1[i].low; }
    else if (bias !== 0) { legHigh = Math.max(legHigh, h1[i].high); legLow = Math.min(legLow, h1[i].low); }
    out.push({ bias, legHigh, legLow });
  }
  return out;
}

/** The bias at the last of the given CLOSED 1H bars, over the live window (last S15_DEPTH.h1 bars). */
export function biasNow(h1Closed: Candle[]): BiasState {
  const s = buildBiasStates(h1Closed.slice(-S15_DEPTH.h1));
  return s.at(-1) ?? { bias: 0, legHigh: NaN, legLow: NaN };
}

export const plannedR = (dir: Dir, entry: number, stop: number, target: number) => {
  const risk = dir * (entry - stop);
  return risk > 0 ? dir * (target - entry) / risk : -Infinity;
};

export type Scalper15Plan =
  | {
      ok: true; dir: Dir; direction: "long" | "short";
      zone: { type: string; low: number; high: number };
      impulse: { high: number; low: number; startTime: string | null; endTime: string | null };
      limit: number; stop: number; target: number; plannedR: number; bias: BiasState;
    }
  | { ok: false; reason: string; bias: BiasState };

/** Stop beyond the far edge, then the optional floor measured from `entry`. */
export function scalper15Stop(dir: Dir, zone: { low: number; high: number }, entry: number, pipSize: number, s: Scalper15Settings): number {
  let stop = dir === 1 ? zone.low - s.stopBufferPips * pipSize : zone.high + s.stopBufferPips * pipSize;
  if (s.minStopPips > 0 && dir * (entry - stop) < s.minStopPips * pipSize) stop = entry - dir * s.minStopPips * pipSize;
  return stop;
}

/**
 * The order Scalper15 wants for a pair now, from CLOSED bars only. `limit` is the zone
 * midpoint: Route 2 fills at the confirmation price, so the limit is the reference the
 * placement-time R check is measured from; the fill re-checks R at the real price.
 */
export function planScalper15(i: { h1: Candle[]; m15: Candle[]; m5: Candle[]; lastPrice: number; pipSize: number; settings: Scalper15Settings }): Scalper15Plan {
  const bias = biasNow(i.h1);
  if (bias.bias === 0) return { ok: false, reason: "no 1H direction (no close beyond a confirmed 1H swing yet)", bias };
  if (i.m15.length < 50) return { ok: false, reason: `only ${i.m15.length} closed 15m bars`, bias };
  const dir = bias.bias;
  const res = findBestEntryZone(i.m15.slice(-S15_DEPTH.m15), i.m5.slice(-S15_DEPTH.m5), dir === 1 ? "bullish" : "bearish", i.lastPrice, undefined, { pipSize: i.pipSize });
  const bz = res.bestZone;
  if (!bz) return { ok: false, reason: `15m: ${res.reason}`, bias };
  if (!(bz.sideOk || bz.priceInsideZone)) return { ok: false, reason: "15m zone is on the wrong side of price", bias };
  const zone = { type: String(bz.zone.poi.type).toUpperCase(), low: bz.zone.poi.low, high: bz.zone.poi.high };
  const limit = (zone.low + zone.high) / 2;
  const stop = scalper15Stop(dir, zone, limit, i.pipSize, i.settings);
  const target = dir === 1 ? bias.legHigh : bias.legLow;
  const pr = plannedR(dir, limit, stop, target);
  if (!(pr >= i.settings.minPlannedR)) {
    return { ok: false, reason: `1H target ${Number.isFinite(pr) ? pr.toFixed(2) : "behind entry"}R < ${i.settings.minPlannedR}R`, bias };
  }
  return {
    ok: true, dir, direction: dir === 1 ? "long" : "short", zone,
    impulse: { high: bz.impulse.high, low: bz.impulse.low, startTime: bz.impulse.startTime ?? null, endTime: bz.impulse.endTime ?? null },
    limit, stop, target, plannedR: pr, bias,
  };
}
