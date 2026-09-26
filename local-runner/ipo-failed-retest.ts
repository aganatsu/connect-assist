/**
 * IPO_FAILED_RETEST_V1 — research only. A SEPARATE strategy population.
 *
 * HYPOTHESIS. When a valid IPO fails by the existing close-based invalidation
 * rule, the failed zone may work as a break-and-retest zone in the OPPOSITE
 * direction.
 *
 * Normal IPO trades are untouched and their P/L is never merged with this.
 * Nothing here is wired to production.
 *
 * ── FAILURE (§1), the existing rule verbatim ────────────────────────────────
 * `runLifecycle` sets `invalidatedAt` at the first bar from `validAt` onward
 * whose CLOSE is beyond `invalidationLevel` (the far wick extreme). Wicks that
 * do not close through are ignored. This reads that field rather than
 * re-deriving it, so the failure definition cannot drift from the IPO engine's.
 *
 * ── STOP / TARGET CONTRACT (§6), derived, not invented ──────────────────────
 * Frozen geometry: zone = the PROXIMAL HALF of the candle, distal = midpoint of
 * the full wick range, extent = far wick. For a demand IPO zoneLow = distal
 * (midpoint) and zoneHigh = proximal (the candle high); for supply it mirrors.
 * Normal IPO enters at the 50% midpoint, stops at the extent, targets 2R.
 *
 * The flipped retest reuses the SAME geometry read from the other side:
 *
 *   failed BULLISH IPO -> SHORT retest
 *     price closed below the candle low, so it returns from BELOW and meets the
 *     zone's near edge first, which is zoneLow = the 50% midpoint.
 *     ENTRY  = zoneLow   (the original IPO's own entry level)
 *     STOP   = zoneHigh  (the far side of the zone = the candle high)
 *     RISK   = zoneHigh - zoneLow  = half the candle's full range
 *     TARGET = entry - 2 * risk
 *
 *   failed BEARISH IPO -> LONG retest, mirrored:
 *     ENTRY = zoneHigh, STOP = zoneLow, TARGET = entry + 2 * risk
 *
 * Every number comes from `ipoGeometry`. Nothing was fitted, and 2R is the
 * frozen normal-IPO target reused rather than a chosen one. ONE target only —
 * no sweep.
 *
 * ── 1-MINUTE EXECUTION (§7) ─────────────────────────────────────────────────
 * The strategy timeframe cannot order events inside a bar. Every trade whose
 * entry, stop or target could interact within one bar is resolved against 1m
 * bars. Where 1m cannot separate them — both levels touched inside the SAME 1m
 * bar — the trade is marked EXECUTION_AMBIGUOUS and excluded from clean stats.
 * Code precedence is never used as execution evidence.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-net --allow-env \
 *     local-runner/ipo-failed-retest.ts [--detect-only]
 */

import { runLifecycle } from "../supabase/functions/_shared/ipoLifecycle.ts";
import { episodesFor } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import { ipoGeometry } from "../supabase/functions/_shared/ipoZones.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { WINDOWS } from "./ipo-bos-fetch.ts";

const CACHE = "/tmp/ipo-bos-data";
const M1 = "/tmp/ipo-m1-data";
const OUT = "/tmp/ipo-failed-retest";
const MAX_BARS = 1800;
const TARGET_R = 2;          // frozen: the normal-IPO target, reused. No sweep.

export interface FailedRetest {
  ipo_id: string;
  instrument: string; window: string; strategy_timeframe: string; barMs: number;
  original_direction: "demand" | "supply";
  flipped_direction: "long" | "short";

  ipo_origin_index: number; ipo_origin_time: string;
  ipo_open: number; ipo_high: number; ipo_low: number; ipo_close: number;
  original_zone_high: number; original_zone_low: number; original_midpoint: number;
  original_extent: number;

  failure_index: number; failure_time: string; failure_close: number;

