/**
 * SMC confluence decision — the production orchestration, extracted. PURE.
 *
 * FOURTH SLICE. Same method as zone, direction and HTF context.
 *
 * WHAT WAS DUPLICATED. `runConfluenceAnalysis` is already shared and already
 * pure. What lived inline in bot-scanner was the INPUT ASSEMBLY: a dozen
 * underscore-prefixed fields injected onto `pairConfig` as a transport
 * mechanism, plus two null-gating rules that decide whether the scorer sees a
 * daily or hourly series at all. Those rules are behaviour — the thresholds
 * differ (daily needs 10 bars, hourly needs only 1) — and nothing outside this
 * module should have to know them.
 *
 * THE GAME PLAN IS AN ARGUMENT, NOT A DERIVATION. `_gamePlanContext` is read by
 * the scorer in four places (key levels, bias agreement, DOL take-profit
 * targets, and the returned context). It comes from a game plan CACHED in
 * scan_logs and reused while `isSameSession && hoursSinceLastGP <
 * gamePlanRefreshHours` — a database read plus a refresh clock, so it is not a
 * function of the candles at t. It is therefore passed in explicitly:
 *
 *   * production passes the live cached context exactly as it does today
 *   * a historical replay passes the RECORDED context production actually had
 *   * neither regenerates it from bars and pretends that is equivalent
 *
 * This module never reads scan_logs, or anything else.
 */

import { runConfluenceAnalysis } from "./confluenceScoring.ts";
import type { Candle } from "./smcAnalysis.ts";

/**
 * The game-plan context, as the scorer consumes it.
 *
 * Mirrors `StatefulInputs["gamePlanContext"]`. Null means "production had no
 * plan for this pair", which is a real state the scorer handles — it is not a
 * stand-in for "unknown". A replay that does not know must not call this.
 */
export interface GamePlanContext {
  bias: string | null;
  biasConfidence: number | null;
  keyLevels: unknown[] | null;
  dol: unknown;
  regime: string | null;
  tradeable: boolean | null;
  htfTrend: string | null;
  h4Trend: string | null;
  atr: number | null;
  isFocusPair: boolean | null;
}

/** The underscore-prefixed values production injects onto pairConfig. */
export interface ConfluenceInjections {
  fotsiResult: unknown;
  smtResult: unknown;
  h4Candles: Candle[] | null;
  structureCandles: Candle[] | null;
  structureTfLabel: string | null;
  htfPOIs: unknown[] | null;
  htfFibLevels: { d: unknown; h4: unknown; h1: unknown };
  htfPD: { d: unknown; h4: unknown; h1: unknown };
  htfLiquidityPools: { d: unknown[]; h4: unknown[]; h1: unknown[] };
  /** null is meaningful: "engine declined" vs "no override set". */
  overrideDirection: "long" | "short" | null;
}

export interface ConfluenceDecisionInput {
  entryCandles: Candle[];
  dailyCandles: Candle[];
  hourlyCandles: Candle[];
  /** Base pair config. Injections are applied to a COPY, never to this. */
  pairConfig: Record<string, unknown>;
  injections: ConfluenceInjections;
  /** Explicit stateful input. Never derived here. */
  gamePlanContext: GamePlanContext | null;
}

export interface ConfluenceDecisionResult {
  analysis: ReturnType<typeof runConfluenceAnalysis>;
  /** The config object the scorer actually saw, for forensic comparison. */
  effectiveConfig: Record<string, unknown>;
}

/**
 * Apply production's injections to a COPY of the pair config.
 *
 * Production mutates `pairConfig` in place and relies on it having been cloned
 * per instrument earlier. Copying here makes that independent of the caller, so
 * a historical replay cannot leak one symbol's context into the next — a class
 * of bug that would be invisible in a single-symbol test.
 */
export function applyConfluenceInjections(
  pairConfig: Record<string, unknown>,
  inj: ConfluenceInjections,
  gamePlanContext: GamePlanContext | null,
): Record<string, unknown> {
  return {
    ...pairConfig,
    _fotsiResult: inj.fotsiResult,
    _smtResult: inj.smtResult,
    _h4Candles: inj.h4Candles,
    _structureCandles: inj.structureCandles,
    _structureTfLabel: inj.structureTfLabel,
    _htfPOIs: inj.htfPOIs,
    _htfFibLevels: inj.htfFibLevels,
    _htfPD: inj.htfPD,
    _htfLiquidityPools: inj.htfLiquidityPools,
    _overrideDirection: inj.overrideDirection,
    _gamePlanContext: gamePlanContext,
  };
}

/**
 * Run confluence scoring exactly as bot-scanner does.
 *
 * The two gating rules are NOT symmetrical and are reproduced verbatim: daily
 * is passed only at >= 10 bars and otherwise becomes `null`, while hourly is
 * passed at >= 1 bar and otherwise becomes `undefined`. null and undefined are
 * different arguments to the scorer, so neither may be normalised.
 */
export function decideConfluence(input: ConfluenceDecisionInput): ConfluenceDecisionResult {
  const effectiveConfig = applyConfluenceInjections(
    input.pairConfig, input.injections, input.gamePlanContext,
  );
  const analysis = runConfluenceAnalysis(
    input.entryCandles,
    input.dailyCandles.length >= 10 ? input.dailyCandles : null,
    effectiveConfig as never,
    input.hourlyCandles.length > 0 ? input.hourlyCandles : undefined,
  );
  return { analysis, effectiveConfig };
}

/** The confluence fields production records on `detail`, for parity checking. */
export function confluenceDetailShape(
  a: ReturnType<typeof runConfluenceAnalysis>,
): Record<string, unknown> {
  const x = a as unknown as Record<string, unknown>;
  return {
    score: x.score ?? null,
    factorCount: Array.isArray(x.factors) ? (x.factors as unknown[]).length : null,
    tieredScoring: x.tieredScoring ?? null,
    direction: x.direction ?? null,
    lastPrice: x.lastPrice ?? null,
  };
}
