/**
 * SMC direction decision — the production orchestration, extracted. PURE.
 *
 * SECOND SLICE. The zone slice proved the method: lift the orchestration, leave
 * the algorithms where they are, then verify field-by-field against what
 * production actually recorded. This does the same for direction.
 *
 * WHAT WAS DUPLICATED. `determineDirectionStyleAware` and `determineDirection`
 * were already shared and already pure. What lived inline in bot-scanner was
 * the style branch, the dirConfig assembly, and — the part that actually bit —
 * the field-by-field remap from StyleDirectionResult to DirectionResult. That
 * remap silently drops anything not explicitly listed, which is how
 * `blockedRetracement` came to be recorded at the block and then read as 0 of
 * 148. It is reproduced here exactly, including that hazard, because fixing it
 * would be an undetectable strategy change.
 *
 * MARKET-DRIVEN. Everything here is a function of candles and frozen config.
 * No database, no network, no wall clock — so it is replayable causally from
 * historical bars at any time t, which is the whole point of this slice.
 *
 * NOT INCLUDED: computeDirectionVerdict. It consumes a news-enriched game-plan
 * bias, and there is no historical news store, so it cannot be replayed from
 * market data alone. It belongs on the stateful side of the boundary.
 */

import {
  determineDirection, determineDirectionStyleAware, STYLE_TF_LABELS,
  type DirectionResult, type StyleDirectionResult,
} from "./directionEngine.ts";
import type { Candle } from "./smcAnalysis.ts";

export type DirectionStyle = "scalper" | "day_trader" | "swing_trader";

/** The series the style branch selects from. Names match bot-scanner's. */
export interface DirectionSeries {
  candles: Candle[];          // entry timeframe for the active style
  m15Candles: Candle[];
  hourlyCandles: Candle[];
  h4Candles: Candle[];
  dailyCandles: Candle[];
  weeklyCandles: Candle[] | null;
}

/** Config the direction engine reads, with production's defaults applied. */
export interface DirectionConfig {
  h4ChochLookback: number;
  h1BosLookback: number;
  useConfirmedTrend: boolean;
  fibFactor: number;
  trendSwingLookback: number;
  priceAwareStructureBlocks: boolean;
}

/**
 * Assemble dirConfig exactly as bot-scanner does, defaults included.
 *
 * The defaults are part of the behaviour: a pair config that omits
 * `simpleDirectionH4ChochLookback` gets 10, and a replay that omits the default
 * gets undefined and a different answer.
 */
export function buildDirectionConfig(pairConfig: Record<string, unknown>): DirectionConfig {
  return {
    h4ChochLookback: (pairConfig.simpleDirectionH4ChochLookback as number) ?? 10,
    h1BosLookback: (pairConfig.simpleDirectionH1BosLookback as number) ?? 8,
    useConfirmedTrend: (pairConfig.useConfirmedTrend as boolean) ?? true,
    fibFactor: (pairConfig.confirmedTrendFibFactor as number) ?? 0.25,
    trendSwingLookback: (pairConfig.confirmedTrendSwingLookback as number) ?? 5,
    // Default false — current behaviour. When true the two structural hard
    // blocks respect price instead of candle count.
    priceAwareStructureBlocks: pairConfig.priceAwareStructureBlocks === true,
  };
}

/** Which three series a style feeds to the engine, and the labels it reports. */
export function resolveDirectionSeries(
  style: DirectionStyle, s: DirectionSeries,
): { bias: Candle[] | null; structure: Candle[] | null; confirm: Candle[] | null } {
  if (style === "scalper") {
    // bias=1H, structure=15m, confirm=5m (entry candles)
    return {
      bias: s.hourlyCandles.length >= 20 ? s.hourlyCandles : null,
      structure: s.m15Candles.length >= 20 ? s.m15Candles : null,
      confirm: s.candles.length >= 20 ? s.candles : null,
    };
  }
  if (style === "swing_trader") {
    // bias=Weekly, structure=Daily, confirm=4H
    return {
      bias: s.weeklyCandles && s.weeklyCandles.length >= 20 ? s.weeklyCandles : null,
      structure: s.dailyCandles.length >= 20 ? s.dailyCandles : null,
      confirm: s.h4Candles.length >= 20 ? s.h4Candles : null,
    };
  }
  // Day trader: bias=Daily, structure=4H, confirm=1H
  return {
    bias: s.dailyCandles.length >= 20 ? s.dailyCandles : null,
    structure: s.h4Candles.length >= 20 ? s.h4Candles : null,
    confirm: s.hourlyCandles.length >= 20 ? s.hourlyCandles : null,
  };
}

