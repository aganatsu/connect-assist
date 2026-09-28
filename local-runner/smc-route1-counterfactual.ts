/**
 * SMC_ROUTE1_REJECTION_COUNTERFACTUAL_AUDIT_V1
 *
 * Asks whether each production rejection gate removes BAD trades or just
 * removes trades. For every scan instant it evaluates the whole chain without
 * stopping at the first failure, records each gate's verdict, and — for any
 * setup that would actually have ARMED Route 1 — simulates the trade it would
 * have become on the 1m tape.
 *
 * WHAT IS DIFFERENT FROM THE ROUTE1 BASELINE, DELIBERATELY:
 * confluence is computed with the FULL mapped live config
 * (`mapNestedToFlat(config_json)` + STYLE_OVERRIDES.scalper + pair overrides),
 * not the four-field config the baseline used. Under the full config G9
 * rejected 163 of the baseline's 216 supposedly-passing trades, so the
 * baseline funnel was not production-faithful. The funnel here will therefore
 * differ from that run, and this one is the correct version.
 *
 * NOT EVERY REJECTION IS COUNTERFACTUALLY MEANINGFUL:
 *   NO_DIRECTION / NO_ZONE cannot be bypassed — with no direction there is no
 *   side and with no zone there are no bounds, so no trade object exists.
 *   NOT_ROUTE1_ARMED is the route DEFINITION, not a gate; bypassing it would
 *   mean entering away from the zone, a different strategy.
 * Those are reported, never counted as forgone trades.
 *
 *   deno run --allow-read --allow-write --allow-env --allow-net \
 *     local-runner/smc-route1-counterfactual.ts [SYMBOL]
 */

