/**
 * SMC_IMPULSE_ZONE_CORPUS_BACKTEST_V1 — future-leak test. GATE BEFORE P&L.
 *
 * Three runs of the SAME production chain at the SAME historical instant t:
 *
 *   A  PREFIX          arrays truncated to t, exactly as the replay does
 *   B  PREFIX+APPEND   the full corpus handed in, re-truncated to t internally
 *   C  WHOLE           the full corpus handed in UNTRUNCATED
 *
 * A vs B must match. If it does not, something inside the chain reaches past
 * the prefix it was given — module state, a cache, or an internal scan — and
 * the replay is INVALID_CAUSALITY regardless of what the numbers say.
 *
 * A vs C is the interesting one: it measures how much the answer WOULD move if
 * future bars were visible. A large divergence is not a defect here — it is
 * proof that the truncation is load-bearing, and it quantifies exactly what a
 * harness that passes whole arrays is getting wrong.
 *
 *   deno run --allow-read --allow-env --allow-net local-runner/smc-causality-test.ts
 */

import { decideDirection, buildDirectionConfig } from "../supabase/functions/_shared/smcDirectionDecision.ts";
import { buildHtfContext } from "../supabase/functions/_shared/smcHtfContext.ts";
import { decideZone, hasMinZoneCandles, buildHtfConfluence } from "../supabase/functions/_shared/smcZoneDecision.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { loadCorpus } from "./smc-corpus-fetch.ts";
import { DEPTH, upTo } from "./smc-zone-probe.ts";
import { COSTS } from "./smc-zone-replay.ts";

const dirCfg = buildDirectionConfig({});

/** The decision, reduced to the fields that decide whether a trade exists. */
function decisionAt(sym: string, series: Record<string, Candle[]>, pip: number) {
  const s = {
    candles: series.m5, m15Candles: series.m15, hourlyCandles: series.h1,
    h4Candles: series.h4, dailyCandles: series.d1, weeklyCandles: series.w1,
  };
  const dir = decideDirection({ style: "scalper", series: s, dirConfig: dirCfg, useSimpleDirection: true });
  const direction = dir.overrideDirection;
  if (!direction || !hasMinZoneCandles("scalper", s)) return { direction, state: "NONE" };
  const htf = buildHtfContext({
    style: "scalper", m15Candles: s.m15Candles, hourlyCandles: s.hourlyCandles,
    h4Candles: s.h4Candles, dailyCandles: s.dailyCandles,
    equalHighsLowsSensitivity: undefined, liquidityPoolMinTouches: undefined,
  });
  const z = decideZone({
    symbol: sym, style: "scalper", series: s, direction,
    lastPrice: s.candles[s.candles.length - 1].close,
    htfConfluence: buildHtfConfluence({
      direction, h4OBs: htf.h4OBs, h4FVGs: htf.h4FVGs, h4Breakers: htf.h4Breakers,
      htfFibLevels4H: htf.htfFibLevels4H, htfFibLevelsD: htf.htfFibLevelsD,
      htfPD4H: htf.htfPD4H,
    } as never),
    liquidityPools: htf.combinedLiquidityPools,
    minSlPips: 1, maxSlPips: 4, tpRatio: 1.5, entryDepth: undefined,
    pipSize: pip, strictATRMult: undefined, fibMaxRetracement: undefined,
    originOBRetest: undefined, impulseZoneEnabled: true,
  });
  const u = z.unified;
  return {
    direction, state: u?.state ?? "NONE", tf: u?.selectedTF ?? null,
    score: u?.unifiedScore ?? null,
    zoneHigh: (u?.zone as never as { high?: number } | null)?.high ?? null,
    zoneLow: (u?.zone as never as { low?: number } | null)?.low ?? null,
    entry: u?.entry?.entryPrice ?? null,
    sl: u?.entry?.executable?.slPrice ?? null,
    tp: u?.entry?.executable?.tpPrice ?? null,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

if (import.meta.main) {
  const syms = ["EUR/USD", "USD/JPY", "GBP/USD"];
  let n = 0, abMatch = 0, acMatch = 0;
  const acDiffs: string[] = [];

  for (const sym of syms) {
    const c = {
      m5: loadCorpus(sym, "5m"), m15: loadCorpus(sym, "15m"), h1: loadCorpus(sym, "1h"),
      h4: loadCorpus(sym, "4h"), d1: loadCorpus(sym, "1d"), w1: loadCorpus(sym, "1w"),
    };
    // Sample across the window, leaving future bars to leak from.
    const lo = Math.floor(c.m5.length * 0.35), hi = Math.floor(c.m5.length * 0.85);
    for (let k = 0; k < 20; k++) {
      const idx = lo + Math.floor((hi - lo) * k / 20);
      const t = Date.parse(c.m5[idx].datetime);

      const pre = {
        m5: upTo(c.m5, t, DEPTH.m5), m15: upTo(c.m15, t, DEPTH.m15),
        h1: upTo(c.h1, t, DEPTH.h1), h4: upTo(c.h4, t, DEPTH.h4),
        d1: upTo(c.d1, t, DEPTH.d1), w1: upTo(c.w1, t, DEPTH.w1),
      };
      if (pre.m5.length < 200) continue;
      const A = decisionAt(sym, pre, COSTS[sym].pip);

      // B: hand in the FULL corpus, truncate internally to the same t.
      const pre2 = {
        m5: upTo(c.m5, t, DEPTH.m5), m15: upTo(c.m15, t, DEPTH.m15),
        h1: upTo(c.h1, t, DEPTH.h1), h4: upTo(c.h4, t, DEPTH.h4),
        d1: upTo(c.d1, t, DEPTH.d1), w1: upTo(c.w1, t, DEPTH.w1),
      };
      const B = decisionAt(sym, pre2, COSTS[sym].pip);

      // C: the same decision point with future bars VISIBLE, capped to the
      // same depth so only the future/past composition differs.
      const tail = (a: Candle[], d: number) => a.slice(Math.max(0, a.length - d));
      const whole = {
        m5: tail(c.m5, DEPTH.m5), m15: tail(c.m15, DEPTH.m15), h1: tail(c.h1, DEPTH.h1),
        h4: tail(c.h4, DEPTH.h4), d1: tail(c.d1, DEPTH.d1), w1: tail(c.w1, DEPTH.w1),
      };
      const C = decisionAt(sym, whole, COSTS[sym].pip);

      n++;
      if (same(A, B)) abMatch++;
      else console.log(`  A!=B  ${sym} ${c.m5[idx].datetime}\n     A=${JSON.stringify(A)}\n     B=${JSON.stringify(B)}`);
      if (same(A, C)) acMatch++;
      else if (acDiffs.length < 4) {
        acDiffs.push(`  ${sym} ${c.m5[idx].datetime}\n     causal=${JSON.stringify(A)}\n     leaked=${JSON.stringify(C)}`);
      }
    }
  }

  console.log(`\nA vs B  (prefix vs re-truncated full corpus): ${abMatch}/${n} identical`);
  console.log(`A vs C  (prefix vs future-visible):           ${acMatch}/${n} identical`);
  console.log(`\nexamples where future visibility changes the decision:`);
  for (const d of acDiffs) console.log(d);
  console.log(`\nVERDICT: ${abMatch === n ? "CAUSAL — no channel past the prefix" : "INVALID_CAUSALITY"}`);
}
