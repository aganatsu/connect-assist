/**
 * The frozen instrument set, and the runtime-state key. ONE definition.
 *
 * WHY THIS MODULE EXISTS. The bootstrap now runs off-Edge and the Edge function
 * restores what it wrote. That only works if both agree on four things exactly:
 * the instrument, the timeframe, the volatility gate, and the identity of the
 * cost model. `ipoEngineState.restoreState` compares all four and refuses on any
 * mismatch — which is the right behaviour, and also means a duplicated spec
 * would present as a mysterious `INSTRUMENT_CONFIG_CHANGED` rebuild loop rather
 * than as the copy-paste error it actually was.
 *
 * `ipo-observation` and `ipo-paper-runner` previously each carried their own
 * copy of this list. They agreed by luck and inspection; now they agree by
 * construction.
 *
 * `costModelId` is the part that cannot be derived. `costPerSide` is a function
 * and cannot cross a serialisation boundary, so the state records a declared
 * name for it. Change the arithmetic and you MUST change the id, or restored
 * state will silently re-price an open trade under a model it was not built
 * with.
 */

import { STRATEGY_ID, STRATEGY_VERSION } from "./ipoPaperContract.ts";
import type { EngineConfig } from "./ipoLiveEngine.ts";
import type { ExportMeta } from "./ipoEngineState.ts";

export interface IpoInstrument {
  instrument: string;
  timeframe: string;
  barMs: number;
  highVolOnly: boolean;
  costPerSide: (price: number) => number;
  /** Declared identity of `costPerSide`. Must change whenever the maths does. */
  costModelId: string;
}

/** The frozen spec, section 1. Nothing else is observed and nothing else trades. */
export const IPO_INSTRUMENTS: readonly IpoInstrument[] = [
  { instrument: "EUR/USD", timeframe: "1h",    barMs: 3_600_000, highVolOnly: false,
    costPerSide: (_p) => 0.00008,   costModelId: "fx_fixed_0.00008" },
  { instrument: "USD/JPY", timeframe: "30min", barMs: 1_800_000, highVolOnly: false,
    costPerSide: (_p) => 0.008,     costModelId: "jpy_fixed_0.008" },
  { instrument: "BTC/USD", timeframe: "1h",    barMs: 3_600_000, highVolOnly: true,
    costPerSide: (p) => p * 0.0015, costModelId: "btc_prop_0.0015" },
] as const;

/**
 * Bars the BOOTSTRAP loads. Unchanged at 1,200 and deliberately not reduced:
 * shortening it would change which bars the whole-series functions see, and
 * therefore which trades exist. That is a strategy change, not a tuning knob,
 * and the Edge CPU limit is not a reason to make one.
 */
export const HISTORY_BARS = 1200;

/** Below the volatility warmup the bucket cannot resolve at all. */
export const MIN_HISTORY_BARS = 250;

/**
 * Bars a WARM Edge invocation fetches.
 *
 * Only bars after the persisted cursor are processed, but the page must overlap
 * the cursor to prove nothing is missing between the two.
 */
export const INCREMENTAL_BARS = 120;

/** The one runtime-state key. The bootstrap writes it; Edge restores it. */
export const engineStateKey = (symbol: string) =>
  `ipo_engine_state:${STRATEGY_ID}:${symbol}`;

export const engineConfig = (i: IpoInstrument): EngineConfig => ({
  instrument: i.instrument,
  timeframe: i.timeframe,
  highVolOnly: i.highVolOnly,
  costPerSide: i.costPerSide,
});

export const exportMeta = (i: IpoInstrument): ExportMeta => ({
  strategyVersion: STRATEGY_VERSION,
  costModelId: i.costModelId,
});

export const instrumentBySymbol = (symbol: string): IpoInstrument | undefined =>
  IPO_INSTRUMENTS.find((i) => i.instrument === symbol);
