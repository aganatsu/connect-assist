/**
 * SMC_ROUTE2_ZONE_STALENESS_AND_TTL_SELECTION_V1 — structural validity of the
 * original zone at pending creation and at the causal touch instant.
 *
 * All invalidation rules are PRODUCTION'S OWN, not invented here:
 *   impulse broken   zoneConfirmation.ts:525 isImpulseBroken
 *   zone close-through  zone-confirmation-scanner:390-392 (closed bar closes
 *                       through the distal edge); applied to the POI bounds
 *   direction flip      thesisValidator.ts:418 direction_flip
 *
 * Geometric tests (impulse / close-through) are evaluated continuously on the
 * 1m and 5m tape. Engine tests (direction flip, zone replacement) require a
 * full re-run and are evaluated at the touch instant only — stated, not hidden.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-net \
 *     local-runner/r2-staleness.ts [SYMBOL]
 */
import { decideDirection, buildDirectionConfig } from "../supabase/functions/_shared/smcDirectionDecision.ts";
import { buildHtfContext } from "../supabase/functions/_shared/smcHtfContext.ts";
import { decideZone, hasMinZoneCandles, buildHtfConfluence } from "../supabase/functions/_shared/smcZoneDecision.ts";
import { isImpulseBroken } from "../supabase/functions/_shared/zoneConfirmation.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { loadCorpus, PRODUCTION_UNIVERSE, WINDOWS, tradeableAt } from "./smc-corpus-fetch.ts";
import { COSTS } from "./smc-zone-replay.ts";
import { locatePoi } from "./r2-poi-locate.ts";
import type { GeoRow } from "./r2-geometry.ts";

const CAP = 1.5, TTL_MIN = 60, WALK_CAP = 1440;
const TP_RATIO = 2.0, SL_CAP_MULT = 1.5;
const MIN_SL_PIPS: Record<string, number> = {
  "EUR/USD": 20, "USD/JPY": 25, "GBP/USD": 25, "AUD/USD": 18, "NZD/USD": 18,
  "USD/CAD": 18, "USD/CHF": 18, "CHF/JPY": 25, "NZD/CAD": 20, "NZD/CHF": 20, "BTC/USD": 150,
};
const SPEC_COST: Record<string, { spread: number; slip: number; pip: number }> = {
  "CHF/JPY": { spread: 2.5, slip: 0.5, pip: 0.01 }, "NZD/CAD": { spread: 2.5, slip: 0.5, pip: 0.0001 },
  "NZD/CHF": { spread: 3.0, slip: 0.6, pip: 0.0001 }, "BTC/USD": { spread: 20.0, slip: 4.0, pip: 1 },
  "ETH/USD": { spread: 2.0, slip: 0.4, pip: 0.01 },
};
const ZONE_ENTRY_DEPTH: Record<string, number> = { "EUR/USD": 0.5, "AUD/USD": 0.5 };
const DEPTH = { m5: 1440, m15: 480, h1: 120, h4: 300, d1: 260, w1: 52 };

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

export interface StaleRow {
  symbol: string; t: string; direction: "long" | "short"; zoneTF: string | null;
  entryPrice: number; distAtrH1: number; poiHigh: number; poiLow: number;
  impulseHigh: number | null; impulseLow: number | null;
  zoneAgeMin: number;                    // POI formation -> pending creation
  touchMin: number | null;               // creation -> first touch (<=24h)
  zoneAgeAtTouchMin: number | null;
  /** validity at CREATION */
  createdImpulseBroken: boolean; createdClosedThrough: boolean;
  createdClass: "VALID" | "WEAKENED" | "INVALID" | "UNKNOWN";
  /** first post-creation geometric invalidation, minutes from creation */
  impulseBreakMin: number | null; closeThroughMin: number | null;
  /** engine re-run AT TOUCH */
  dirAtTouch: string | null; zonePresentAtTouch: boolean | null; zoneOverlapAtTouch: boolean | null;
  touchClass: "VALID_AT_TOUCH" | "WEAKENED_AT_TOUCH" | "INVALID_BEFORE_TOUCH" | "UNKNOWN" | null;
  touchFailReason: string | null;
}