import { runSafetyGates } from "../supabase/functions/bot-scanner/index.ts";
import { decideDirection, buildDirectionConfig } from "../supabase/functions/_shared/smcDirectionDecision.ts";
import { buildHtfContext } from "../supabase/functions/_shared/smcHtfContext.ts";
import { decideZone, hasMinZoneCandles, buildHtfConfluence } from "../supabase/functions/_shared/smcZoneDecision.ts";
import { runConfluenceAnalysis } from "../supabase/functions/_shared/confluenceScoring.ts";
import { mapNestedToFlat, applyPairOverrides } from "../supabase/functions/_shared/configMapper.ts";
import { calculateATR, analyzeMarketStructure, type Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { loadCorpus, PRODUCTION_UNIVERSE, WINDOWS, tradeableAt, isCrypto } from "./smc-corpus-fetch.ts";
import { COSTS } from "./smc-zone-replay.ts";

const SCALPER = {
  scanIntervalMinutes: 5, entryTimeframe: "5m", htfTimeframe: "1h",
  tpRatio: 2.0, slBufferPips: 1, minConfluence: 40, riskPerTrade: 0.5,
  impulseSlCapMultiplier: 1.5, trailingStopEnabled: false, trailingStopPips: 8,
  trailingStopActivation: "after_1r", breakEvenEnabled: false, breakEvenPips: 8,
  partialTPEnabled: false, maxHoldEnabled: true, maxHoldHours: 4,
};
const TP_RATIO = 2.0, MIN_CONFLUENCE = 40, MIN_ZONE_SCORE = 4, SCAN_MIN = 5;
/**
 * smcAnalysis.MIN_SL_PIPS via resolveStaticFloorPips (fallback 15).
 * ETH/USD is ABSENT from the production table, so it inherits the 15-pip
 * fallback — 15 x 0.01 = $0.15 on a ~$3,000 instrument, 0.005% of price. That
 * is the same defect class the code's own XAU/USD comment documents. Recorded
 * as production behaviour, not corrected here.
 */
const MIN_SL_PIPS: Record<string, number> = {
  "EUR/USD": 20, "USD/JPY": 25, "GBP/USD": 25,
  "AUD/USD": 18, "NZD/USD": 18, "USD/CAD": 18, "USD/CHF": 18,
  "CHF/JPY": 25, "NZD/CAD": 20, "NZD/CHF": 20, "BTC/USD": 150,
};
/** SPECS pipSize + typicalSpread, for instruments outside the FX-major COSTS map. */
const SPEC_COST: Record<string, { spread: number; slip: number; pip: number }> = {
  "CHF/JPY": { spread: 2.5, slip: 0.5, pip: 0.01 },
  "NZD/CAD": { spread: 2.5, slip: 0.5, pip: 0.0001 },
  "NZD/CHF": { spread: 3.0, slip: 0.6, pip: 0.0001 },
  "BTC/USD": { spread: 20.0, slip: 4.0, pip: 1 },
  "ETH/USD": { spread: 2.0, slip: 0.4, pip: 0.01 },
};
const ZONE_ENTRY_DEPTH: Record<string, number> = { "EUR/USD": 0.5, "AUD/USD": 0.5 };
const DEPTH = { m5: 1440, m15: 480, h1: 120, h4: 300, d1: 260, w1: 52 };

/** Account-state gate reasons: computed against a stub, so never counted. */
const ACCOUNT = [
  /^Cooldown/, /consecutive loss/i, /^Daily loss/, /^Daily net P/, /^Drawdown/,
  /^Max positions/, /^\d+\/\d+ positions/, /^\d+\/\d+ for /, /portfolio heat/i,
  /^Correlated/, /^Hedge conflict/, /^No correlated conflicts/, /^News filter/,
  /high-impact news/i, /^\[Info\] Spread/, /^Portfolio heat/, /trade history/i,
];
const isAccount = (r: string) => ACCOUNT.some((p) => p.test(r));
/** Gate 9 is confluence; it is classified as its own rejection stage. */
const isConfluenceGate = (r: string) => /threshold$/.test(r);

function seriesAt(bars: Candle[], sub: Candle[], tMs: number, depth: number, cur: { i: number }): Candle[] {
  while (cur.i + 1 < bars.length && Date.parse(bars[cur.i + 1].datetime) <= tMs) cur.i++;
  let lastClosed = -1;
  for (let k = cur.i; k >= 0; k--) {
    const nxt = k + 1 < bars.length ? Date.parse(bars[k + 1].datetime) : Infinity;
    if (nxt <= tMs) { lastClosed = k; break; }
  }
  const closed = lastClosed >= 0 ? bars.slice(Math.max(0, lastClosed - depth + 1), lastClosed + 1) : [];
  const fi = lastClosed + 1;
  if (fi >= bars.length) return closed;
  const fStart = Date.parse(bars[fi].datetime);
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
  return [...closed, { datetime: bars[fi].datetime, open: o, high: h, low: l, close: c, volume: 0 } as Candle];
}

export interface CfRow {
  symbol: string; t: string; session: string; direction: string | null;
  zoneScore: number | null; confluence: number | null; selectedTF: string | null;
  armed: boolean;
  passZoneScore: boolean; passConfluence: boolean; passSafety: boolean;
  safetyFails: string[];
  primaryReject: string;
  /** Simulated outcome IGNORING all gates, for any armed setup. */
  cfOutcome: string; cfNetR: number | null; cfGrossR: number | null;
  entry: number | null; sl: number | null; tp: number | null;
  exitTime: string | null; holdMinutes: number | null;
  /**
   * Per-factor capture. `w` is the RUNTIME contribution, not the static
   * DEFAULT_FACTOR_WEIGHTS value — production flips it negative for opposing
   * evidence ("Reversal Candle OPPOSES short — penalty"), so a present factor
   * can subtract. Sign analysis must read w, not the config weight.
   */
  fNames: string[]; fPresent: number[]; fWeight: number[];
  rawScore: number | null; enabledMax: number | null;
  /** Candidate feature vector, all computed from the scan-instant prefix. */
  feat: Record<string, number | null>;
}

if (import.meta.main) {
  const only = Deno.args[0];
  const dirCfg = buildDirectionConfig({});
  const raw = JSON.parse(Deno.readTextFileSync("/tmp/cfg.json"))[0].config_json;
  const liveJson = typeof raw === "string" ? JSON.parse(raw) : raw;
  const baseCfg = mapNestedToFlat(liveJson) as Record<string, unknown>;
  Object.assign(baseCfg, SCALPER);
  const db = (() => {
    const h: Record<string, unknown> = {};
    for (const k of ["select", "eq", "gte", "lte", "gt", "lt", "order", "limit", "in", "is", "neq"]) h[k] = () => h;
    h.then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
    h.maybeSingle = () => h;
    return { from: () => h };
  })();

  for (const sym of (only ? [only] : PRODUCTION_UNIVERSE)) {
    const out = new URL(`./.cache/fs_${sym.replace("/", "")}.json`, import.meta.url);
    try { Deno.readTextFileSync(out); console.log(`${sym}: cached`); continue; } catch { /* run */ }

    const m1 = loadCorpus(sym, "1m"), m5 = loadCorpus(sym, "5m"), m15 = loadCorpus(sym, "15m");
    const h1 = loadCorpus(sym, "1h"), h4 = loadCorpus(sym, "4h");
    const d1 = loadCorpus(sym, "1d"), w1 = loadCorpus(sym, "1w");
    if (!m1.length || !m5.length) { console.log(`${sym}: NO CORPUS`); continue; }

    const cfg = applyPairOverrides({ ...baseCfg } as never, sym) as Record<string, unknown>;
    const cost = COSTS[sym] ?? SPEC_COST[sym], pip = cost.pip;
    const half = (cost.spread / 2) * pip, slip = cost.slip * pip;
    const floor = MIN_SL_PIPS[sym] ?? 15;
    const from = Date.parse(WINDOWS.secondary.from), to = Date.parse(WINDOWS.secondary.to) + 86_400_000;

    const rows: CfRow[] = [];
    const cur = { m5: { i: 0 }, m15: { i: 0 }, h1: { i: 0 }, h4: { i: 0 }, d1: { i: 0 }, w1: { i: 0 } };
    let mi = 0;
    const t0 = Date.now();

    for (let k = 0; k < m1.length; k++) {
      const tMs = Date.parse(m1[k].datetime);
      if (tMs < from || tMs > to) continue;
      if (new Date(tMs).getUTCMinutes() % SCAN_MIN !== 0) continue;
      // Spot FX is SHUT at weekends; the provider returns a continuous 24/7
      // tape anyway. 39.1% of previously-armed setups fell in closed hours and
      // could never have been executed. Crypto is genuinely 24/7.
      if (!tradeableAt(sym, tMs)) continue;
      while (mi < m1.length && Date.parse(m1[mi].datetime) < tMs) mi++;

      const s = {
        candles: seriesAt(m5, m1, tMs, DEPTH.m5, cur.m5),
        m15Candles: seriesAt(m15, m1, tMs, DEPTH.m15, cur.m15),
        hourlyCandles: seriesAt(h1, m1, tMs, DEPTH.h1, cur.h1),
        h4Candles: seriesAt(h4, h1, tMs, DEPTH.h4, cur.h4),
        dailyCandles: seriesAt(d1, h1, tMs, DEPTH.d1, cur.d1),
        weeklyCandles: seriesAt(w1, h1, tMs, DEPTH.w1, cur.w1),
      };
      if (s.candles.length < 200) continue;
      const iso = new Date(tMs).toISOString();
      const hh = new Date(tMs).getUTCHours();
      const row: CfRow = {
        symbol: sym, t: iso,
        session: hh < 7 ? "ASIA" : hh < 12 ? "LONDON" : hh < 16 ? "OVERLAP" : hh < 21 ? "NEWYORK" : "OFF",
        direction: null, zoneScore: null, confluence: null, selectedTF: null, armed: false,
        passZoneScore: false, passConfluence: false, passSafety: false, safetyFails: [],
        primaryReject: "", cfOutcome: "", cfNetR: null, cfGrossR: null,
        entry: null, sl: null, tp: null, exitTime: null, holdMinutes: null,
        fNames: [], fPresent: [], fWeight: [], rawScore: null, enabledMax: null, feat: {},
      };

      const dir = decideDirection({ style: "scalper", series: s, dirConfig: dirCfg, useSimpleDirection: true });
      const direction = dir.overrideDirection;
      if (!direction || !hasMinZoneCandles("scalper", s)) {
        row.primaryReject = "NO_DIRECTION"; row.cfOutcome = "NOT_BYPASSABLE"; rows.push(row); continue;
      }
      row.direction = direction;

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
        minSlPips: floor, maxSlPips: floor * 1.5, tpRatio: TP_RATIO,
        entryDepth: ZONE_ENTRY_DEPTH[sym], pipSize: pip,
        strictATRMult: undefined, fibMaxRetracement: undefined,
        originOBRetest: undefined, impulseZoneEnabled: true,
      });
      const bz = (z.impulseZone as never as { bestZone?: Record<string, unknown> } | null)?.bestZone;
      if (!z.unified?.hasZone || !bz) {
        row.primaryReject = "NO_ZONE"; row.cfOutcome = "NOT_BYPASSABLE"; rows.push(row); continue;
      }
      row.selectedTF = z.unified.selectedTF ?? null;
      row.zoneScore = Number(bz.totalScore ?? NaN);
      row.passZoneScore = row.zoneScore >= MIN_ZONE_SCORE;

      const zh = Number(bz.high), zl = Number(bz.low), zw = zh - zl;
      const long = direction === "long";
      const layer3 = long ? lastPrice <= zh + zw * 2 : lastPrice >= zl - zw * 2;
      row.armed = bz.priceAtZoneStrict === true && bz.sideOk === true && layer3;

      // Confluence + safety gates are only needed where a trade could exist.
      if (row.armed) {
        // FULL PRODUCTION CONTEXT, mirroring bot-scanner:4831-4882.
        // Everything here is derived from the causal prefixes already built.
        // NOT injected, and therefore still unreachable:
        //   _fotsiResult      needs a 28-pair cross-currency fetch, and is
        //                     itself a 4h-cached runtime value
        //   _gamePlanContext  never persisted historically (architecture audit)
        //   _smtResult        needs the correlated pair, outside this corpus
        const ctx = cfg as Record<string, unknown>;
        ctx._currentSymbol = sym;
        ctx._h4Candles = s.h4Candles.length >= 20 ? s.h4Candles : null;
        ctx._htfPOIs = htf.htfPOIs;
        ctx._htfFibLevels = { d: htf.htfFibLevelsD, h4: htf.htfFibLevels4H, h1: htf.htfFibLevels1H };
        ctx._htfPD = { d: htf.htfPDD, h4: htf.htfPD4H, h1: htf.htfPD1H };
        ctx._htfLiquidityPools = { d: htf.htfLiquidityPoolsD, h4: htf.htfLiquidityPools4H, h1: htf.htfLiquidityPools1H };
        ctx._structureCandles = htf.structureSeries;
        const analysis = runConfluenceAnalysis(
          s.candles, s.dailyCandles.length >= 10 ? s.dailyCandles : null, cfg,
          s.hourlyCandles.length ? s.hourlyCandles : undefined, tMs,
        ) as Record<string, unknown>;
        row.confluence = (analysis.score as number) ?? null;
        row.rawScore = (analysis.rawScore as number) ?? null;
        row.enabledMax = (analysis.enabledMax as number) ?? null;
        const fs = (analysis.factors ?? []) as Array<{ name: string; present: boolean; weight: number }>;
        row.fNames = fs.map((f) => f.name);
        row.fPresent = fs.map((f) => (f.present ? 1 : 0));
        row.fWeight = fs.map((f) => Number(f.weight) || 0);
        row.passConfluence = (row.confluence ?? -1) >= MIN_CONFLUENCE;

        const entry = lastPrice + (long ? half + slip : -(half + slip));
        const slRaw = long ? Math.min(zl, entry - floor * pip) : Math.max(zh, entry + floor * pip);
        const risk = Math.max(Math.abs(entry - slRaw), floor * pip);
        const sl = long ? entry - risk : entry + risk;
        const tp = long ? entry + risk * TP_RATIO : entry - risk * TP_RATIO;
        analysis.stopLoss = sl; analysis.takeProfit = tp; analysis.direction = direction;

        // ── CANDIDATE FEATURES, scan-instant only ────────────────────────
        const u = z.unified!;
        const imp = u.impulse as never as (Record<string, unknown> | null);
        const zst = u.zone as never as (Record<string, unknown> | null);
        const liq = u.liquidity as never as (Record<string, unknown> | null);
        const disp = (imp?.displacement ?? null) as Record<string, unknown> | null;
        const c5 = s.candles;
        const atr = calculateATR(c5, 14) || 0;
        const atrLong = calculateATR(c5.slice(-200), 50) || 0;
        // ATR percentile within the instrument's own recent history (causal).
        const atrHist: number[] = [];
        for (let q = c5.length - 1; q >= 60 && atrHist.length < 200; q -= 5) {
          atrHist.push(calculateATR(c5.slice(0, q + 1), 14) || 0);
        }
        const atrPct = atrHist.length
          ? atrHist.filter((v) => v < atr).length / atrHist.length : null;
        const st = analyzeMarketStructure(c5);
        const nowMs = tMs;
        const endT = (imp?.endTime ?? imp?.endDate ?? null) as string | null;
        const zw = zh - zl;
        const mid = (zh + zl) / 2;
        const prox = long ? zh : zl;
        const dist = long ? zl : zh;
        const F: Record<string, number | null> = {
          // A session / time
          hourUTC: new Date(tMs).getUTCHours(),
          minuteOfDay: new Date(tMs).getUTCHours() * 60 + new Date(tMs).getUTCMinutes(),
          isCryptoAsset: isCrypto(sym) ? 1 : 0,
          // B zone / impulse age
          minsSinceImpulseEnd: endT ? (nowMs - Date.parse(endT)) / 60000 : null,
          impulseSpanBars: (imp?.spanBars as number) ?? null,
          // C zone geometry
          zoneWidthPips: zw / pip,
          zoneWidthOverATR: atr > 0 ? zw / atr : null,
          distMidOverATR: atr > 0 ? Math.abs(lastPrice - mid) / atr : null,
          distProxOverATR: atr > 0 ? Math.abs(lastPrice - prox) / atr : null,
          distDistalOverATR: atr > 0 ? Math.abs(lastPrice - dist) / atr : null,
          fibLevel: (zst?.fibLevel as number) ?? null,
          zonesFound: (zst?.zonesFound as number) ?? null,
          zoneIsOB: zst?.type === "OB" ? 1 : 0,
          srConfirmed: zst?.srConfirmed ? 1 : 0,
          ltfRefined: zst?.ltfRefined ? 1 : 0,
          htfLayerCount: Array.isArray(zst?.htfLayers) ? (zst!.htfLayers as unknown[]).length : null,
          // D impulse quality
          impulsePips: (imp?.pips as number) ?? null,
          impulseOverATR: atr > 0 && imp?.pips != null ? ((imp.pips as number) * pip) / atr : null,
          avgBodyRatio: (disp?.avgBodyRatio as number) ?? null,
          maxRangeMultiple: (disp?.maxRangeMultiple as number) ?? null,
          displacementCandles: (disp?.displacementCandles as number) ?? null,
          displacementRatio: (disp?.displacementRatio as number) ?? null,
          rangePerBarOverATR: atr > 0 && disp?.rangePerBar != null ? (disp.rangePerBar as number) / atr : null,
          // E liquidity / touch
          nearbyPoolCount: (liq?.nearbyPools as number) ?? null,
          liquidityScore: (liq?.liquidityScore as number) ?? null,
          sweepPresent: liq?.sweepEvent ? 1 : 0,
          // F volatility
          atrPercentile: atrPct,
          atrShortOverLong: atrLong > 0 ? atr / atrLong : null,
          barRangeOverATR: atr > 0 ? (c5[c5.length - 1].high - c5[c5.length - 1].low) / atr : null,
          // G execution / cost
          stopPips: Math.abs(entry - sl) / pip,
          stopOverATR: atr > 0 ? Math.abs(entry - sl) / atr : null,
          spreadOverStop: Math.abs(entry - sl) > 0 ? (cost.spread * pip) / Math.abs(entry - sl) : null,
          spreadOverATR: atr > 0 ? (cost.spread * pip) / atr : null,
          costR: Math.abs(entry - sl) > 0 ? (2 * (half + slip)) / Math.abs(entry - sl) : null,
          entryVsZoneMidATR: atr > 0 ? (lastPrice - mid) / atr * (long ? 1 : -1) : null,
          // H structure
          bosCount: Array.isArray(st?.bos) ? st.bos.length : null,
          chochCount: Array.isArray(st?.choch) ? st.choch.length : null,
          trendAligned: st?.trend === (long ? "bullish" : "bearish") ? 1 : 0,
        };
        row.feat = F;

        try {
          const gates = await runSafetyGates(
            db, "research", sym, direction, analysis, cfg,
            { balance: 10_000, peak_balance: 10_000, daily_pnl_base: 10_000, daily_pnl_base_date: iso.slice(0, 10) },
            [], s.dailyCandles, {}, null, null, false,
          ) as Array<{ passed: boolean; reason: string }>;
          row.safetyFails = gates.filter((g) => !g.passed && !isAccount(g.reason) && !isConfluenceGate(g.reason))
            .map((g) => g.reason.split(/[:(]/)[0].trim().slice(0, 44));
          row.passSafety = row.safetyFails.length === 0;
        } catch { row.safetyFails = ["GATE_ERROR"]; row.passSafety = false; }

        row.entry = entry; row.sl = sl; row.tp = tp;
        // Counterfactual outcome: what this trade WOULD have done, gates aside.
        let done = false;
        for (let i = mi; i < m1.length; i++) {
          const b = m1[i];
          const hitTp = long ? b.high >= tp : b.low <= tp;
          const hitSl = long ? b.low <= sl : b.high >= sl;
          if (hitTp && hitSl) { row.cfOutcome = "WOULD_BE_AMBIGUOUS"; row.exitTime = b.datetime; done = true; break; }
          if (hitTp || hitSl) {
            const px = hitTp ? tp : sl;
            const g = (long ? px - entry : entry - px) / risk;
            row.cfGrossR = g; row.cfNetR = g - (2 * (half + slip)) / risk;
            row.exitTime = b.datetime;
            row.holdMinutes = Math.round((Date.parse(b.datetime) - tMs) / 60_000);
            row.cfOutcome = hitTp ? "WOULD_TRADE_AND_WIN" : "WOULD_TRADE_AND_LOSE";
            done = true; break;
          }
        }
        if (!done) row.cfOutcome = "WOULD_REMAIN_OPEN";
      } else {
        row.cfOutcome = "WOULD_NEVER_ARM_ROUTE1";
      }

      // Primary rejection = FIRST failure in production execution order.
      row.primaryReject = !row.passZoneScore ? "ZONE_SCORE_LT_4"
        : !row.armed ? "NOT_ROUTE1_ARMED"
        : !row.passConfluence ? "CONFLUENCE_LT_40"
        : !row.passSafety ? "SAFETY_GATE_REJECT"
        : "ACCEPTED";
      rows.push(row);
    }

    Deno.writeTextFileSync(out, JSON.stringify(rows));
    console.log(`${sym}: ${rows.length} evaluations, ${rows.filter((r) => r.armed).length} armed, ` +
      `${rows.filter((r) => r.primaryReject === "ACCEPTED").length} accepted, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
}
