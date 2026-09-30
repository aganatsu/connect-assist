/**
 * SMC_ROUTE2_BOUNDED_TTL_AND_REFINED_ENTRY_AUDIT_V1 — geometry capture.
 *
 * Same frozen Route 2 candidate generation as r2-candidates.ts. The only
 * change is WHAT IS RECORDED: the full zone geometry needed to audit
 * refinedEntry (Fib level, impulse leg, POI bounds, both entry candidates).
 * No gate, threshold, price or precedence rule is altered.
 *
 * decideZone (smcZoneDecision.ts:273-312) flattens the engine result, so
 * `bestZone.high/.low/.refinedEntry/.fibLevel/.totalScore` are real fields on
 * the object BOTH production (bot-scanner:7364) and this harness read.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-net \
 *     local-runner/r2-geometry.ts [SYMBOL]
 */

import { decideDirection, buildDirectionConfig } from "../supabase/functions/_shared/smcDirectionDecision.ts";
import { buildHtfContext } from "../supabase/functions/_shared/smcHtfContext.ts";
import { decideZone, hasMinZoneCandles, buildHtfConfluence } from "../supabase/functions/_shared/smcZoneDecision.ts";
import { runConfluenceAnalysis } from "../supabase/functions/_shared/confluenceScoring.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { loadCorpus, PRODUCTION_UNIVERSE, WINDOWS, tradeableAt } from "./smc-corpus-fetch.ts";
import { COSTS } from "./smc-zone-replay.ts";

const SCAN_INTERVAL_MIN = 5;
const TP_RATIO = 2.0, SL_CAP_MULT = 1.5, MIN_CONFLUENCE = 40, MIN_ZONE_SCORE = 4;
const MIN_SL_PIPS: Record<string, number> = {
  "EUR/USD": 20, "USD/JPY": 25, "GBP/USD": 25, "AUD/USD": 18, "NZD/USD": 18,
  "USD/CAD": 18, "USD/CHF": 18, "CHF/JPY": 25, "NZD/CAD": 20, "NZD/CHF": 20, "BTC/USD": 150,
};
const SPEC_COST: Record<string, { spread: number; slip: number; pip: number }> = {
  "CHF/JPY": { spread: 2.5, slip: 0.5, pip: 0.01 },
  "NZD/CAD": { spread: 2.5, slip: 0.5, pip: 0.0001 },
  "NZD/CHF": { spread: 3.0, slip: 0.6, pip: 0.0001 },
  "BTC/USD": { spread: 20.0, slip: 4.0, pip: 1 },
  "ETH/USD": { spread: 2.0, slip: 0.4, pip: 0.01 },
};
const ZONE_ENTRY_DEPTH: Record<string, number> = { "EUR/USD": 0.5, "AUD/USD": 0.5 };
const DEPTH = { m5: 1440, m15: 480, h1: 120, h4: 300, d1: 260, w1: 52 };
const WALK_CAP_MIN = 1440;

function seriesAt(bars: Candle[], sub: Candle[], tMs: number, depth: number, cursor: { i: number }): Candle[] {
  while (cursor.i + 1 < bars.length && Date.parse(bars[cursor.i + 1].datetime) <= tMs) cursor.i++;
  let lastClosed = -1;
  for (let k = cursor.i; k >= 0; k--) {
    const nxt = k + 1 < bars.length ? Date.parse(bars[k + 1].datetime) : Infinity;
    if (nxt <= tMs) { lastClosed = k; break; }
  }
  const closed = lastClosed >= 0 ? bars.slice(Math.max(0, lastClosed - depth + 1), lastClosed + 1) : [];
  const formIdx = lastClosed + 1;
  if (formIdx >= bars.length) return closed;
  const fStart = Date.parse(bars[formIdx].datetime);
  if (fStart > tMs) return closed;
  let lo = 0, hi = sub.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (Date.parse(sub[m].datetime) < fStart) lo = m + 1; else hi = m; }
  let o = NaN, h = -Infinity, l = Infinity, c = NaN;
  for (let j = lo; j < sub.length; j++) {
    const st = Date.parse(sub[j].datetime);
    if (st > tMs) break;
    if (Number.isNaN(o)) o = sub[j].open;
    if (sub[j].high > h) h = sub[j].high;
    if (sub[j].low < l) l = sub[j].low;
    c = sub[j].close;
  }
  if (Number.isNaN(o)) return closed;
  return [...closed, { datetime: bars[formIdx].datetime, open: o, high: h, low: l, close: c, volume: 0 } as Candle];
}

