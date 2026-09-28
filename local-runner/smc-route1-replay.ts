/**
 * SMC_IMPULSE_ZONE_ROUTE1_CORPUS_V1 — Route 1 causal replay. RESEARCH ONLY.
 *
 * Supersedes smc-zone-replay.ts. Three corrections, one of which is a real
 * lookahead defect in that run:
 *
 *  1. FORMING-BAR RECONSTRUCTION (the defect). Bars are stamped at their OPEN.
 *     The prior harness sliced with `datetime <= t`, so at a 10:05 scan the
 *     15m bar stamped 10:00 was admitted with its COMPLETE OHLC through
 *     10:14 — ten minutes of future data, and up to 55 min on 1H, ~23h on
 *     Daily. The A-vs-B causality test could not catch it because both arms
 *     used the same contaminated slice. Here every timeframe is rebuilt as it
 *     existed AT the scan instant.
 *
 *  2. ROUTE 1 ONLY, at the production entry price. marketEntryPrice =
 *     analysis.lastPrice = the 5m series' last close at the scan instant, not
 *     the next 1m open and not any zone level.
 *
 *  3. PRODUCTION PARAMETERS. STYLE_OVERRIDES.scalper: tpRatio 2.0 (the prior
 *     run used 1.5), impulseSlCapMultiplier 1.5 (prior used 4),
 *     scanIntervalMinutes 5, minConfluence 40.
 *
 * Confluence is the real production function with historical `atMs` injected.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-net \
 *     local-runner/smc-route1-replay.ts [SYMBOL]
 */

import { decideDirection, buildDirectionConfig } from "../supabase/functions/_shared/smcDirectionDecision.ts";
import { buildHtfContext } from "../supabase/functions/_shared/smcHtfContext.ts";
import { decideZone, hasMinZoneCandles, buildHtfConfluence } from "../supabase/functions/_shared/smcZoneDecision.ts";
import { runConfluenceAnalysis } from "../supabase/functions/_shared/confluenceScoring.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { loadCorpus, SYMBOLS, WINDOWS } from "./smc-corpus-fetch.ts";
import { COSTS } from "./smc-zone-replay.ts";

// ── frozen production parameters (STYLE_OVERRIDES.scalper + live config) ─────
const SCAN_INTERVAL_MIN = 5;
const TP_RATIO = 2.0;
const SL_CAP_MULT = 1.5;
const MIN_CONFLUENCE = 40;
const MIN_ZONE_SCORE = 4;
const MIN_SL_PIPS: Record<string, number> = {
  "EUR/USD": 20, "USD/JPY": 25, "GBP/USD": 25,
  "AUD/USD": 18, "NZD/USD": 18, "USD/CAD": 18, "USD/CHF": 18,
};
const ZONE_ENTRY_DEPTH: Record<string, number> = { "EUR/USD": 0.5, "AUD/USD": 0.5 };
const DEPTH = { m5: 1440, m15: 480, h1: 120, h4: 300, d1: 260, w1: 52 };

/**
 * The series as it existed AT `tMs`.
 *
 * A bar is CLOSED when the next bar has opened at or before t — derived from
 * the neighbouring stamp rather than a fixed duration, so weekend gaps and
 * missing bars cannot mis-classify one. The bar currently in progress is
 * rebuilt from `sub`: open of its first sub-bar, running high/low, and the
 * latest sub-bar close. Its FINAL OHLC is never read.
 */
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
  // Binary-search the sub-bar window instead of rescanning the whole series:
  // `sub` is the 1m corpus (260k bars) and a linear scan per call made the
  // run intractable (~1.3e10 comparisons).
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

export interface R1Row {
  symbol: string; t: string; window: string; session: string;
  stage: string; reject: string;
  direction: "long" | "short" | null;
  zoneScore: number | null; confluence: number | null; selectedTF: string | null;
  insideZone: boolean; strict: boolean; sideOk: boolean; layer3: boolean; armed: boolean;
  zoneEntryReference: number | null; lastPrice: number | null;
  refDiffPips: number | null; refDiffR: number | null;
  entry: number | null; sl: number | null; tp: number | null; riskPips: number | null;
  exitTime: string | null; exitPrice: number | null; exitReason: string;
  grossR: number | null; costR: number | null; netR: number | null;
  holdMinutes: number | null; ambiguous: boolean;
  entryAltNextOpen: number | null; netRAltNextOpen: number | null;
}

const sessionOf = (iso: string) => {
  const h = new Date(iso).getUTCHours();
  return h < 7 ? "ASIA" : h < 12 ? "LONDON" : h < 16 ? "OVERLAP" : h < 21 ? "NEWYORK" : "OFF";
};