  retested: boolean;
  retest_index: number | null; retest_time: string | null; retest_touch_price: number | null;
  bars_failure_to_retest: number | null;
  max_distance_away: number | null; max_distance_away_atr: number | null;
  retest_penetration_pct: number | null;

  entry_price: number; stop_price: number; target_price: number; risk_price: number;

  // volatility tags (§16) — recorded, never used as a filter in V1
  atr_at_failure: number | null; atr_over_price_at_failure: number | null;
  atr_at_retest: number | null; atr_over_price_at_retest: number | null;
  atr_percentile_at_retest: number | null; range_expansion_at_retest: number | null;

  reclaimed_after_retest: boolean | null;   // §15
}

// ── helpers ────────────────────────────────────────────────────────────────

/** True ATR over the `n` bars ending at i (inclusive), causal. */
function atrAt(s: Candle[], i: number, n = 14): number | null {
  if (i < n) return null;
  let sum = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const p = s[k - 1];
    sum += Math.max(s[k].high - s[k].low, Math.abs(s[k].high - p.close), Math.abs(s[k].low - p.close));
  }
  return sum / n;
}

/** Percentile of the current ATR within the trailing 200-bar ATR distribution. */
function atrPercentile(s: Candle[], i: number): number | null {
  const cur = atrAt(s, i); if (cur === null) return null;
  const hist: number[] = [];
  for (let k = Math.max(14, i - 200); k < i; k++) { const a = atrAt(s, k); if (a !== null) hist.push(a); }
  if (hist.length < 30) return null;
  return (hist.filter((x) => x <= cur).length / hist.length) * 100;
}

// ── detection ──────────────────────────────────────────────────────────────

const all: FailedRetest[] = [];
const funnel: Record<string, Record<string, number>> = {};