function atr14(c: Candle[]): number | null {
  if (c.length < 15) return null;
  let s = 0;
  for (let i = c.length - 14; i < c.length; i++) {
    s += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  }
  return s / 14;
}

/**
 * Minutes since the impulse leg ended, located by matching the leg's extreme
 * against the series the engine saw. Exact float match first (the extreme IS a
 * bar's high/low), nearest-bar fallback. Null when neither resolves.
 */
function impulseEndAgeMin(series: Candle[], tMs: number, hi: number, lo: number): number | null {
  let iHi = -1, iLo = -1;
  for (let i = series.length - 1; i >= 0; i--) {
    if (iHi < 0 && series[i].high === hi) iHi = i;
    if (iLo < 0 && series[i].low === lo) iLo = i;
    if (iHi >= 0 && iLo >= 0) break;
  }
  const idx = Math.max(iHi, iLo);
  if (idx < 0) return null;
  return Math.round((tMs - Date.parse(series[idx].datetime)) / 60_000);
}

export interface GeoRow {
  symbol: string; t: string; direction: "long" | "short";
  zoneTF: string | null; zoneScore: number; confluence: number;
  lastPrice: number; atrH1: number;
  poiHigh: number; poiLow: number; poiType: string | null;
  fibLevel: number | null; fibDepth: number | null;
  ltfRefined: boolean; ltfType: string | null;
  refinedEntry: number | null; refinedSL: number | null;
  unifiedEntry: number | null; unifiedGatePassed: boolean;
  impulseHigh: number | null; impulseLow: number | null; impulseDir: string | null;
  impulseAgeMin: number | null;
  engineDistToZone: number | null; engineDistPips: number | null;
  /** production precedence result */
  entryPrice: number; entrySource: "unified" | "refinedEntry" | "zoneMid";
  distAtrH1: number;
  touchMin: number | null; windowComplete: boolean;
}