export interface DirectionDecisionInput {
  style: DirectionStyle;
  series: DirectionSeries;
  dirConfig: DirectionConfig;
  /** `pairConfig.useSimpleDirection`. When false, production runs neither engine. */
  useSimpleDirection: boolean;
}

export interface DirectionDecisionResult {
  evaluated: boolean;
  styleDirection: StyleDirectionResult | null;
  simpleDirection: DirectionResult | null;
  /** The `detail.simpleDirection` shape the dashboard and scan_logs record. */
  detailShape: Record<string, unknown> | null;
  /** What production writes to `pairConfig._overrideDirection`. */
  overrideDirection: "long" | "short" | null;
}

/**
 * Run the direction decision exactly as bot-scanner does.
 *
 * `evaluated: false` means production would not have run the engine at all
 * (`useSimpleDirection` off), which is a different fact from "ran and found no
 * direction" — the latter still sets an explicit null override downstream.
 */
export function decideDirection(input: DirectionDecisionInput): DirectionDecisionResult {
  if (!input.useSimpleDirection) {
    return {
      evaluated: false, styleDirection: null, simpleDirection: null,
      detailShape: null, overrideDirection: null,
    };
  }

  const picked = resolveDirectionSeries(input.style, input.series);
  let styleDirection: StyleDirectionResult | null = null;
  let simpleDirection: DirectionResult;

  if (input.style === "day_trader") {
    // Day trader keeps the original function, not the style-aware one.
    simpleDirection = determineDirection(
      picked.bias, picked.structure, picked.confirm, input.dirConfig as never,
    );
  } else {
    styleDirection = determineDirectionStyleAware(
      picked.bias, picked.structure, picked.confirm,
      // Labels are resolved HERE from the engine's own exported table, not
      // passed in. Mirroring that constant in a caller is how a label ends up
      // reading "bias" instead of "1H" — and the labels reach the recorded
      // reason string and biasSource, so a wrong one is a visible behaviour
      // change, not cosmetics.
      { ...input.dirConfig, ...STYLE_TF_LABELS[input.style] } as never,
    );
    const tag = input.style === "scalper" ? "scalper" : "swing";
    // Field-by-field remap, verbatim. Anything added to StyleDirectionResult is
    // silently dropped unless listed here — that is how blockedRetracement was
    // lost once already. Reproduced, not repaired.
    simpleDirection = {
      direction: styleDirection.direction,
      bias: styleDirection.bias,
      biasSource: styleDirection.biasSource,
      h4Retrace: styleDirection.structureRetrace,
      h4ChochAgainst: styleDirection.structureChochAgainst,
      h1Confirmed: styleDirection.confirmBOS,
      blockedRetracement: styleDirection.blockedRetracement,
      reason: `[${tag}] ${styleDirection.reason}`,
    } as DirectionResult;
  }

  const detailShape = {
    direction: simpleDirection.direction,
    bias: simpleDirection.bias,
    biasSource: simpleDirection.biasSource,
    h4Retrace: simpleDirection.h4Retrace,
    h4ChochAgainst: simpleDirection.h4ChochAgainst,
    h1Confirmed: simpleDirection.h1Confirmed,
    reason: simpleDirection.reason,
  };

  return {
    evaluated: true,
    styleDirection,
    simpleDirection,
    detailShape,
    // Explicit null when the engine declines — production distinguishes
    // "no override set" from "override set to null".
    overrideDirection: (simpleDirection.direction as "long" | "short" | null) ?? null,
  };
}