if (import.meta.main) {
  const only = Deno.args[0];
  const dirCfg = buildDirectionConfig({});

  for (const sym of (only ? [only] : PRODUCTION_UNIVERSE)) {
    const out = new URL(`./.cache/r2s_${sym.replace("/", "")}.json`, import.meta.url);
    try { Deno.readTextFileSync(out); console.log(`${sym}: cached`); continue; } catch { /* run */ }

    const geo: GeoRow[] = JSON.parse(Deno.readTextFileSync(
      new URL(`./.cache/r2g_${sym.replace("/", "")}.json`, import.meta.url)));

    const m1 = loadCorpus(sym, "1m"), m5 = loadCorpus(sym, "5m"), m15 = loadCorpus(sym, "15m");
    const h1 = loadCorpus(sym, "1h"), h4 = loadCorpus(sym, "4h");
    const d1 = loadCorpus(sym, "1d"), w1 = loadCorpus(sym, "1w");
    const pip = (COSTS[sym] ?? SPEC_COST[sym]).pip;
    const floor = MIN_SL_PIPS[sym] ?? 15;
    const m1t = m1.map((b) => Date.parse(b.datetime));
    const m5t = m5.map((b) => Date.parse(b.datetime));

    // bounded candidates -> production orders (first accepted detection of a level)
    const capped = geo.filter((c) => c.windowComplete && Number.isFinite(c.distAtrH1) && c.distAtrH1 <= CAP);
    const g = new Map<string, GeoRow[]>();
    for (const c of capped) {
      const k = `${c.symbol}|${c.direction}|${c.entryPrice}`;
      (g.get(k) ?? g.set(k, []).get(k)!).push(c);
    }
    const orders: GeoRow[] = [];
    for (const [, rows] of g) {
      rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      let prev = -Infinity;
      for (const c of rows) {
        const t = Date.parse(c.t);
        if (t - prev > TTL_MIN * 60000) orders.push(c);
        prev = t;
      }
    }
    orders.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

    const cur = { m5: { i: 0 }, m15: { i: 0 }, h1: { i: 0 }, h4: { i: 0 }, d1: { i: 0 }, w1: { i: 0 } };
    const rows: StaleRow[] = [];
    const t0run = Date.now();

    for (const o of orders) {
      const tMs = Date.parse(o.t);
      const long = o.direction === "long";

      // ── zone age: locate the POI on its own timeframe ──
      const tfBars = o.zoneTF === "5m" ? m5 : o.zoneTF === "15m" ? m15 : h1;
      let last = -1;
      for (let i = 0; i < tfBars.length; i++) {
        const nxt = i + 1 < tfBars.length ? Date.parse(tfBars[i + 1].datetime) : Infinity;
        if (nxt <= tMs) last = i; else break;
      }
      const loc = last >= 3 ? locatePoi(tfBars, last, o.poiType, o.poiHigh, o.poiLow) : { idx: -1, how: "no_history" };
      const formMs = loc.idx >= 0 ? Date.parse(tfBars[loc.idx].datetime) : NaN;
      const zoneAgeMin = Number.isFinite(formMs) ? Math.round((tMs - formMs) / 60000) : NaN;

      // ── validity AT CREATION ──
      // impulse broken by spot right now
      const spot = o.lastPrice;
      const createdImpulseBroken = o.impulseHigh != null && o.impulseLow != null &&
        isImpulseBroken(spot, o.impulseHigh, o.impulseLow, o.direction);
      // has a CLOSED 5m bar closed through the distal edge since the POI formed?
      // Evaluated on the ZONE'S OWN timeframe. The engine's own mitigation
      // filter (impulseZoneEngine:684/707 fvg.state!=="filled",
      // ob.state!=="broken"/"mitigated") runs on that series, so testing 5m
      // closes here would contradict the engine rather than extend it.
      const tfT = tfBars.map((b) => Date.parse(b.datetime));
      let createdClosedThrough = false;
      if (Number.isFinite(formMs)) {
        for (let i = 0; i < tfBars.length; i++) {
          if (tfT[i] < formMs) continue;
          // Bars are stamped at OPEN. The close-through happens at the bar's
          // CLOSE, which is the next bar's open stamp. Dating it at tfT[i]
          // placed the event up to one full bar early — 59 minutes on a 1H
          // zone — and manufactured invalidations that preceded the touch.
          const closeMs = i + 1 < tfBars.length ? tfT[i + 1] : tfT[i];
          if (closeMs > tMs) break;
          if (!tradeableAt(sym, tfT[i])) continue;
          if (long ? tfBars[i].close < o.poiLow : tfBars[i].close > o.poiHigh) { createdClosedThrough = true; break; }
        }
      }
      const createdClass: StaleRow["createdClass"] = !Number.isFinite(zoneAgeMin) ? "UNKNOWN"
        : createdImpulseBroken ? "INVALID" : createdClosedThrough ? "WEAKENED" : "VALID";

      // ── post-creation geometric invalidation timing, up to 24h ──
      let ib: number | null = null, ct: number | null = null;
      let lo2 = 0, hi2 = m1t.length;
      while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (m1t[m] < tMs) lo2 = m + 1; else hi2 = m; }
      for (let j = lo2; j < m1.length; j++) {
        const el = Math.round((m1t[j] - tMs) / 60000);
        if (el > WALK_CAP) break;
        if (!tradeableAt(sym, m1t[j])) continue;
        if (ib === null && o.impulseHigh != null && o.impulseLow != null) {
          const px = long ? m1[j].low : m1[j].high;
          if (isImpulseBroken(px, o.impulseHigh, o.impulseLow, o.direction)) ib = el;
        }
        if (ib !== null) break;
      }
      for (let i = 0; i < tfBars.length; i++) {
        const closeMs = i + 1 < tfBars.length ? tfT[i + 1] : tfT[i];
        if (closeMs <= tMs) continue;
        const el = Math.round((closeMs - tMs) / 60000);   // dated at the CLOSE
        if (el > WALK_CAP) break;
        if (!tradeableAt(sym, tfT[i])) continue;
        if (long ? tfBars[i].close < o.poiLow : tfBars[i].close > o.poiHigh) { ct = el; break; }
      }

      // ── validity AT TOUCH ──
      let dirAtTouch: string | null = null, zonePresent: boolean | null = null,
          zoneOverlap: boolean | null = null;
      let touchClass: StaleRow["touchClass"] = null, reason: string | null = null;
      const tm = o.touchMin;
      if (tm !== null && tm <= WALK_CAP) {
        const t1 = tMs + tm * 60000;
        const brokeFirst = (ib !== null && ib < tm) || (ct !== null && ct < tm);
        if (brokeFirst) {
          touchClass = "INVALID_BEFORE_TOUCH";
          reason = (ib !== null && ib < tm) && (ct !== null && ct < tm)
            ? (ib <= ct ? "origin_broken" : "zone_close_through")
            : (ib !== null && ib < tm) ? "origin_broken" : "zone_close_through";
        } else {
          const s = {
            candles: seriesAt(m5, m1, t1, DEPTH.m5, cur.m5),
            m15Candles: seriesAt(m15, m1, t1, DEPTH.m15, cur.m15),
            hourlyCandles: seriesAt(h1, m1, t1, DEPTH.h1, cur.h1),
            h4Candles: seriesAt(h4, h1, t1, DEPTH.h4, cur.h4),
            dailyCandles: seriesAt(d1, h1, t1, DEPTH.d1, cur.d1),
            weeklyCandles: seriesAt(w1, h1, t1, DEPTH.w1, cur.w1),
          };
          if (s.candles.length < 200) { touchClass = "UNKNOWN"; reason = "insufficient_history"; }
          else {
            const dd = decideDirection({ style: "scalper", series: s, dirConfig: dirCfg, useSimpleDirection: true });
            dirAtTouch = dd.overrideDirection ?? null;
            if (dirAtTouch !== null && dirAtTouch !== o.direction) {
              // Genuine opposing verdict — production's direction_flip cancel.
              touchClass = "WEAKENED_AT_TOUCH"; reason = "direction_flip";
            } else if (dirAtTouch === null) {
              // thesisValidator:400 records "insufficient candles" and does NOT
              // cancel. The order stays live, so the thesis is not weakened.
              touchClass = "VALID_AT_TOUCH"; reason = "no_direction_verdict_order_kept";
            } else if (!hasMinZoneCandles("scalper", s)) {
              touchClass = "WEAKENED_AT_TOUCH"; reason = "no_zone_candles";
            } else {
              const htf = buildHtfContext({
                style: "scalper", m15Candles: s.m15Candles, hourlyCandles: s.hourlyCandles,
                h4Candles: s.h4Candles, dailyCandles: s.dailyCandles,
                equalHighsLowsSensitivity: undefined, liquidityPoolMinTouches: undefined,
              });
              const lp = s.candles[s.candles.length - 1].close;
              const z = decideZone({
                symbol: sym, style: "scalper", series: s, direction: o.direction, lastPrice: lp,
                htfConfluence: buildHtfConfluence({
                  direction: o.direction, h4OBs: htf.h4OBs, h4FVGs: htf.h4FVGs, h4Breakers: htf.h4Breakers,
                  htfFibLevels4H: htf.htfFibLevels4H, htfFibLevelsD: htf.htfFibLevelsD, htfPD4H: htf.htfPD4H,
                } as never),
                liquidityPools: htf.combinedLiquidityPools,
                minSlPips: floor, maxSlPips: floor * SL_CAP_MULT, tpRatio: TP_RATIO,
                entryDepth: ZONE_ENTRY_DEPTH[sym], pipSize: pip,
                strictATRMult: undefined, fibMaxRetracement: undefined,
                originOBRetest: undefined, impulseZoneEnabled: true,
              });
              const bz = (z.impulseZone as never as { bestZone?: Record<string, unknown> } | null)?.bestZone;
              zonePresent = !!(z.unified?.hasZone && bz);
              if (!zonePresent) { touchClass = "WEAKENED_AT_TOUCH"; reason = "zone_gone"; }
              else {
                const nh = Number(bz!.high), nl = Number(bz!.low);
                zoneOverlap = nh >= o.poiLow && nl <= o.poiHigh;
                if (zoneOverlap) touchClass = "VALID_AT_TOUCH";
                else { touchClass = "WEAKENED_AT_TOUCH"; reason = "zone_replaced"; }
              }
            }
          }
        }
      }

      rows.push({
        symbol: sym, t: o.t, direction: o.direction, zoneTF: o.zoneTF,
        entryPrice: o.entryPrice, distAtrH1: o.distAtrH1, poiHigh: o.poiHigh, poiLow: o.poiLow,
        impulseHigh: o.impulseHigh, impulseLow: o.impulseLow,
        zoneAgeMin, touchMin: tm, zoneAgeAtTouchMin: tm !== null && Number.isFinite(zoneAgeMin) ? zoneAgeMin + tm : null,
        createdImpulseBroken, createdClosedThrough, createdClass,
        impulseBreakMin: ib, closeThroughMin: ct,
        dirAtTouch, zonePresentAtTouch: zonePresent, zoneOverlapAtTouch: zoneOverlap,
        touchClass, touchFailReason: reason,
      });
    }

    Deno.writeTextFileSync(out, JSON.stringify(rows));
    console.log(`${sym}: ${rows.length} bounded orders, ${rows.filter((r) => r.touchMin !== null).length} touches, ${((Date.now() - t0run) / 1000).toFixed(0)}s`);
  }
}