if (import.meta.main) {
  const only = Deno.args[0];
  const dirCfg = buildDirectionConfig({});

  for (const sym of (only ? [only] : PRODUCTION_UNIVERSE)) {
    const out = new URL(`./.cache/r2g_${sym.replace("/", "")}.json`, import.meta.url);
    try { Deno.readTextFileSync(out); console.log(`${sym}: cached`); continue; } catch { /* run */ }

    const m1 = loadCorpus(sym, "1m"), m5 = loadCorpus(sym, "5m"), m15 = loadCorpus(sym, "15m");
    const h1 = loadCorpus(sym, "1h"), h4 = loadCorpus(sym, "4h");
    const d1 = loadCorpus(sym, "1d"), w1 = loadCorpus(sym, "1w");
    if (!m1.length || !m5.length) { console.log(`${sym}: NO CORPUS`); continue; }

    const pip = (COSTS[sym] ?? SPEC_COST[sym]).pip;
    const floor = MIN_SL_PIPS[sym] ?? 15;
    const secFrom = Date.parse(WINDOWS.secondary.from);
    const to = Date.parse(WINDOWS.secondary.to) + 86_400_000;
    const m1t = m1.map((b) => Date.parse(b.datetime));
    const tapeEnd = m1t[m1t.length - 1];

    const rows: GeoRow[] = [];
    const cur = { m5: { i: 0 }, m15: { i: 0 }, h1: { i: 0 }, h4: { i: 0 }, d1: { i: 0 }, w1: { i: 0 } };
    const t0 = Date.now();

    for (let k = 0; k < m1.length; k++) {
      const tMs = m1t[k];
      if (tMs < secFrom || tMs > to) continue;
      if (new Date(tMs).getUTCMinutes() % SCAN_INTERVAL_MIN !== 0) continue;
      if (!tradeableAt(sym, tMs)) continue;

      const s = {
        candles: seriesAt(m5, m1, tMs, DEPTH.m5, cur.m5),
        m15Candles: seriesAt(m15, m1, tMs, DEPTH.m15, cur.m15),
        hourlyCandles: seriesAt(h1, m1, tMs, DEPTH.h1, cur.h1),
        h4Candles: seriesAt(h4, h1, tMs, DEPTH.h4, cur.h4),
        dailyCandles: seriesAt(d1, h1, tMs, DEPTH.d1, cur.d1),
        weeklyCandles: seriesAt(w1, h1, tMs, DEPTH.w1, cur.w1),
      };
      if (s.candles.length < 200) continue;

      const dir = decideDirection({ style: "scalper", series: s, dirConfig: dirCfg, useSimpleDirection: true });
      const direction = dir.overrideDirection as "long" | "short" | null;
      if (!direction || !hasMinZoneCandles("scalper", s)) continue;

      const htf = buildHtfContext({
        style: "scalper", m15Candles: s.m15Candles, hourlyCandles: s.hourlyCandles,
        h4Candles: s.h4Candles, dailyCandles: s.dailyCandles,
        equalHighsLowsSensitivity: undefined, liquidityPoolMinTouches: undefined,
      });
      const lastPrice = s.candles[s.candles.length - 1].close;

      const z = decideZone({
        symbol: sym, style: "scalper", series: s, direction, lastPrice,
        htfConfluence: buildHtfConfluence({
          direction, h4OBs: htf.h4OBs, h4FVGs: htf.h4FVGs, h4Breakers: htf.h4Breakers,
          htfFibLevels4H: htf.htfFibLevels4H, htfFibLevelsD: htf.htfFibLevelsD, htfPD4H: htf.htfPD4H,
        } as never),
        liquidityPools: htf.combinedLiquidityPools,
        minSlPips: floor, maxSlPips: floor * SL_CAP_MULT, tpRatio: TP_RATIO,
        entryDepth: ZONE_ENTRY_DEPTH[sym], pipSize: pip,
        strictATRMult: undefined, fibMaxRetracement: undefined,
        originOBRetest: undefined, impulseZoneEnabled: true,
      });
      const iz = z.impulseZone as never as {
        bestZone?: Record<string, unknown>; impulse?: Record<string, unknown>;
      } | null;
      const bz = iz?.bestZone;
      if (!z.unified?.hasZone || !bz) continue;

      const zoneScore = Number(bz.totalScore ?? NaN);
      if (!(zoneScore >= MIN_ZONE_SCORE)) continue;

      const conf = runConfluenceAnalysis(
        s.candles, s.dailyCandles.length >= 10 ? s.dailyCandles : null,
        { tradingStyle: { mode: "scalper" }, entryTimeframe: "5m", minConfluence: MIN_CONFLUENCE, tpRatio: TP_RATIO },
        s.hourlyCandles.length ? s.hourlyCandles : undefined, tMs,
      ) as { score?: number };
      const confluence = conf?.score ?? null;
      if (!(confluence !== null && confluence >= MIN_CONFLUENCE)) continue;

      const zh = Number(bz.high), zl = Number(bz.low), zw = zh - zl;
      const layer3 = direction === "long" ? lastPrice <= zh + zw * 2 : lastPrice >= zl - zw * 2;
      if (bz.priceAtZoneStrict === true && bz.sideOk === true && layer3) continue;  // Route 1

      const u = z.unified as unknown as {
        hasZone?: boolean; state?: string;
        confirmation?: { entryReady?: boolean }; entry?: { entryPrice?: number };
      };
      const unifiedGatePassed = u?.hasZone === true &&
        (u.state === "triggered" || u.state === "confirmed") && u.confirmation?.entryReady === true;
      const unifiedEntry = typeof u?.entry?.entryPrice === "number" ? u.entry.entryPrice : null;
      const refinedEntry = typeof bz.refinedEntry === "number" ? bz.refinedEntry as number : null;

      let entryPrice: number, entrySource: GeoRow["entrySource"];
      if (unifiedGatePassed && unifiedEntry !== null) { entryPrice = unifiedEntry; entrySource = "unified"; }
      else if (refinedEntry !== null) { entryPrice = refinedEntry; entrySource = "refinedEntry"; }
      else { entryPrice = (zh + zl) / 2; entrySource = "zoneMid"; }
      if (!Number.isFinite(entryPrice)) continue;

      const a = atr14(s.hourlyCandles);
      if (!a || !(a > 0)) continue;

      const sel = z.unified.selectedTF;
      const selSeries = sel === "5m" ? s.candles : sel === "15m" ? s.m15Candles
        : sel === "1H" ? s.hourlyCandles : s.hourlyCandles;
      const impHi = iz?.impulse ? Number((iz.impulse as Record<string, unknown>).high) : null;
      const impLo = iz?.impulse ? Number((iz.impulse as Record<string, unknown>).low) : null;

      let lo = 0, hi2 = m1t.length;
      while (lo < hi2) { const m = (lo + hi2) >> 1; if (m1t[m] < tMs) lo = m + 1; else hi2 = m; }
      let touchMin: number | null = null;
      for (let j = lo; j < m1.length; j++) {
        const el = Math.round((m1t[j] - tMs) / 60_000);
        if (el > WALK_CAP_MIN) break;
        if (!tradeableAt(sym, m1t[j])) continue;
        const b = m1[j];
        if (direction === "long" ? b.low <= entryPrice : b.high >= entryPrice) { touchMin = el; break; }
      }

      rows.push({
        symbol: sym, t: new Date(tMs).toISOString(), direction,
        zoneTF: sel ?? null, zoneScore, confluence, lastPrice, atrH1: a,
        poiHigh: zh, poiLow: zl, poiType: (bz.type as string) ?? null,
        fibLevel: bz.fibLevel != null ? Number(bz.fibLevel) : null,
        fibDepth: bz.fibDepth != null ? Number(bz.fibDepth) : null,
        ltfRefined: bz.ltfRefined === true, ltfType: (bz.ltfType as string) ?? null,
        refinedEntry, refinedSL: typeof bz.refinedSL === "number" ? bz.refinedSL as number : null,
        unifiedEntry, unifiedGatePassed,
        impulseHigh: Number.isFinite(impHi as number) ? impHi : null,
        impulseLow: Number.isFinite(impLo as number) ? impLo : null,
        impulseDir: iz?.impulse ? String((iz.impulse as Record<string, unknown>).direction) : null,
        impulseAgeMin: (impHi != null && impLo != null && Number.isFinite(impHi) && Number.isFinite(impLo))
          ? impulseEndAgeMin(selSeries, tMs, impHi, impLo) : null,
        engineDistToZone: bz.distanceToZone != null ? Number(bz.distanceToZone) : null,
        engineDistPips: bz.distancePips != null ? Number(bz.distancePips) : null,
        entryPrice, entrySource, distAtrH1: Math.abs(entryPrice - lastPrice) / a,
        touchMin, windowComplete: tapeEnd - tMs >= WALK_CAP_MIN * 60_000,
      });
    }

    Deno.writeTextFileSync(out, JSON.stringify(rows));
    console.log(`${sym}: ${rows.length} Route2 candidates with geometry, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