for (const w of WINDOWS) {
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === w.instrument)!;
  let s: Candle[];
  try {
    s = (JSON.parse(await Deno.readTextFile(`${CACHE}/${w.id}_${w.tf}.json`)) as Candle[]).slice(-MAX_BARS);
  } catch { console.error(`  MISSING ${w.id}`); continue; }

  const f = funnel[w.instrument] ??= {
    validIpos: 0, failed: 0, neverRetested: 0, retested: 0, candidates: 0,
  };

  // The frozen lifecycle, whole-series. Failure and retest are both READ from
  // it and from bars after the failure, so each recorded timestamp is causal by
  // construction even though detection runs in one pass.
  const life = runLifecycle(s, episodesFor(s)).filter((x) => x.validAt !== null && x.hasFvg);
  f.validIpos += life.length;

  for (const ipo of life) {
    if (ipo.invalidatedAt === null) continue;
    f.failed++;

    const up = ipo.direction === "demand";
    const fi = ipo.invalidatedAt;
    const geo = ipoGeometry(s[ipo.candidateIndex], ipo.direction);

    // §3/§4: price must trade entirely to the broken side before returning.
    // The failure bar itself closed beyond the extent, which IS the move to the
    // broken side; the retest is the first later bar that re-enters the zone.
    let retestIdx: number | null = null;
    let extreme = up ? Infinity : -Infinity;
    for (let j = fi + 1; j < s.length; j++) {
      const c = s[j];
      extreme = up ? Math.min(extreme, c.low) : Math.max(extreme, c.high);
      const reentered = up ? c.high >= geo.zoneLow : c.low <= geo.zoneHigh;
      if (reentered) { retestIdx = j; break; }
    }

    const entry = up ? geo.zoneLow : geo.zoneHigh;
    const stop = up ? geo.zoneHigh : geo.zoneLow;
    const risk = Math.abs(stop - entry);
    const target = up ? entry - TARGET_R * risk : entry + TARGET_R * risk;

    if (retestIdx === null) f.neverRetested++; else { f.retested++; f.candidates++; }

    const atrF = atrAt(s, fi), atrR = retestIdx !== null ? atrAt(s, retestIdx) : null;
    const away = retestIdx !== null
      ? (up ? geo.zoneLow - extreme : extreme - geo.zoneHigh) : null;
    // Penetration: 0 at the near edge, 1 at the far edge of the old zone.
    const zw = geo.zoneHigh - geo.zoneLow;
    let pen: number | null = null;
    if (retestIdx !== null && zw > 0) {
      const c = s[retestIdx];
      pen = up ? (c.high - geo.zoneLow) / zw : (geo.zoneHigh - c.low) / zw;
    }

    // §15: after the retest, did price close fully back through the far side,
    // reclaiming the old zone?
    let reclaimed: boolean | null = null;
    if (retestIdx !== null) {
      reclaimed = false;
      for (let j = retestIdx; j < s.length; j++) {
        if (up ? s[j].close > geo.zoneHigh : s[j].close < geo.zoneLow) { reclaimed = true; break; }
      }
    }

    all.push({
      ipo_id: `${w.id}#${ipo.candidateIndex}`,
      instrument: inst.instrument, window: w.id, strategy_timeframe: inst.timeframe, barMs: inst.barMs,
      original_direction: ipo.direction, flipped_direction: up ? "short" : "long",
      ipo_origin_index: ipo.candidateIndex, ipo_origin_time: s[ipo.candidateIndex].datetime,
      ipo_open: s[ipo.candidateIndex].open, ipo_high: s[ipo.candidateIndex].high,
      ipo_low: s[ipo.candidateIndex].low, ipo_close: s[ipo.candidateIndex].close,
      original_zone_high: geo.zoneHigh, original_zone_low: geo.zoneLow,
      original_midpoint: geo.distal, original_extent: geo.extent,
      failure_index: fi, failure_time: s[fi].datetime, failure_close: s[fi].close,
      retested: retestIdx !== null,
      retest_index: retestIdx, retest_time: retestIdx !== null ? s[retestIdx].datetime : null,
      retest_touch_price: retestIdx !== null ? entry : null,
      bars_failure_to_retest: retestIdx !== null ? retestIdx - fi : null,
      max_distance_away: away, max_distance_away_atr: away !== null && atrF ? away / atrF : null,
      retest_penetration_pct: pen,
      entry_price: entry, stop_price: stop, target_price: target, risk_price: risk,
      atr_at_failure: atrF, atr_over_price_at_failure: atrF ? atrF / s[fi].close : null,
      atr_at_retest: atrR, atr_over_price_at_retest: atrR && retestIdx !== null ? atrR / s[retestIdx].close : null,
      atr_percentile_at_retest: retestIdx !== null ? atrPercentile(s, retestIdx) : null,
      range_expansion_at_retest: atrR && atrF ? atrR / atrF : null,
      reclaimed_after_retest: reclaimed,
    });
  }
  console.error(`  ${w.id.padEnd(20)} valid ${String(life.length).padStart(4)}  failed ${String(all.filter(a=>a.window===w.id).length).padStart(4)}`);
}

await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/detection.json`, JSON.stringify({ all, funnel }, null, 2));

console.log(`\n── §9 FUNNEL (detection stage) ──`);
console.log(`  ${"instrument".padEnd(10)} ${"validIPO".padStart(9)} ${"failed".padStart(7)} ${"%fail".padStart(6)} ${"retested".padStart(9)} ${"%retest".padStart(8)} ${"never".padStart(7)}`);
for (const i of ["EUR/USD", "USD/JPY", "BTC/USD"]) {
  const f = funnel[i]; if (!f) continue;
  console.log(`  ${i.padEnd(10)} ${String(f.validIpos).padStart(9)} ${String(f.failed).padStart(7)} ${(100*f.failed/Math.max(1,f.validIpos)).toFixed(1).padStart(6)} ${String(f.retested).padStart(9)} ${(100*f.retested/Math.max(1,f.failed)).toFixed(1).padStart(8)} ${String(f.neverRetested).padStart(7)}`);
}
const cands = all.filter((a) => a.retested);
console.log(`\n  retest candidates needing 1m execution: ${cands.length}`);
console.log(`  detection -> ${OUT}/detection.json`);
