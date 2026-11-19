/**
 * IMPULSE_STRETCH_PREREG_V1 (docs/IMPULSE_STRETCH_PREREG_V1.md) — the SMC replay with the OWNER's
 * Bot Config and live series depths, two arms:
 *   base   : findImpulseLeg reaches back to older origins / breaks when the nearest origin was
 *            closed through (current live code).
 *   strict : setImpulseOriginFallback(false) — a closed-through origin means no leg.
 * Live-parity settings (see replay-used-default-config / decision parity 98–99%):
 *   direction = buildDirectionConfig(owner strategy); TP 2.0R, SL cap 1.5× floor (scalper overrides);
 *   fibMaxRetracement / EQ-H/L 3 / liquidity touches from the owner config; close-based breaks (default);
 *   weekend bars dropped like bot-scanner (depth + allowance, then drop, then the live LIMIT);
 *   series depth = live LIMIT (300; 4h 800 → last 300), forming bar rebuilt from closed 5m bars.
 * Execution, costs, guards: weekend-bars-replay.ts unchanged. RESEARCH ONLY.
 *
 *   deno run --allow-read --allow-write --allow-env local-runner/impulse-stretch-replay.ts <is|oos> <base|strict> [SYMBOL]
 */

import { decideDirection, buildDirectionConfig } from "../supabase/functions/_shared/smcDirectionDecision.ts";
import { buildHtfContext } from "../supabase/functions/_shared/smcHtfContext.ts";
import { decideZone, hasMinZoneCandles, buildHtfConfluence } from "../supabase/functions/_shared/smcZoneDecision.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { loadCorpus, SYMBOLS, WINDOWS } from "./smc-corpus-fetch.ts";
import { loadOos } from "./oosCorpus.ts";
import { dropFxClosedBars, isFxClosedAt } from "../supabase/functions/_shared/sessions.ts";
import { weekendAllowance } from "../supabase/functions/_shared/fxWeekendBars.ts";
import { setImpulseOriginFallback } from "../supabase/functions/_shared/impulseZoneEngine.ts";
import { MIN_SL_PIPS as LIVE_MIN_SL_PIPS } from "../supabase/functions/_shared/smcAnalysis.ts";

const MIN = 60_000;
const TF_MS = { m5: 5 * MIN, m15: 15 * MIN, h1: 60 * MIN, h4: 240 * MIN, d1: 1440 * MIN, w1: 7 * 1440 * MIN };

/**
 * Live-style series: the last `n` bars with start <= T, where a bar still forming at T is rebuilt
 * from the 5m bars CLOSED by T (bot-scanner fetches the forming bar too). No lookahead.
 */
function liveCursor(bars: Candle[], durMs: number, m5: Candle[], m5Starts: number[]) {
  const starts = bars.map((b) => Date.parse(b.datetime));
  let end = 0;   // bars[0 .. end) start <= T
  return (T: number, n: number, m5End: number): Candle[] => {
    while (end < bars.length && starts[end] <= T) end++;
    const out = bars.slice(Math.max(0, end - n), end);
    if (!out.length) return out;
    const fs = starts[end - 1];
    if (fs + durMs > T) {
      // m5[0 .. m5End) have closed by T; take those inside the forming bar.
      let k = m5End - 1, h = -Infinity, l = Infinity, c = NaN, o = NaN;
      while (k >= 0 && m5Starts[k] >= fs) { const b = m5[k]; if (Number.isNaN(c)) c = b.close; h = Math.max(h, b.high); l = Math.min(l, b.low); o = b.open; k--; }
      if (Number.isNaN(c)) out.pop();             // nothing traded in it yet
      else out[out.length - 1] = { ...out[out.length - 1], open: o, high: h, low: l, close: c };
    }
    return out;
  };
}

/** FROZEN cost model. One-way, in pips. Set before any result was seen. */
export const COSTS: Record<string, { spread: number; slip: number; pip: number }> = {
  "EUR/USD": { spread: 0.6, slip: 0.2, pip: 0.0001 },
  "GBP/USD": { spread: 0.9, slip: 0.3, pip: 0.0001 },
  "AUD/USD": { spread: 0.8, slip: 0.3, pip: 0.0001 },
  "NZD/USD": { spread: 1.2, slip: 0.3, pip: 0.0001 },
  "USD/CAD": { spread: 1.0, slip: 0.3, pip: 0.0001 },
  "USD/CHF": { spread: 1.0, slip: 0.3, pip: 0.0001 },
  "USD/JPY": { spread: 0.7, slip: 0.2, pip: 0.01 },
};

