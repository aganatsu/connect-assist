/**
 * SMC_IMPULSE_ZONE_ARCHITECTURE_CLOSURE_V1 — §8/§9 empirical.
 *
 * Measures the four proximity flags the routes read, over real historical zone
 * observations, to settle whether the UI badge can disagree with executor
 * readiness.
 *
 * Source reading (impulseZoneEngine:1342-1396):
 *   priceInsideZone  = price >= zoneLow && price <= zoneHigh
 *   priceAtZone      = insideZone || within looseThreshold  (1.5x ATR)
 *   sideOk           = true unless price is beyond the far edge by > strict
 *   priceAtZoneStrict= insideZone ? TRUE : (nearStrict && sideOk)   <-- note
 *
 * The `insideZone -> strict` implication is unconditional, so the badge
 * condition (`priceInsideZone || priceAtZoneStrict`) collapses to
 * `priceAtZoneStrict`. This run tests that against real data rather than
 * asserting it from a reading.
 *
 *   deno run --allow-read --allow-env --allow-net local-runner/smc-zoneflags-probe.ts
 */

import { decideDirection, buildDirectionConfig } from "../supabase/functions/_shared/smcDirectionDecision.ts";
import { buildHtfContext } from "../supabase/functions/_shared/smcHtfContext.ts";
import { decideZone, hasMinZoneCandles, buildHtfConfluence } from "../supabase/functions/_shared/smcZoneDecision.ts";
import { loadCorpus, SYMBOLS } from "./smc-corpus-fetch.ts";
import { DEPTH, upTo } from "./smc-zone-probe.ts";
import { COSTS } from "./smc-zone-replay.ts";

const dirCfg = buildDirectionConfig({});
const MIN_SL: Record<string, number> = {
  "EUR/USD": 20, "USD/JPY": 25, "GBP/USD": 25,
  "AUD/USD": 18, "NZD/USD": 18, "USD/CAD": 18, "USD/CHF": 18,
};

if (import.meta.main) {
  const combos: Record<string, number> = {};
  const badgeVsExec: Record<string, number> = {};
  let n = 0, violations = 0;
  const rows: string[] = [];

  for (const sym of SYMBOLS) {
    const c = {
      m5: loadCorpus(sym, "5m"), m15: loadCorpus(sym, "15m"), h1: loadCorpus(sym, "1h"),
      h4: loadCorpus(sym, "4h"), d1: loadCorpus(sym, "1d"), w1: loadCorpus(sym, "1w"),
    };
    if (!c.m5.length) continue;
    const lo = Math.floor(c.m5.length * 0.3), hi = Math.floor(c.m5.length * 0.95);
    for (let k = 0; k < 120; k++) {
      const idx = lo + Math.floor((hi - lo) * k / 120);
      const t = Date.parse(c.m5[idx].datetime);
      const s = {
        candles: upTo(c.m5, t, DEPTH.m5), m15Candles: upTo(c.m15, t, DEPTH.m15),
        hourlyCandles: upTo(c.h1, t, DEPTH.h1), h4Candles: upTo(c.h4, t, DEPTH.h4),
        dailyCandles: upTo(c.d1, t, DEPTH.d1), weeklyCandles: upTo(c.w1, t, DEPTH.w1),
      };
      if (s.candles.length < 200) continue;
      const dir = decideDirection({ style: "scalper", series: s, dirConfig: dirCfg, useSimpleDirection: true });
      const direction = dir.overrideDirection;
      if (!direction || !hasMinZoneCandles("scalper", s)) continue;
      const htf = buildHtfContext({
        style: "scalper", m15Candles: s.m15Candles, hourlyCandles: s.hourlyCandles,
        h4Candles: s.h4Candles, dailyCandles: s.dailyCandles,
        equalHighsLowsSensitivity: undefined, liquidityPoolMinTouches: undefined,
      });
      const floor = MIN_SL[sym] ?? 15;
      const z = decideZone({
        symbol: sym, style: "scalper", series: s, direction,
        lastPrice: s.candles[s.candles.length - 1].close,
        htfConfluence: buildHtfConfluence({
          direction, h4OBs: htf.h4OBs, h4FVGs: htf.h4FVGs, h4Breakers: htf.h4Breakers,
          htfFibLevels4H: htf.htfFibLevels4H, htfFibLevelsD: htf.htfFibLevelsD,
          htfPD4H: htf.htfPD4H,
        } as never),
        liquidityPools: htf.combinedLiquidityPools,
        minSlPips: floor, maxSlPips: floor * 4, tpRatio: 1.5, entryDepth: undefined,
        pipSize: COSTS[sym].pip, strictATRMult: undefined, fibMaxRetracement: undefined,
        originOBRetest: undefined, impulseZoneEnabled: true,
      });
      const bz = (z.impulseZone as never as { bestZone?: Record<string, unknown> } | null)?.bestZone;
      if (!bz) continue;

      const inside = bz.priceInsideZone === true;
      const strict = bz.priceAtZoneStrict === true;
      const loose = bz.priceAtZone === true;
      const side = bz.sideOk === true;
      n++;

      combos[`inside=${inside} strict=${strict} loose=${loose} sideOk=${side}`] =
        (combos[`inside=${inside} strict=${strict} loose=${loose} sideOk=${side}`] ?? 0) + 1;

      // The documented implication: insideZone must force strict.
      if (inside && !strict) { violations++; rows.push(`${sym} ${c.m5[idx].datetime} inside but NOT strict`); }

      // Badge condition vs market-fill arming (izGateMode "hard" is the live default).
      const badge = inside || strict;                 // ImpulseZonePanel.tsx:190
      const marketFillArmed = strict && side;         // bot-scanner:7400 (pre Layer-3)
      const entryStory = z.unified?.entry != null;    // what "Entry:" renders
      const key = badge === marketFillArmed
        ? (badge ? "BADGE_AND_EXEC_BOTH_ARMED" : "BOTH_IDLE")
        : (badge ? "BADGE_ON_EXEC_OFF" : "BADGE_OFF_EXEC_ON");
      badgeVsExec[key] = (badgeVsExec[key] ?? 0) + 1;
      if (marketFillArmed && !entryStory) {
        badgeVsExec["EXEC_ARMED_BUT_ENTRY_STORY_NULL"] =
          (badgeVsExec["EXEC_ARMED_BUT_ENTRY_STORY_NULL"] ?? 0) + 1;
      }
    }
  }

  console.log(`observations with a bestZone: ${n}\n`);
  console.log("flag combinations:");
  for (const [k, v] of Object.entries(combos).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(v / n * 100).toFixed(1).padStart(5)}%  ${String(v).padStart(4)}  ${k}`);
  }
  console.log(`\ninsideZone && !strict violations: ${violations}`);
  for (const r of rows.slice(0, 5)) console.log(`  ${r}`);
  console.log("\nbadge vs executor:");
  for (const [k, v] of Object.entries(badgeVsExec).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(v / n * 100).toFixed(1).padStart(5)}%  ${String(v).padStart(4)}  ${k}`);
  }
}
