// Frozen V3.2c configuration (research v3.2c-frozen-20261013/CONFIG.md) as a pure factory.
//
// VENDORED, UNUSED: no production function imports anything under _shared/structure/v32c (enforced by
// supabase/tests/_shared/structure/v32cVendored.test.ts). engine.ts and timeframes.ts are byte-identical to the frozen
// research files; this file only reproduces the research harness's cfg object.
//
// Seed dependency: the automatic seed calls smcAnalysis.detectSwingPoints(·, 5, 0.4), which uses calculateATR. Both
// function bodies are pinned by source hash in the test; any edit to them changes V3.2c and must be a new engine version.
import { calculateATR, detectSwingPoints, type Candle } from "../../smcAnalysis.ts";
import type { Bar, Config } from "./engine.ts";

export const V32C_ENGINE_VERSION = "v3.2c-frozen-20261013";

const toCandles = (bars: readonly Bar[]): Candle[] =>
  bars.map((b) => ({ datetime: "", open: b.o, high: b.h, low: b.l, close: b.c, volume: 0 }));

/** The exact frozen research configuration for one (pair, timeframe) state. */
export function frozenV32cConfig(tf: string): Config {
  return {
    tf,
    lookback: 5, // confirmation window: the swing's extreme is not exceeded by the next 5 completed bars
    depth: 0.5, // ≥ 50% wick-based correction of the reference leg qualifies
    confirm: "right", // V3.1 (b) right-side-only confirmation
    swingsAsOf: (bars) => detectSwingPoints(toCandles(bars), 5, 0.4).map((s) => ({ index: s.index, type: s.type })), // seed only
    atr: (bars) => calculateATR(toCandles(bars), 14), // unused in "right" mode; kept identical to the research cfg
    atrFilter: 0.4,
  };
}