/** Owner config (bot_configs saved 2026-11-17 02:06) + scalper STYLE_OVERRIDES: TP 2.0R, cap 1.5. */
const OWNER = JSON.parse(Deno.readTextFileSync(new URL("./.cache/parity/bot_config.json", import.meta.url)));
const ST = OWNER.strategy;
const TP_RATIO = 2.0;
/**
 * Production stop floor, from smcAnalysis MIN_SL_PIPS via
 * bot-scanner resolveStaticFloorPips (fallback 15).
 *
 * The ATR second layer is NOT applied: `atrForConsumers` is gated on
 * `atrDerivedFloorsEnabled === true`, that key is absent from the live config,
 * so production feeds the zone engine a zero ATR and only the static floor
 * binds. An earlier run of this harness passed 1 pip here and produced a 6%
 * win rate with a 0-minute median hold — the stop sat inside the spread.
 */
const MIN_SL_PIPS: Record<string, number> = {
  "EUR/USD": 20, "USD/JPY": 25, "GBP/USD": 25,
  "AUD/USD": 18, "NZD/USD": 18, "USD/CAD": 18, "USD/CHF": 18,
};
const LIVE_MIN_TP_PIPS: Record<string, number> = {   // bot-scanner MIN_TP_PIPS
  "EUR/USD": 15, "USD/JPY": 20, "GBP/USD": 20, "AUD/USD": 15, "NZD/USD": 15, "USD/CAD": 15, "USD/CHF": 15,
};
const SL_CAP_MULT = 1.5;        // scalper STYLE_OVERRIDES impulseSlCapMultiplier (owner: legacy overrides)
const LIMIT = { m5: 300, m15: 300, h1: 300, h4: 800, d1: 300, w1: 300 };   // bot-scanner fetch sizes

export interface Setup {
  symbol: string; t: string; window: string;
  direction: "long" | "short";
  state: string; selectedTF: string | null;
  zoneHigh: number | null; zoneLow: number | null;
  impulseOrigin: number | null; zoneId: string;
  unifiedScore: number | null;
  entryPrice: number | null; slPrice: number | null; tpPrice: number | null;
  riskPips: number | null;
  route: "MARKET" | "LIMIT" | "NONE";
  outcome: string;
  fillTime: string | null; fillPrice: number | null;
  exitTime: string | null; exitPrice: number | null; exitReason: string;
  grossR: number | null; costR: number | null; netR: number | null;
  holdMinutes: number | null; session: string;
  ambiguous: boolean; ambiguityReason: string;
  // BREAK_STRENGTH: the unified impulse's leg quality (null when the engine did not report it)
  bosClose: number | null; originClose: number | null; bosWick: number | null; legStrength: string | null;
  impStart: string | null; impEnd: string | null; impTerminus: number | null;
}

const sessionOf = (iso: string): string => {
  const h = new Date(iso).getUTCHours();
  if (h >= 0 && h < 7) return "ASIA";
  if (h >= 7 && h < 12) return "LONDON";
  if (h >= 12 && h < 16) return "OVERLAP";
  if (h >= 16 && h < 21) return "NEWYORK";
  return "OFF";
};

/** Stable zone identity: symbol, TF, direction, impulse origin and bounds. */
const zoneKey = (sym: string, tf: string | null, dir: string,
                 origin: number | null, hi: number | null, lo: number | null) =>
  `${sym}|${tf ?? "-"}|${dir}|${origin?.toFixed(5) ?? "-"}|${hi?.toFixed(5) ?? "-"}|${lo?.toFixed(5) ?? "-"}`;

/** First 1m bar strictly after `tMs`. Entry is never on the decision bar. */
function nextMinuteIdx(m1: Candle[], tMs: number): number {
  let lo = 0, hi = m1.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (Date.parse(m1[mid].datetime) <= tMs) lo = mid + 1; else hi = mid; }
  return lo;
}

