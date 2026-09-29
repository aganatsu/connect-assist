/**
 * SMC_ROUTE2_REACHABILITY_AND_UNIVERSE_AUDIT_V1 — pending-candidate generation
 * and PURE price reachability. RESEARCH ONLY.
 *
 * Generates Route 2 pending opportunities using the production pipeline up to
 * PENDING_CREATED and no further. No confirmation, no CHoCH, no resets, no
 * fill, no outcome.
 *
 * Route 2 is the complement of Route 1: the same setup pipeline, taken when
 * price is NOT strictly at the zone (bot-scanner:7442
 * `effectiveLimitEnabled = !useMarketFillAtZone && ...`).
 *
 * Pending entry price follows production precedence exactly
 * (bot-scanner:7360-7391):
 *   1. unified entry      when the unified gate passed and it carries one
 *   2. bestZone.refinedEntry            (izGateMode "hard")
 *   3. zone midpoint (high+low)/2       fallback
 * `computeLimitEntryPrice` (the legacy OB/FVG path) is unreachable here:
 * under the live hard gate with a bestZone present, `zoneEngineWillOverride`
 * is true, so it is never called.
 *
 * Reachability is a pure price-path question on 1m bars. A touch must occur
 * strictly at or after the creation instant and on a TRADEABLE bar — the FX
 * corpus carries weekend rows that no order could have filled against.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-net \
 *     local-runner/r2-candidates.ts [SYMBOL]
 */

import { decideDirection, buildDirectionConfig } from "../supabase/functions/_shared/smcDirectionDecision.ts";
import { buildHtfContext } from "../supabase/functions/_shared/smcHtfContext.ts";
import { decideZone, hasMinZoneCandles, buildHtfConfluence } from "../supabase/functions/_shared/smcZoneDecision.ts";
import { runConfluenceAnalysis } from "../supabase/functions/_shared/confluenceScoring.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { loadCorpus, PRODUCTION_UNIVERSE, WINDOWS, tradeableAt, isCrypto } from "./smc-corpus-fetch.ts";
import { COSTS } from "./smc-zone-replay.ts";

// ── frozen production parameters (unchanged from the Route 1 replay) ────────
const SCAN_INTERVAL_MIN = 5;
const TP_RATIO = 2.0;
const SL_CAP_MULT = 1.5;
const MIN_CONFLUENCE = 40;   // live strategy.confluenceThreshold
const MIN_ZONE_SCORE = 4;
const MIN_SL_PIPS: Record<string, number> = {
  "EUR/USD": 20, "USD/JPY": 25, "GBP/USD": 25,
  "AUD/USD": 18, "NZD/USD": 18, "USD/CAD": 18, "USD/CHF": 18,
  "CHF/JPY": 25, "NZD/CAD": 20, "NZD/CHF": 20, "BTC/USD": 150,
  // ETH/USD is absent from production's table and inherits the 15 fallback.
  // Recorded as production behaviour, not corrected here.
};
/** SPECS pipSize + typicalSpread for instruments outside the FX-major COSTS map. */
const SPEC_COST: Record<string, { spread: number; slip: number; pip: number }> = {
  "CHF/JPY": { spread: 2.5, slip: 0.5, pip: 0.01 },
  "NZD/CAD": { spread: 2.5, slip: 0.5, pip: 0.0001 },
  "NZD/CHF": { spread: 3.0, slip: 0.6, pip: 0.0001 },
  "BTC/USD": { spread: 20.0, slip: 4.0, pip: 1 },
  "ETH/USD": { spread: 2.0, slip: 0.4, pip: 0.01 },
};
const ZONE_ENTRY_DEPTH: Record<string, number> = { "EUR/USD": 0.5, "AUD/USD": 0.5 };
const DEPTH = { m5: 1440, m15: 480, h1: 120, h4: 300, d1: 260, w1: 52 };

/** Pre-registered horizons, in minutes. No others are evaluated. */
export const HORIZONS_MIN = [15, 30, 60, 120, 240, 480, 720, 1440] as const;
const WALK_CAP_MIN = 1440;

