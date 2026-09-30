/**
 * SMC_IMPULSE_ZONE_CORPUS_BACKTEST_V1 — causal replay. RESEARCH ONLY.
 *
 * CAUSAL MARKET-LOGIC BACKTEST — NOT a full live portfolio simulation.
 * Account-level state (balance, portfolio heat, cooldowns, daily loss, news,
 * game-plan cache, correlation occupancy) is NOT reconstructed and NOT
 * fabricated. This measures the raw market-setup edge only.
 *
 * SOURCE OF TRUTH is current main, via the Stage 2H shared modules that
 * bot-scanner itself calls:
 *   decideDirection -> buildHtfContext -> decideZone -> findUnifiedZone
 * The backtest-engine and `findBestEntryZoneMultiTF` are NOT used directly.
 *
 * ENTRY SEMANTICS, read from bot-scanner:7400, not assumed:
 *   useMarketFillAtZone = priceIsAtValidatedZone && marketFillAtZone && priceOnCorrectSide
 * Live config sets none of these, so bot-scanner DEFAULTS apply:
 *   marketFillAtZone true, limitOrderEnabled false, izGateMode "hard".
 * `state === "triggered"` is priceAtZoneStrict, which is the market-fill route;
 * `state === "confirmed"` is the loose/pending route. Both are replayed and
 * reported separately rather than merged.
 *
 * SL/TP come from EntryStory.executable — the engine's own note is that
 * `slPrice`/`tpPrice` are NOT what gets traded and `executable` is.
 *
 *   deno run --allow-read --allow-write local-runner/smc-zone-replay.ts [SYMBOL]
 */

import { decideDirection, buildDirectionConfig } from "../supabase/functions/_shared/smcDirectionDecision.ts";
import { buildHtfContext } from "../supabase/functions/_shared/smcHtfContext.ts";
import { decideZone, hasMinZoneCandles, buildHtfConfluence } from "../supabase/functions/_shared/smcZoneDecision.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { loadCorpus, SYMBOLS, WINDOWS } from "./smc-corpus-fetch.ts";
import { DEPTH, upTo } from "./smc-zone-probe.ts";

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

/** Style override for the live scalper mode, from bot-scanner STYLE_OVERRIDES. */
const TP_RATIO = 1.5;
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
const SL_CAP_MULT = 4;          // impulseSlCapMultiplier default
const ZONE_ENTRY_DEPTH: Record<string, number> = { "EUR/USD": 0.5, "AUD/USD": 0.5 };

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
  const only = Deno.args[0];
  const syms = only ? [only] : SYMBOLS;
  const dirCfg = buildDirectionConfig({});

  for (const sym of syms) {
    const out = new URL(`./.cache/smc_setups_${sym.replace("/", "")}.json`, import.meta.url);
    try { Deno.readTextFileSync(out); console.log(`${sym}: cached`); continue; } catch { /* run */ }

    const m1 = loadCorpus(sym, "1m"), m5 = loadCorpus(sym, "5m");
    const m15 = loadCorpus(sym, "15m"), h1 = loadCorpus(sym, "1h");
    const h4 = loadCorpus(sym, "4h"), d1 = loadCorpus(sym, "1d"), w1 = loadCorpus(sym, "1w");
    if (!m5.length || !m1.length) { console.log(`${sym}: NO CORPUS`); continue; }

    const cost = COSTS[sym];
    const secFrom = Date.parse(WINDOWS.secondary.from), priFrom = Date.parse(WINDOWS.primary.from);
    const to = Date.parse(WINDOWS.secondary.to) + 86_400_000;

    const setups: Setup[] = [];
    const zoneSeen = new Map<string, string>();     // zoneId -> first seen
    const zoneDead = new Set<string>();             // invalidated, stays invalid
    let openUntil = 0;                              // ARM A: one position per symbol
    let evaluated = 0;
    const t0 = Date.now();

    for (const bar of m5) {
      const tMs = Date.parse(bar.datetime);
      if (tMs < secFrom || tMs > to) continue;
      evaluated++;

      const s = {
        candles: upTo(m5, tMs, DEPTH.m5),
        m15Candles: upTo(m15, tMs, DEPTH.m15),
        hourlyCandles: upTo(h1, tMs, DEPTH.h1),
        h4Candles: upTo(h4, tMs, DEPTH.h4),
        dailyCandles: upTo(d1, tMs, DEPTH.d1),
        weeklyCandles: upTo(w1, tMs, DEPTH.w1),
      };
      if (s.candles.length < 100) continue;

      const dir = decideDirection({ style: "scalper", series: s, dirConfig: dirCfg, useSimpleDirection: true });
      const direction = dir.overrideDirection;
      if (!direction || !hasMinZoneCandles("scalper", s)) continue;

      const htf = buildHtfContext({
        style: "scalper", m15Candles: s.m15Candles, hourlyCandles: s.hourlyCandles,
        h4Candles: s.h4Candles, dailyCandles: s.dailyCandles,
        equalHighsLowsSensitivity: undefined, liquidityPoolMinTouches: undefined,
      });
      const lastPrice = s.candles[s.candles.length - 1].close;
      const staticFloor = MIN_SL_PIPS[sym] ?? 15;
      const z = decideZone({
        symbol: sym, style: "scalper", series: s, direction, lastPrice,
        htfConfluence: buildHtfConfluence({
          direction, h4OBs: htf.h4OBs, h4FVGs: htf.h4FVGs, h4Breakers: htf.h4Breakers,
          htfFibLevels4H: htf.htfFibLevels4H, htfFibLevelsD: htf.htfFibLevelsD,
          htfPD4H: htf.htfPD4H,
        } as never),
        liquidityPools: htf.combinedLiquidityPools,
        minSlPips: staticFloor, maxSlPips: staticFloor * SL_CAP_MULT,
        tpRatio: TP_RATIO, entryDepth: ZONE_ENTRY_DEPTH[sym],
        pipSize: cost.pip, strictATRMult: undefined, fibMaxRetracement: undefined,
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
        window: tMs >= priFrom ? "primary" : "secondary_only",
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
      };

      const e = u.entry;
      if (!e || !e.executable) { setups.push(base); continue; }
      base.entryPrice = e.entryPrice;
      base.slPrice = e.executable.slPrice;
      base.tpPrice = e.executable.tpPrice;
      base.riskPips = e.executable.riskPips;
      base.route = u.state === "triggered" ? "MARKET" : "LIMIT";

      if (zoneDead.has(zid)) { base.outcome = "INVALIDATED_BEFORE_ENTRY"; setups.push(base); continue; }
      if (tMs < openUntil) { base.outcome = "BLOCKED_BY_EXISTING_POSITION"; setups.push(base); continue; }

      // ── execution on the 1m tape ──────────────────────────────────────────
      const start = nextMinuteIdx(m1, tMs);
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
        const expiry = tMs + 60 * 60_000;
        for (let i = start; i < m1.length && Date.parse(m1[i].datetime) <= expiry; i++) {
          const hit = long ? m1[i].low <= e.entryPrice : m1[i].high >= e.entryPrice;
          if (hit) { fillIdx = i; fillPx = e.entryPrice + (long ? half : -half); break; }
        }
      }
      if (fillIdx < 0) { base.outcome = "NO_ENTRY_TOUCH"; setups.push(base); continue; }

      base.fillTime = m1[fillIdx].datetime; base.fillPrice = fillPx;
      const sl = base.slPrice!, tp = base.tpPrice!;
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