if (import.meta.main) {
  const corpus = Deno.args[0], arm = Deno.args[1];
  if ((corpus !== "is" && corpus !== "oos") || (arm !== "base" && arm !== "strict"))
    throw new Error("usage: impulse-stretch-replay.ts <is|oos> <base|strict> [SYMBOL]");
  setImpulseOriginFallback(arm === "base");     // IMPULSE_STRETCH: the one change
  const only = Deno.args[2];
  const syms = only ? [only] : SYMBOLS;
  const dirCfg = buildDirectionConfig(ST);      // owner direction settings (lookbacks 96 …)
  const load = corpus === "is" ? loadCorpus : loadOos;
  const W = corpus === "is"
    ? { from: WINDOWS.secondary.from, to: WINDOWS.secondary.to, mid: "2026-06-27" }
    : { from: "2024-03-01", to: "2025-12-24", mid: "2025-01-01" };

  for (const sym of syms) {
    const out = new URL(`./.cache/stretch_${corpus}_${arm}_setups_${sym.replace("/", "")}.json`, import.meta.url);
    try { Deno.readTextFileSync(out); console.log(`${sym}: cached`); continue; } catch { /* run */ }

    // Execution tape without weekend bars: 1m (IS) / 5m (OOS, no 1m exists).
    const m1 = load(sym, corpus === "is" ? "1m" : "5m").filter((b) => !isFxClosedAt(Date.parse(b.datetime)));
    const m5 = load(sym, "5m");
    const m15 = load(sym, "15m"), h1 = load(sym, "1h");
    const h4 = load(sym, "4h"), d1 = load(sym, "1d"), w1 = load(sym, "1w");
    if (!m5.length || !m1.length) { console.log(`${sym}: NO CORPUS`); continue; }
    const m5Starts = m5.map((b) => Date.parse(b.datetime));

    const cost = COSTS[sym];
    const secFrom = Date.parse(W.from), priFrom = Date.parse(W.mid);
    const to = Date.parse(W.to) + 86_400_000;

    const setups: Setup[] = [];
    const zoneSeen = new Map<string, string>();
    const zoneDead = new Set<string>();
    let openUntil = 0;
    let evaluated = 0;
    const t0 = Date.now();
    const cur = {
      m5: liveCursor(m5, TF_MS.m5, m5, m5Starts), m15: liveCursor(m15, TF_MS.m15, m5, m5Starts),
      h1: liveCursor(h1, TF_MS.h1, m5, m5Starts), h4: liveCursor(h4, TF_MS.h4, m5, m5Starts),
      d1: liveCursor(d1, TF_MS.d1, m5, m5Starts), w1: liveCursor(w1, TF_MS.w1, m5, m5Starts),
    };
    // bot-scanner: fetch LIMIT (+ weekend allowance), drop FX-closed bars, keep the last LIMIT.
    const live = (c: (T: number, n: number, e: number) => Candle[], tf: string, lim: number, T: number, e: number) =>
      dropFxClosedBars(c(T, lim + weekendAllowance(tf, lim), e), true).slice(-lim);

    for (let bi = 0; bi < m5.length; bi++) {
      const bar = m5[bi];
      const tMs = m5Starts[bi];
      if (tMs < secFrom || tMs > to) continue;
      if (isFxClosedAt(tMs)) continue;
      const decisionMs = tMs + TF_MS.m5;           // this 5m bar's close — no lookahead
      const e5 = bi + 1;                           // m5[0 .. bi] closed by decisionMs
      const T = decisionMs - 1;                    // bars starting at the decision instant are not formed yet
      evaluated++;
      const s = {
        candles: live(cur.m5, "5m", LIMIT.m5, T, e5),
        m15Candles: live(cur.m15, "15m", LIMIT.m15, T, e5),
        hourlyCandles: live(cur.h1, "1h", LIMIT.h1, T, e5),
        h4Candles: live(cur.h4, "4h", LIMIT.h4, T, e5).slice(-300),
        dailyCandles: live(cur.d1, "1d", LIMIT.d1, T, e5),
        weeklyCandles: cur.w1(T, LIMIT.w1, e5),
      };
      if (s.candles.length < 100) continue;

      const dir = decideDirection({ style: "scalper", series: s, dirConfig: dirCfg, useSimpleDirection: true });
      const direction = dir.overrideDirection;
      if (!direction || !hasMinZoneCandles("scalper", s)) continue;

      const htf = buildHtfContext({
        style: "scalper", m15Candles: s.m15Candles, hourlyCandles: s.hourlyCandles,
        h4Candles: s.h4Candles, dailyCandles: s.dailyCandles,
        equalHighsLowsSensitivity: 3, liquidityPoolMinTouches: ST.liquidityPoolMinTouches ?? 2,
      });
      const lastPrice = s.candles[s.candles.length - 1].close;
      const staticFloor = LIVE_MIN_SL_PIPS[sym] ?? MIN_SL_PIPS[sym] ?? 15;
      const z = decideZone({
        symbol: sym, style: "scalper", series: s, direction, lastPrice,
        htfConfluence: buildHtfConfluence({
          direction, h4OBs: htf.h4OBs, h4FVGs: htf.h4FVGs, h4Breakers: htf.h4Breakers,
          htfFibLevels4H: htf.htfFibLevels4H, htfFibLevelsD: htf.htfFibLevelsD,
          htfPD4H: htf.htfPD4H,
        } as never),
        liquidityPools: htf.combinedLiquidityPools,
        minSlPips: staticFloor, maxSlPips: staticFloor * SL_CAP_MULT,
        tpRatio: TP_RATIO, entryDepth: undefined,
        pipSize: cost.pip, strictATRMult: undefined, fibMaxRetracement: ST.fibMaxRetracement,
        originOBRetest: undefined, impulseZoneEnabled: true,
      });
      const u = z.unified;
      if (!u || !u.hasZone) continue;

      const zid = zoneKey(sym, u.selectedTF, direction,
        (u.impulse as never as { origin?: number } | null)?.origin ?? null,
        (u.zone as never as { high?: number } | null)?.high ?? null,
        (u.zone as never as { low?: number } | null)?.low ?? null);
      if (!zoneSeen.has(zid)) zoneSeen.set(zid, bar.datetime);

      const base: Setup = {
        symbol: sym, t: bar.datetime,
        window: tMs >= priFrom ? "h2" : "h1",
        direction, state: u.state, selectedTF: u.selectedTF,
        zoneHigh: (u.zone as never as { high?: number } | null)?.high ?? null,
        zoneLow: (u.zone as never as { low?: number } | null)?.low ?? null,
        impulseOrigin: (u.impulse as never as { origin?: number } | null)?.origin ?? null,
        zoneId: zid, unifiedScore: u.unifiedScore,
        entryPrice: null, slPrice: null, tpPrice: null, riskPips: null,
        route: "NONE", outcome: "NO_ENTRY_TOUCH",
        fillTime: null, fillPrice: null, exitTime: null, exitPrice: null, exitReason: "",
        grossR: null, costR: null, netR: null, holdMinutes: null,
        session: sessionOf(bar.datetime), ambiguous: false, ambiguityReason: "",
        // BREAK_STRENGTH
        bosClose: (u.impulse as never as { candleQuality?: { bosCloseStrength?: number } } | null)?.candleQuality?.bosCloseStrength ?? null,
        originClose: (u.impulse as never as { candleQuality?: { originCloseStrength?: number } } | null)?.candleQuality?.originCloseStrength ?? null,
        bosWick: (u.impulse as never as { candleQuality?: { bosRejectionWick?: number } } | null)?.candleQuality?.bosRejectionWick ?? null,
        legStrength: (u.impulse as never as { displacement?: { strength?: string } } | null)?.displacement?.strength ?? null,
        impStart: (u.impulse as never as { startTime?: string } | null)?.startTime ?? null,
        impEnd: (u.impulse as never as { endTime?: string } | null)?.endTime ?? null,
        impTerminus: (u.impulse as never as { terminus?: number } | null)?.terminus ?? null,
      };

      const e = u.entry;
      if (!e || !e.executable) { setups.push(base); continue; }
      base.entryPrice = e.entryPrice;
      base.slPrice = e.executable.slPrice;
      base.tpPrice = e.executable.tpPrice;
      base.riskPips = e.executable.riskPips;
      base.route = u.state === "triggered" ? "MARKET" : "LIMIT";

      if (zoneDead.has(zid)) { base.outcome = "INVALIDATED_BEFORE_ENTRY"; setups.push(base); continue; }
      if (decisionMs < openUntil) { base.outcome = "BLOCKED_BY_EXISTING_POSITION"; setups.push(base); continue; }

      // ── execution on the 1m tape ──────────────────────────────────────────
      const start = nextMinuteIdx(m1, decisionMs - 1);   // first 1m bar starting at/after the decision
      if (start >= m1.length) { base.outcome = "DATA_UNRESOLVED"; base.ambiguous = true;
        base.ambiguityReason = "NO_1M_AFTER_DECISION"; setups.push(base); continue; }

      const long = direction === "long";
      const half = (cost.spread / 2) * cost.pip;
      const slip = cost.slip * cost.pip;

      let fillIdx = -1, fillPx = 0;
      if (base.route === "MARKET") {
        fillIdx = start;
        fillPx = m1[start].open + (long ? half + slip : -(half + slip));
      } else {
        // Pending limit at the zone entry price; production expiry is scaled by
        // style. Scalper cycle is short, so 60 minutes is used and stated.
        const expiry = decisionMs + 60 * 60_000;
        for (let i = start; i < m1.length && Date.parse(m1[i].datetime) <= expiry; i++) {
          const hit = long ? m1[i].low <= e.entryPrice : m1[i].high >= e.entryPrice;
          if (hit) { fillIdx = i; fillPx = e.entryPrice + (long ? half : -half); break; }
        }
      }
      if (fillIdx < 0) { base.outcome = "NO_ENTRY_TOUCH"; setups.push(base); continue; }

      base.fillTime = m1[fillIdx].datetime; base.fillPrice = fillPx;
      const sl = base.slPrice!, tp = base.tpPrice!;
      // LIVE PARITY (added 2026-11-17, all arms): live skips a market entry already past its stop
      // (skipped_sl_sanity) and a target under MIN_TP_PIPS from price (skipped_tp_too_small); live
      // measures its target from the live price, so it is never on the wrong side of the fill.
      // Without this, a fill high in a wide zone could "hit TP" below the fill, at a loss, instantly.
      const tpRoomPips = (long ? tp - fillPx : fillPx - tp) / cost.pip;
      const slRoom = long ? fillPx - sl : sl - fillPx;
      if (slRoom <= 0 || tpRoomPips < (LIVE_MIN_TP_PIPS[sym] ?? 12)) {
        base.outcome = "SKIPPED_LIVE_SANITY"; setups.push(base); continue;
      }
      const risk = Math.abs(fillPx - sl);
      if (!(risk > 0)) { base.outcome = "DATA_UNRESOLVED"; base.ambiguous = true;
        base.ambiguityReason = "NON_POSITIVE_RISK"; setups.push(base); continue; }

      let done = false;
      const scanFrom = base.route === "LIMIT" ? fillIdx + 1 : fillIdx;
      for (let i = scanFrom; i < m1.length; i++) {
        const b = m1[i];
        const hitTp = long ? b.high >= tp : b.low <= tp;
        const hitSl = long ? b.low <= sl : b.high >= sl;
        if (hitTp && hitSl) {
          // Both inside ONE minute. No finer tape exists, so the order is not
          // knowable and code precedence would be a fabrication.
          base.outcome = "AMBIGUOUS_EXECUTION"; base.ambiguous = true;
          base.ambiguityReason = "TP_AND_SL_IN_SAME_MINUTE";
          base.exitTime = b.datetime; done = true; break;
        }
        if (hitTp || hitSl) {
          const px = hitTp ? tp : sl;
          const gross = (long ? px - fillPx : fillPx - px) / risk;
          base.exitTime = b.datetime; base.exitPrice = px;
          base.exitReason = hitTp ? "TP" : "SL";
          base.grossR = gross;
          base.costR = (2 * (half + slip)) / risk;
          base.netR = gross - base.costR;
          base.holdMinutes = Math.round((Date.parse(b.datetime) - Date.parse(m1[fillIdx].datetime)) / 60_000);
          base.outcome = "TRADE_TAKEN";
          openUntil = Date.parse(b.datetime);
          if (!hitTp) zoneDead.add(zid);     // stopped out: this zone is done
          done = true; break;
        }
      }
      if (!done) { base.outcome = "DATA_UNRESOLVED"; base.ambiguous = true;
        base.ambiguityReason = "OPEN_AT_CORPUS_END"; }
      setups.push(base);
    }

    Deno.writeTextFileSync(out, JSON.stringify(setups));
    const taken = setups.filter((x) => x.outcome === "TRADE_TAKEN").length;
    console.log(`${sym}: ${evaluated} bars, ${setups.length} setups, ${taken} trades, ` +
      `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