if (import.meta.main) {
  const only = Deno.args[0];
  const dirCfg = buildDirectionConfig({});

  for (const sym of (only ? [only] : SYMBOLS)) {
    const out = new URL(`./.cache/r1_${sym.replace("/", "")}.json`, import.meta.url);
    try { Deno.readTextFileSync(out); console.log(`${sym}: cached`); continue; } catch { /* run */ }

    const m1 = loadCorpus(sym, "1m"), m5 = loadCorpus(sym, "5m"), m15 = loadCorpus(sym, "15m");
    const h1 = loadCorpus(sym, "1h"), h4 = loadCorpus(sym, "4h");
    const d1 = loadCorpus(sym, "1d"), w1 = loadCorpus(sym, "1w");
    if (!m1.length || !m5.length) { console.log(`${sym}: NO CORPUS`); continue; }

    const cost = COSTS[sym], pip = cost.pip;
    const half = (cost.spread / 2) * pip, slip = cost.slip * pip;
    const floor = MIN_SL_PIPS[sym] ?? 15;
    const secFrom = Date.parse(WINDOWS.secondary.from), priFrom = Date.parse(WINDOWS.primary.from);
    const to = Date.parse(WINDOWS.secondary.to) + 86_400_000;

    const rows: R1Row[] = [];
    const cur = { m5: { i: 0 }, m15: { i: 0 }, h1: { i: 0 }, h4: { i: 0 }, d1: { i: 0 }, w1: { i: 0 } };
    let openUntil = 0, mi = 0;
    const t0 = Date.now();

    // Scan every SCAN_INTERVAL_MIN minutes on the 1m grid.
    for (let k = 0; k < m1.length; k++) {
      const tMs = Date.parse(m1[k].datetime);
      if (tMs < secFrom || tMs > to) continue;
      if (new Date(tMs).getUTCMinutes() % SCAN_INTERVAL_MIN !== 0) continue;
      while (mi < m1.length && Date.parse(m1[mi].datetime) < tMs) mi++;

      const s = {
        candles: seriesAt(m5, m1, tMs, DEPTH.m5, cur.m5),
        m15Candles: seriesAt(m15, m1, tMs, DEPTH.m15, cur.m15),
        hourlyCandles: seriesAt(h1, m1, tMs, DEPTH.h1, cur.h1),
        h4Candles: seriesAt(h4, h1, tMs, DEPTH.h4, cur.h4),
        dailyCandles: seriesAt(d1, h1, tMs, DEPTH.d1, cur.d1),
        weeklyCandles: seriesAt(w1, h1, tMs, DEPTH.w1, cur.w1),
      };
      const iso = new Date(tMs).toISOString();
      const row: R1Row = {
        symbol: sym, t: iso, window: tMs >= priFrom ? "primary" : "secondary_only",
        session: sessionOf(iso), stage: "evaluated", reject: "",
        direction: null, zoneScore: null, confluence: null, selectedTF: null,
        insideZone: false, strict: false, sideOk: false, layer3: false, armed: false,
        zoneEntryReference: null, lastPrice: null, refDiffPips: null, refDiffR: null,
        entry: null, sl: null, tp: null, riskPips: null,
        exitTime: null, exitPrice: null, exitReason: "",
        grossR: null, costR: null, netR: null, holdMinutes: null, ambiguous: false,
        entryAltNextOpen: null, netRAltNextOpen: null,
      };
      if (s.candles.length < 200) { row.reject = "INSUFFICIENT_HISTORY"; continue; }

      const dir = decideDirection({ style: "scalper", series: s, dirConfig: dirCfg, useSimpleDirection: true });
      const direction = dir.overrideDirection;
      if (!direction || !hasMinZoneCandles("scalper", s)) { row.reject = "NO_DIRECTION"; rows.push(row); continue; }
      row.direction = direction; row.stage = "direction_pass";

      const htf = buildHtfContext({
        style: "scalper", m15Candles: s.m15Candles, hourlyCandles: s.hourlyCandles,
        h4Candles: s.h4Candles, dailyCandles: s.dailyCandles,
        equalHighsLowsSensitivity: undefined, liquidityPoolMinTouches: undefined,
      });
      const lastPrice = s.candles[s.candles.length - 1].close;
      row.lastPrice = lastPrice;

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
      if (!z.unified?.hasZone || !bz) { row.reject = "NO_ZONE"; rows.push(row); continue; }
      row.stage = "zone_found";
      row.selectedTF = z.unified.selectedTF ?? null;
      row.zoneScore = Number(bz.totalScore ?? NaN);
      row.zoneEntryReference = z.unified.entry?.entryPrice ?? null;

      // Zone Score Gate (bot-scanner:6186)
      if (!(row.zoneScore >= MIN_ZONE_SCORE)) { row.reject = "ZONE_SCORE_LT_4"; rows.push(row); continue; }
      row.stage = "zone_score_pass";

      // Gate 9 — min confluence, the production function with historical atMs.
      const conf = runConfluenceAnalysis(
        s.candles, s.dailyCandles.length >= 10 ? s.dailyCandles : null,
        { tradingStyle: { mode: "scalper" }, entryTimeframe: "5m",
          minConfluence: MIN_CONFLUENCE, tpRatio: TP_RATIO },
        s.hourlyCandles.length ? s.hourlyCandles : undefined, tMs,
      ) as { score?: number };
      row.confluence = conf?.score ?? null;
      if (!(row.confluence !== null && row.confluence >= MIN_CONFLUENCE)) {
        row.reject = "CONFLUENCE_LT_40"; rows.push(row); continue;
      }
      row.stage = "confluence_pass";

      // ── ROUTE 1 arming (bot-scanner:7395-7400) ──
      row.insideZone = bz.priceInsideZone === true;
      row.strict = bz.priceAtZoneStrict === true;
      row.sideOk = bz.sideOk === true;
      const zh = Number(bz.high), zl = Number(bz.low), zw = zh - zl;
      row.layer3 = direction === "long" ? lastPrice <= zh + zw * 2 : lastPrice >= zl - zw * 2;
      row.armed = row.strict && row.sideOk && row.layer3;
      if (!row.armed) { row.reject = "NOT_ROUTE1_ARMED"; rows.push(row); continue; }
      row.stage = "ROUTE1_ARMED";

      if (tMs < openUntil) { row.reject = "BLOCKED_BY_EXISTING_POSITION"; rows.push(row); continue; }

      // ── entry = production marketEntryPrice = analysis.lastPrice ──
      const long = direction === "long";
      const entry = lastPrice + (long ? half + slip : -(half + slip));
      // ROUTE 1 DOES NOT USE EntryStory. Production's market route takes
      // `sl`/`tp` from the scanner pipeline after its overrides, while the
      // entry is `analysis.lastPrice`. An earlier version of this harness
      // mixed EntryStory.executable.tpPrice with a lastPrice entry, which left
      // 111 of 222 trades with a target that was not tpRatio x their actual
      // risk. Stop = zone far edge floored by MIN_SL_PIPS; target = entry
      // +/- risk * tpRatio, which is the scanner's own construction.
      const sl = long ? Math.min(zl, entry - floor * pip) : Math.max(zh, entry + floor * pip);
      const riskPx = Math.abs(entry - sl);
      if (!(riskPx > 0)) { row.reject = "NON_POSITIVE_RISK"; rows.push(row); continue; }
      const flooredRisk = Math.max(riskPx, floor * pip);
      const slFinal = long ? entry - flooredRisk : entry + flooredRisk;
      const tp = long ? entry + flooredRisk * TP_RATIO : entry - flooredRisk * TP_RATIO;
      // SL sanity guard (bot-scanner:7684)
      if (long ? entry <= slFinal : entry >= slFinal) { row.reject = "SL_SANITY"; rows.push(row); continue; }

      row.entry = entry; row.sl = slFinal; row.tp = tp;
      row.riskPips = flooredRisk / pip;
      if (row.zoneEntryReference !== null) {
        row.refDiffPips = (lastPrice - row.zoneEntryReference) / pip;
        row.refDiffR = (lastPrice - row.zoneEntryReference) / flooredRisk;
      }
      row.entryAltNextOpen = mi < m1.length ? m1[mi].open + (long ? half + slip : -(half + slip)) : null;

      // ── exit ordering on the 1m tape, from the bar AFTER the scan instant ──
      let done = false;
      for (let i = mi; i < m1.length; i++) {
        const b = m1[i];
        const hitTp = long ? b.high >= tp : b.low <= tp;
        const hitSl = long ? b.low <= slFinal : b.high >= slFinal;
        if (hitTp && hitSl) {
          row.ambiguous = true; row.exitReason = "AMBIGUOUS_SAME_MINUTE";
          row.exitTime = b.datetime; row.stage = "AMBIGUOUS"; done = true; break;
        }
        if (hitTp || hitSl) {
          const px = hitTp ? tp : slFinal;
          const g = (long ? px - entry : entry - px) / flooredRisk;
          row.exitTime = b.datetime; row.exitPrice = px;
          row.exitReason = hitTp ? "TP" : "SL";
          row.grossR = g;
          row.costR = (2 * (half + slip)) / flooredRisk;
          row.netR = g - row.costR;
          row.holdMinutes = Math.round((Date.parse(b.datetime) - tMs) / 60_000);
          row.stage = "TRADE_TAKEN";
          openUntil = Date.parse(b.datetime);
          if (row.entryAltNextOpen !== null) {
            const ra = Math.abs(row.entryAltNextOpen - slFinal);
            if (ra > 0) {
              const ga = (long ? px - row.entryAltNextOpen : row.entryAltNextOpen - px) / ra;
              row.netRAltNextOpen = ga - (2 * (half + slip)) / ra;
            }
          }
          done = true; break;
        }
      }
      if (!done) { row.stage = "OPEN_AT_END"; row.ambiguous = true; row.exitReason = "OPEN_AT_CORPUS_END"; }
      rows.push(row);
    }

    Deno.writeTextFileSync(out, JSON.stringify(rows));
    const taken = rows.filter((r) => r.stage === "TRADE_TAKEN").length;
    console.log(`${sym}: ${rows.length} evaluations, ${taken} Route1 trades, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
