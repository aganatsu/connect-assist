/**
 * Locate the bar on which each Route 2 POI FORMED, so zone age is measured
 * rather than proxied.
 *
 * Bounds conventions replicated verbatim from production:
 *   OB  — smcAnalysis.ts:1263-1271 obZoneWithWicks
 *         high = (max(o,c) + high)/2 ; low = (min(o,c) + low)/2
 *   FVG — smcAnalysis.ts:1439-1441 / 1478-1481, formed on c2 = candles[i-1]
 *         bullish: high = c3.low , low = c1.high
 *         bearish: high = c1.low , low = c3.high
 *
 * A POI that cannot be located exactly is reported UNKNOWN, never estimated.
 * detectFVGs only scans the last 50 bars (FVG_RECENCY), so an FVG POI is by
 * construction within 50 bars of the scan instant — a useful cross-check.
 */
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { loadCorpus, PRODUCTION_UNIVERSE } from "./smc-corpus-fetch.ts";
import type { GeoRow } from "./r2-geometry.ts";

const EPS = 1e-9;
const near = (a: number, b: number, scale: number) => Math.abs(a - b) <= Math.max(EPS, scale * 1e-7);

export function obBounds(c: Candle) {
  const bh = Math.max(c.open, c.close), bl = Math.min(c.open, c.close);
  return { high: bh + (c.high - bh) * 0.5, low: bl - (bl - c.low) * 0.5 };
}

/** Index of the bar the POI formed on, searching newest-first. -1 if absent. */
export function locatePoi(
  bars: Candle[], upTo: number, poiType: string | null, poiHigh: number, poiLow: number,
): { idx: number; how: string } {
  const scale = Math.abs(poiHigh) || 1;
  if (poiType === "ob") {
    for (let i = upTo; i >= 0; i--) {
      const b = obBounds(bars[i]);
      if (near(b.high, poiHigh, scale) && near(b.low, poiLow, scale)) return { idx: i, how: "ob" };
    }
  } else if (poiType === "fvg") {
    for (let i = upTo; i >= 2; i--) {
      const c1 = bars[i - 2], c3 = bars[i];
      if (near(c3.low, poiHigh, scale) && near(c1.high, poiLow, scale)) return { idx: i - 1, how: "fvg_bull" };
      if (near(c1.low, poiHigh, scale) && near(c3.high, poiLow, scale)) return { idx: i - 1, how: "fvg_bear" };
    }
  }
  return { idx: -1, how: "unlocated" };
}

if (import.meta.main) {
  const cache = new Map<string, Candle[]>();
  const corp = (s: string, tf: string) => {
    const k = `${s}|${tf}`;
    if (!cache.has(k)) cache.set(k, loadCorpus(s, tf));
    return cache.get(k)!;
  };
  let tot = 0;
  const how: Record<string, number> = {};
  const ages: number[] = [];
  const byType: Record<string, { hit: number; n: number }> = {};

  for (const sym of PRODUCTION_UNIVERSE) {
    const rows: GeoRow[] = JSON.parse(Deno.readTextFileSync(
      new URL(`./.cache/r2g_${sym.replace("/", "")}.json`, import.meta.url)));
    for (const r of rows) {
      tot++;
      const tf = r.zoneTF === "5m" ? "5m" : r.zoneTF === "15m" ? "15m" : "1h";
      const bars = corp(sym, tf);
      const tMs = Date.parse(r.t);
      // newest CLOSED bar at the scan instant
      let last = -1;
      for (let i = 0; i < bars.length; i++) {
        const nxt = i + 1 < bars.length ? Date.parse(bars[i + 1].datetime) : Infinity;
        if (nxt <= tMs) last = i; else break;
      }
      if (last < 3) { how.no_history = (how.no_history || 0) + 1; continue; }
      const { idx, how: h } = locatePoi(bars, last, r.poiType, r.poiHigh, r.poiLow);
      how[h] = (how[h] || 0) + 1;
      const k = r.poiType ?? "null";
      byType[k] ??= { hit: 0, n: 0 };
      byType[k].n++;
      if (idx >= 0) {
        byType[k].hit++;
        ages.push(Math.round((tMs - Date.parse(bars[idx].datetime)) / 60_000));
      }
    }
  }
  const q = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
  console.log(`candidates ${tot}`);
  console.log("locator outcome:", JSON.stringify(how));
  for (const [k, v] of Object.entries(byType)) console.log(`  poiType ${k.padEnd(5)} located ${v.hit}/${v.n} (${(100 * v.hit / v.n).toFixed(1)}%)`);
  console.log(`located ${ages.length}/${tot} (${(100 * ages.length / tot).toFixed(1)}%)`);
  console.log(`zone age at creation (min): p25 ${q(ages, .25)}  med ${q(ages, .5)}  p75 ${q(ages, .75)}  p90 ${q(ages, .9)}  max ${Math.max(...ages)}`);
}