/** Series as it existed AT tMs — forming bar rebuilt, final OHLC never read. */
function seriesAt(bars: Candle[], sub: Candle[], tMs: number, depth: number,
                  cursor: { i: number }): Candle[] {
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

/** Wilder ATR(14) on the causal series. Used only as a distance scale. */
function atr14(c: Candle[]): number | null {
  if (c.length < 15) return null;
  let sum = 0;
  for (let i = c.length - 14; i < c.length; i++) {
    const tr = Math.max(c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    sum += tr;
  }
  return sum / 14;
}

export interface R2Cand {
  symbol: string; t: string; session: string; direction: "long" | "short";
  zoneScore: number; confluence: number; zoneTF: string | null;
  entryPrice: number; entrySource: "unified" | "refinedEntry" | "zoneMid";
  zoneLow: number; zoneHigh: number;
  lastPrice: number; distPips: number; distAtrH1: number | null; atrH1: number | null;
  /** minutes to first tradeable 1m touch of entryPrice; null = not within 24h */
  touchMin: number | null;
  /** false when the 1m tape does not cover the full 24h window after t */
  windowComplete: boolean;
}

const sessionOf = (iso: string) => {
  const h = new Date(iso).getUTCHours();
  return h < 7 ? "ASIA" : h < 12 ? "LONDON" : h < 16 ? "OVERLAP" : h < 21 ? "NEWYORK" : "OFF";
};

if (import.meta.main) {
  const only = Deno.args[0];
  const dirCfg = buildDirectionConfig({});

  for (const sym of (only ? [only] : PRODUCTION_UNIVERSE)) {
    const out = new URL(`./.cache/r2c_${sym.replace("/", "")}.json`, import.meta.url);
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

    const cands: R2Cand[] = [];
    const cur = { m5: { i: 0 }, m15: { i: 0 }, h1: { i: 0 }, h4: { i: 0 }, d1: { i: 0 }, w1: { i: 0 } };
    let nRoute1 = 0, nEval = 0;
    const t0 = Date.now();

    for (let k = 0; k < m1.length; k++) {
      const tMs = m1t[k];
      if (tMs < secFrom || tMs > to) continue;
      if (new Date(tMs).getUTCMinutes() % SCAN_INTERVAL_MIN !== 0) continue;
      if (!tradeableAt(sym, tMs)) continue;       // production does not scan a closed market
      nEval++;

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
          htfFibLevels4H: htf.htfFibLevels4H, htfFibLevelsD: htf.htfFibLevelsD,
          htfPD4H: htf.htfPD4H,
        } as never),
        liquidityPools: htf.combinedLiquidityPools,
        minSlPips: floor, maxSlPips: floor * SL_CAP_MULT, tpRatio: TP_RATIO,
        entryDepth: ZONE_ENTRY_DEPTH[sym], pipSize: pip,
        strictATRMult: undefined, fibMaxRetracement: undefined,
        originOBRetest: undefined, impulseZoneEnabled: true,
      });
      const bz = (z.impulseZone as never as { bestZone?: Record<string, unknown> } | null)?.bestZone;
      if (!z.unified?.hasZone || !bz) continue;

      const zoneScore = Number(bz.totalScore ?? NaN);
      if (!(zoneScore >= MIN_ZONE_SCORE)) continue;

      const conf = runConfluenceAnalysis(
        s.candles, s.dailyCandles.length >= 10 ? s.dailyCandles : null,
        { tradingStyle: { mode: "scalper" }, entryTimeframe: "5m",
          minConfluence: MIN_CONFLUENCE, tpRatio: TP_RATIO },
        s.hourlyCandles.length ? s.hourlyCandles : undefined, tMs,
      ) as { score?: number };
      const confluence = conf?.score ?? null;
      if (!(confluence !== null && confluence >= MIN_CONFLUENCE)) continue;

      // ── Route 1 arming (bot-scanner:7395-7400). Armed => Route 1, not Route 2.
      const zh = Number(bz.high), zl = Number(bz.low), zw = zh - zl;
      const layer3 = direction === "long" ? lastPrice <= zh + zw * 2 : lastPrice >= zl - zw * 2;
      const armed = bz.priceAtZoneStrict === true && bz.sideOk === true && layer3;
      if (armed) { nRoute1++; continue; }

      // ── PENDING_CREATED: entry price by production precedence ──
      const u = z.unified as unknown as {
        hasZone?: boolean; state?: string;
        confirmation?: { entryReady?: boolean }; entry?: { entryPrice?: number };
      };
      const unifiedGatePassed = u?.hasZone === true &&
        (u.state === "triggered" || u.state === "confirmed") &&
        u.confirmation?.entryReady === true;
      let entryPrice: number, entrySource: R2Cand["entrySource"];
      if (unifiedGatePassed && typeof u.entry?.entryPrice === "number") {
        entryPrice = u.entry.entryPrice; entrySource = "unified";
      } else if (typeof bz.refinedEntry === "number") {
        entryPrice = bz.refinedEntry as number; entrySource = "refinedEntry";
      } else {
        entryPrice = (zh + zl) / 2; entrySource = "zoneMid";
      }
      if (!Number.isFinite(entryPrice)) continue;

      const a = atr14(s.hourlyCandles);
      const dist = Math.abs(entryPrice - lastPrice);

      // ── PURE REACHABILITY on the 1m tape ──
      let lo = 0, hi = m1t.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (m1t[m] < tMs) lo = m + 1; else hi = m; }
      let touchMin: number | null = null;
      for (let j = lo; j < m1.length; j++) {
        const el = Math.round((m1t[j] - tMs) / 60_000);
        if (el > WALK_CAP_MIN) break;
        if (!tradeableAt(sym, m1t[j])) continue;
        const b = m1[j];
        if (direction === "long" ? b.low <= entryPrice : b.high >= entryPrice) { touchMin = el; break; }
      }

      cands.push({
        symbol: sym, t: new Date(tMs).toISOString(), session: sessionOf(new Date(tMs).toISOString()),
        direction, zoneScore, confluence, zoneTF: z.unified.selectedTF ?? null,
        entryPrice, entrySource, zoneLow: zl, zoneHigh: zh,
        lastPrice, distPips: dist / pip, distAtrH1: a ? dist / a : null, atrH1: a,
        touchMin, windowComplete: tapeEnd - tMs >= WALK_CAP_MIN * 60_000,
      });
    }

    Deno.writeTextFileSync(out, JSON.stringify(cands));
    console.log(`${sym}: ${nEval} scans, ${nRoute1} route1-armed, ${cands.length} ROUTE2 candidates, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
