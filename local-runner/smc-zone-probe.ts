/**
 * SMC_IMPULSE_ZONE_CORPUS_BACKTEST_V1 — feasibility probe. READ-ONLY.
 *
 * Runs the PRODUCTION decision chain once against causal prefixes and times it,
 * before any corpus is built. Engine cost has decided the shape of the last two
 * research tasks — the IPO engine is ~O(n^2.7) and 10k bars took 1.6h/symbol —
 * so it is measured first here rather than discovered after a day of fetching.
 *
 * Chain, all current-main shared modules:
 *   decideDirection  (smcDirectionDecision)
 *   buildHtfContext  (smcHtfContext)
 *   decideZone       (smcZoneDecision) -> findUnifiedZone (unifiedZoneEngine)
 *
 * PRODUCTION DEPTHS, read from bot-scanner, not from memory. Live style is
 * `scalper` (bot_configs.config_json.tradingStyle.mode), so:
 *   entry 5m  "5d"        1h  "5d"          4h "1mo" sliced to LEGACY_H4_WINDOW=300
 *   15m       "5d"        1d  "1y"          1w "1y"
 *
 *   deno run --allow-net --allow-read --allow-env local-runner/smc-zone-probe.ts
 */

import { decideDirection, buildDirectionConfig } from "../supabase/functions/_shared/smcDirectionDecision.ts";
import { buildHtfContext } from "../supabase/functions/_shared/smcHtfContext.ts";
import { decideZone, hasMinZoneCandles, buildHtfConfluence } from "../supabase/functions/_shared/smcZoneDecision.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { series } from "./ipo-stock-datacheck.ts";

/** Production depths for the live scalper style, in bars. */
export const DEPTH = { m5: 1440, m15: 480, h1: 120, h4: 300, d1: 260, w1: 52 };

export const upTo = (bars: Candle[], tMs: number, n: number): Candle[] => {
  const out: Candle[] = [];
  for (let i = bars.length - 1; i >= 0 && out.length < n; i--) {
    if (Date.parse(bars[i].datetime) <= tMs) out.push(bars[i]);
  }
  return out.reverse();
};

if (import.meta.main) {
  const sym = "EUR/USD";
  console.log(`fetching ${sym} corpus slice...`);
  const [m5, m15, h1, h4, d1, w1] = [
    await series(sym, "5min", "2026-08-20", "2026-09-25"),
    await series(sym, "15min", "2026-08-01", "2026-09-25"),
    await series(sym, "1h", "2026-07-01", "2026-09-25"),
    await series(sym, "4h", "2026-01-01", "2026-09-25"),
    await series(sym, "1day", "2025-09-01", "2026-09-25"),
    await series(sym, "1week", "2025-01-01", "2026-09-25"),
  ];
  console.log(`bars: 5m=${m5.length} 15m=${m15.length} 1h=${h1.length} ` +
    `4h=${h4.length} 1d=${d1.length} 1w=${w1.length}`);
  if (m5.length < 500) { console.log("insufficient 5m for a probe"); Deno.exit(1); }

  const dirCfg = buildDirectionConfig({});
  let evaluated = 0, withZone = 0, withEntry = 0;
  const states: Record<string, number> = {};
  const dirs: Record<string, number> = {};
  const N = 600;
  const t0 = Date.now();

  for (let k = 0; k < N; k++) {
    const t = Date.parse(m5[m5.length - 1 - k * 8].datetime);
    const s = {
      candles: upTo(m5, t, DEPTH.m5),
      m15Candles: upTo(m15, t, DEPTH.m15),
      hourlyCandles: upTo(h1, t, DEPTH.h1),
      h4Candles: upTo(h4, t, DEPTH.h4),
      dailyCandles: upTo(d1, t, DEPTH.d1),
      weeklyCandles: upTo(w1, t, DEPTH.w1),
    };
    const dir = decideDirection({
      style: "scalper", series: s, dirConfig: dirCfg, useSimpleDirection: true,
    });
    const direction = dir.overrideDirection;
    if (!direction) continue;
    if (!hasMinZoneCandles("scalper", s)) continue;

    const htf = buildHtfContext({
      style: "scalper", m15Candles: s.m15Candles, hourlyCandles: s.hourlyCandles,
      h4Candles: s.h4Candles, dailyCandles: s.dailyCandles,
      equalHighsLowsSensitivity: undefined, liquidityPoolMinTouches: undefined,
    });
    const lastPrice = s.candles[s.candles.length - 1].close;
    const z = decideZone({
      symbol: sym, style: "scalper", series: s, direction,
      lastPrice,
      htfConfluence: buildHtfConfluence({
        direction,
        h4OBs: htf.h4OBs, h4FVGs: htf.h4FVGs, h4Breakers: htf.h4Breakers,
        htfFibLevels4H: htf.htfFibLevels4H, htfFibLevelsD: htf.htfFibLevelsD,
        htfPD4H: htf.htfPD4H,
      } as never),
      liquidityPools: htf.combinedLiquidityPools,
      minSlPips: 10, maxSlPips: 40, tpRatio: 1.5, entryDepth: undefined,
      pipSize: 0.0001, strictATRMult: undefined, fibMaxRetracement: undefined,
      originOBRetest: undefined, impulseZoneEnabled: true,
    });
    evaluated++;
    const st = z.unified?.state ?? "none";
    states[st] = (states[st] ?? 0) + 1;
    dirs[direction] = (dirs[direction] ?? 0) + 1;
    if (z.unified?.hasZone) withZone++;
    if (z.unified?.entry) withEntry++;
  }

  const ms = Date.now() - t0;
  console.log(`\n${N} decision points in ${(ms / 1000).toFixed(1)}s ` +
    `= ${(ms / N).toFixed(0)} ms/decision`);
  console.log(`evaluated ${evaluated}, hasZone ${withZone}, entry ${withEntry}`);
  console.log("states:", JSON.stringify(states));
  console.log("directions:", JSON.stringify(dirs));
  const perSymbol90d = (ms / N) * (90 * 288) / 1000 / 60;
  console.log(`\nprojection: 90d x 288 5m-bars = 25,920 decisions/symbol`);
  console.log(`  ${perSymbol90d.toFixed(0)} min/symbol, ` +
    `${(perSymbol90d * 7 / 60).toFixed(1)} h for 7 symbols`);
}
