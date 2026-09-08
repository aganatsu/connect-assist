/**
 * thesisValidator.ts — Pending Order Thesis Validation
 * ─────────────────────────────────────────────────────
 * Re-checks structural conditions for active pending orders each scan cycle.
 * Three checks:
 *   1. Direction Flip (HARD cancel) — D1/4H/1H structure reversed
 *   2. FOTSI Veto (HARD cancel) — currency exhaustion would block entry now
 *   3. Game Plan Bias Reversal (SOFT cancel) — session bias flipped with high confidence
 *
 * Design principle: FAIL-OPEN. If any check errors or data is missing,
 * the order stays alive. Only cancel on confirmed invalidation.
 *
 * Run: deno test --allow-all supabase/functions/_shared/thesisValidator.test.ts
 */

import {
  determineDirection,
  determineDirectionStyleAware,
  STYLE_TF_LABELS,
  type DirectionResult,
} from "./directionEngine.ts";
import {
  checkOverboughtOversoldVeto,
  parsePairCurrencies,
  type FOTSIResult,
  type VetoResult,
} from "./fotsi.ts";
import type { Candle } from "./smcAnalysis.ts";
import type { SessionGamePlan, InstrumentGamePlan } from "./gamePlan.ts";

// ── Public types ──

export type ThesisCheckType = "direction_flip" | "fotsi_veto" | "gp_bias_reversal";

/** What a single check concluded, recorded whether or not the check can act. */
export interface ThesisCheckObservation {
  type: ThesisCheckType;
  /** Would this check have invalidated the order? */
  wouldInvalidate: boolean;
  /** Was it allowed to act, or only observed? */
  enabled: boolean;
  /** Did it run at all, or was the data it needs missing? */
  ran: boolean;
  reason: string | null;
  /**
   * For direction_flip: what the OTHER engine concluded on the same order, when
   * its candles were available. The check has always run the legacy
   * Daily/4H/1H engine while the order was created by the style-aware one, so
   * a "flip" may be engine disagreement rather than a change in the market.
   * Recording both makes fix-vs-delete an observation instead of a judgement:
   * agreement means the check sees something real, persistent disagreement
   * means it is measuring the mismatch.
   */
  alternate?: {
    engine: "legacy" | "style_aware";
    direction: string | null;
    confidence: number;
    wouldInvalidate: boolean;
  } | null;
}

export interface ThesisValidationResult {
  /** Whether the pending order thesis is still valid */
  valid: boolean;
  /** Human-readable reason for invalidation (null if valid) */
  reason: string | null;
  /** Which check triggered the invalidation (null if valid) */
  checkType: ThesisCheckType | null;
  /** Structured cancel reason string for DB storage */
  cancelReason: string | null;
  /**
   * Every check's conclusion, including checks that are switched off and checks
   * whose data was missing. Recorded so "how often would this fire?" is
   * answerable from scan detail rather than by argument. Measured 2026-09-06:
   * of 645 pending-order cancellations, 202 came from this validator — 101
   * direction_flip and 101 gp_bias_reversal.
   */
  checks: ThesisCheckObservation[];
}

export interface PendingOrderForValidation {
  order_id: string;
  symbol: string;
  direction: "long" | "short";
  entry_price: number | string;
  signal_reason?: any;
}

export interface ThesisValidationOpts {
  fotsiResult: FOTSIResult | null;
  lastGamePlan: SessionGamePlan | null;
  dailyCandles: Candle[] | null;
  h4Candles: Candle[] | null;
  h1Candles: Candle[] | null;
  /** Minimum confidence for direction flip to trigger cancel (default: 0.6) */
  directionFlipMinConfidence?: number;
  /** Minimum GP bias confidence to trigger cancel (default: 60) */
  gpBiasMinConfidence?: number;
  /**
   * The SAME setting the entry gate uses for the game plan bias.
   *
   * bot-scanner:6010 reads gamePlanGateMode and on "soft" deliberately ALLOWS
   * a trade whose direction opposes the plan, recording it as advisory. This
   * validator never read it, and cancelled that trade a minute later — two
   * gates, one input, opposite conclusions. Observed 2026-09-08: XAU/USD long
   * armed and cancelled repeatedly, "New York session bias is bearish
   * (confidence 64%)", while the entry gate was in soft mode.
   *
   * Only "hard" may cancel. "off" and "soft" observe, matching entry.
   */
  gamePlanGateMode?: "off" | "soft" | "hard" | string | null;
  /**
   * Per-check switches. A disabled check still RUNS and is still recorded — it
   * simply cannot cancel. Default is all enabled, which is the behaviour that
   * has always been in place.
   */
  enabledChecks?: Partial<Record<ThesisCheckType, boolean>>;
  /**
   * Use the same direction engine the SIGNAL used, rather than always the
   * legacy Daily/4H/1H one.
   *
   * The order is created by determineDirectionStyleAware on the style's own
   * timeframes (scalper: 1H/15m/5m) with dirConfig applied. This validator has
   * always cancelled using determineDirection(daily, h4, h1) with NO config —
   * a different function, on timeframes the style never uses, with
   * priceAwareStructureBlocks forced off. So `direction_flip` could mean "a
   * different method disagrees" rather than "the thesis changed", from the
   * moment the order was armed.
   *
   * Off by default: correcting it changes which orders get cancelled.
   */
  styleAwareDirection?: boolean;
  /** Trading style, for the style-aware path. */
  style?: string | null;
  /** Bias / structure / confirm candles for the style-aware path. */
  styleCandles?: {
    bias: Candle[] | null;
    structure: Candle[] | null;
    confirm: Candle[] | null;
  } | null;
  /** The same DirectionConfig the scanner builds, so flags are honoured. */
  dirConfig?: Record<string, unknown> | null;
}

// ── Constants ──

const DEFAULT_DIRECTION_FLIP_MIN_CONFIDENCE = 0.6;
const DEFAULT_GP_BIAS_MIN_CONFIDENCE = 60;
const MIN_CANDLES_FOR_DIRECTION = 20;

// ── Helpers ──

/**
 * Determine a "confidence" score for the direction result.
 * The direction engine doesn't return a numeric confidence, so we derive one
 * from the structural signals:
 *   - h1Confirmed = +0.3
 *   - h4Retrace = +0.2 (structure intact, pulling back)
 *   - !h4ChochAgainst = +0.2 (no counter-CHoCH)
 *   - direction != null = +0.3 (base confidence)
 */
export function estimateDirectionConfidence(result: DirectionResult): number {
  if (!result.direction) return 0;
  let confidence = 0.3; // base: direction was determined
  if (result.h1Confirmed) confidence += 0.3;
  if (result.h4Retrace) confidence += 0.2;
  if (!result.h4ChochAgainst) confidence += 0.2;
  return confidence;
}

/**
 * Check if a game plan bias opposes the pending order direction.
 */
function biasOpposesDirection(
  bias: "bullish" | "bearish" | "neutral",
  direction: "long" | "short",
): boolean {
  if (bias === "neutral") return false;
  if (direction === "long" && bias === "bearish") return true;
  if (direction === "short" && bias === "bullish") return true;
  return false;
}

// ── Main validation function ──

/**
 * Validate whether a pending order's original thesis is still intact.
 *
 * Runs three checks in order (cheapest first):
 *   1. FOTSI veto (no extra API calls — uses pre-computed result)
 *   2. GP bias reversal (no extra API calls — uses pre-loaded game plan)
 *   3. Direction flip (requires candle data — may use cached candles)
 *
 * Returns { valid: true } if all checks pass or if data is unavailable (fail-open).
 */
export function validatePendingOrderThesis(
  pending: PendingOrderForValidation,
  opts: ThesisValidationOpts,
): ThesisValidationResult {
  const dirFlipMinConf = opts.directionFlipMinConfidence ?? DEFAULT_DIRECTION_FLIP_MIN_CONFIDENCE;
  const gpBiasMinConf = opts.gpBiasMinConfidence ?? DEFAULT_GP_BIAS_MIN_CONFIDENCE;

  const checks: ThesisCheckObservation[] = [];
  const isEnabled = (t: ThesisCheckType) => opts.enabledChecks?.[t] !== false;
  /** First enabled check that wants to invalidate wins; the rest still record. */
  let verdict: ThesisValidationResult | null = null;
  const record = (
    type: ThesisCheckType,
    ran: boolean,
    wouldInvalidate: boolean,
    reason: string | null,
    cancelReason: string | null,
    alternate?: ThesisCheckObservation["alternate"],
  ) => {
    checks.push({ type, wouldInvalidate, enabled: isEnabled(type), ran, reason, alternate: alternate ?? null });
    if (wouldInvalidate && isEnabled(type) && !verdict) {
      verdict = { valid: false, reason, checkType: type, cancelReason, checks };
    }
  };

  // ── Check 1: FOTSI Veto ──
  // Cheapest check — uses pre-computed FOTSI result, zero API cost
  if (opts.fotsiResult && opts.fotsiResult.strengths) {
    try {
      const currencies = parsePairCurrencies(pending.symbol);
      if (currencies) {
        const [base, quote] = currencies;
        const fotsiDirection = pending.direction === "long" ? "BUY" : "SELL";
        const vetoResult: VetoResult = checkOverboughtOversoldVeto(
          base,
          quote,
          fotsiDirection as "BUY" | "SELL",
          opts.fotsiResult.strengths,
          opts.fotsiResult.series,
        );
        const baseTSI = opts.fotsiResult.strengths[base] ?? 0;
        const exhaustionType = pending.direction === "long" ? "overbought" : "oversold";
        record(
          "fotsi_veto", true, vetoResult.vetoed,
          vetoResult.vetoed ? `FOTSI thesis invalidation: ${vetoResult.reason}` : null,
          vetoResult.vetoed
            ? `thesis_invalid:fotsi_veto:${base}_${exhaustionType}_${baseTSI.toFixed(0)}`
            : null,
        );
      } else {
        record("fotsi_veto", false, false, "pair currencies unparseable", null);
      }
    } catch (e) {
      // Fail-open: FOTSI check errored, keep order alive
      console.warn(`[thesis-validator] FOTSI check error for ${pending.symbol}: ${(e as Error)?.message}`);
      record("fotsi_veto", false, false, `error: ${(e as Error)?.message}`, null);
    }
  } else {
    record("fotsi_veto", false, false, "no FOTSI result available", null);
  }

  // ── Check 2: Game Plan Bias Reversal ──
  // Uses pre-loaded game plan — zero API cost
  if (opts.lastGamePlan && opts.lastGamePlan.plans) {
    try {
      const pairPlan: InstrumentGamePlan | undefined = opts.lastGamePlan.plans.find(
        (p) => p.symbol === pending.symbol,
      );
      if (!pairPlan) {
        record("gp_bias_reversal", false, false, "no plan for this symbol", null);
      } else if (pairPlan.biasConfidence < gpBiasMinConf) {
        record(
          "gp_bias_reversal", true, false,
          `bias confidence ${pairPlan.biasConfidence}% below ${gpBiasMinConf}%`, null,
        );
      } else {
        const opposes = biasOpposesDirection(pairPlan.bias, pending.direction);
        // Honour the entry gate's policy. In "off" or "soft" the opposition is
        // recorded but must not cancel, because entry already decided to allow
        // it on exactly this information.
        const gateMode = opts.gamePlanGateMode ?? "soft";
        const mayCancel = gateMode === "hard";
        record(
          "gp_bias_reversal", true, opposes && mayCancel,
          opposes
            ? `Game plan bias reversal: ${opts.lastGamePlan.session} session bias is ${pairPlan.bias} (confidence ${pairPlan.biasConfidence}%) — opposes ${pending.direction} order${mayCancel ? "" : ` [gamePlanGateMode=${gateMode}, observed only]`}`
            : null,
          opposes && mayCancel
            ? `thesis_invalid:gp_bias_reversal:${opts.lastGamePlan.session}:${pairPlan.bias}:${pairPlan.biasConfidence}`
            : null,
        );
      }
    } catch (e) {
      // Fail-open: GP check errored, keep order alive
      console.warn(`[thesis-validator] GP bias check error for ${pending.symbol}: ${(e as Error)?.message}`);
      record("gp_bias_reversal", false, false, `error: ${(e as Error)?.message}`, null);
    }
  } else {
    // Measured 2026-09-06: the caller looked for the plan in the last 20
    // scan_logs rows, and plans regenerate roughly every 4 hours while scans
    // write a row every cycle — so this branch was taken most of the time and
    // the check fired based on scan timing rather than on bias reversing.
    record("gp_bias_reversal", false, false, "no game plan loaded", null);
  }

  // ── Check 3: Direction Flip ──
  // Most expensive check — requires candle data (but may be cached)
  //
  // Which engine runs here is the crux. The order was created by
  // determineDirectionStyleAware on the style's own timeframes with dirConfig
  // applied; this has always used determineDirection(daily, h4, h1) with no
  // config. Under styleAwareDirection the validator matches the creator.
  const styleAware = opts.styleAwareDirection === true && !!opts.styleCandles;
  const enough = (c: Candle[] | null | undefined) =>
    !!c && c.length >= MIN_CANDLES_FOR_DIRECTION;

  // Either engine's data is enough to attempt the check; which one DECIDES is
  // styleAware, but both are judged and recorded when their candles are present.
  const canRunDirection = enough(opts.dailyCandles) || enough(opts.h4Candles)
    || enough(opts.styleCandles?.bias) || enough(opts.styleCandles?.structure);

  if (canRunDirection) {
    try {
      const labels = STYLE_TF_LABELS[opts.style ?? "day_trader"] ?? STYLE_TF_LABELS.day_trader;

      /** Run the style-aware engine on the style's own timeframes. */
      const runStyleAware = (): DirectionResult | null => {
        if (!opts.styleCandles) return null;
        if (!enough(opts.styleCandles.bias) && !enough(opts.styleCandles.structure)) return null;
        const sr = determineDirectionStyleAware(
          enough(opts.styleCandles.bias) ? opts.styleCandles.bias : null,
          enough(opts.styleCandles.structure) ? opts.styleCandles.structure : null,
          enough(opts.styleCandles.confirm) ? opts.styleCandles.confirm : null,
          { ...(opts.dirConfig ?? {}), ...labels } as never,
        );
        // Same mapping bot-scanner uses downstream, so estimateDirectionConfidence
        // sees equivalent fields either way.
        return {
          direction: sr.direction,
          bias: sr.bias,
          biasSource: sr.biasSource,
          h4Retrace: sr.structureRetrace,
          h4ChochAgainst: sr.structureChochAgainst,
          h1Confirmed: sr.confirmBOS,
          reason: `[${opts.style ?? "day_trader"}] ${sr.reason}`,
        } as DirectionResult;
      };

      /** Run the legacy Daily/4H/1H engine. */
      const runLegacy = (): DirectionResult | null => {
        if (!enough(opts.dailyCandles) && !enough(opts.h4Candles)) return null;
        return determineDirection(
          enough(opts.dailyCandles) ? opts.dailyCandles : null,
          enough(opts.h4Candles) ? opts.h4Candles : null,
          enough(opts.h1Candles) ? opts.h1Candles : null,
          (opts.dirConfig ?? undefined) as never,
        );
      };

      /** Reduce a direction result to the cancel decision for this order. */
      const judge = (r: DirectionResult | null) => {
        if (!r) return null;
        const opposed = r.direction !== null && r.direction !== pending.direction;
        const confidence = opposed ? estimateDirectionConfidence(r) : 0;
        return { r, opposed, confidence, wouldInvalidate: opposed && confidence >= dirFlipMinConf };
      };

      const styleJudged = judge(runStyleAware());
      const legacyJudged = judge(runLegacy());
      const primary = styleAware ? (styleJudged ?? legacyJudged) : (legacyJudged ?? styleJudged);
      const other = styleAware ? legacyJudged : styleJudged;

      if (!primary) {
        record("direction_flip", false, false, "insufficient candles", null);
      } else {
        const alt = other
          ? {
            engine: (styleAware ? "legacy" : "style_aware") as "legacy" | "style_aware",
            direction: other.r.direction,
            confidence: other.confidence,
            wouldInvalidate: other.wouldInvalidate,
          }
          : null;
        record(
          "direction_flip", true, primary.wouldInvalidate,
          primary.wouldInvalidate
            ? `Direction flip: structure now indicates ${primary.r.direction} (confidence ${(primary.confidence * 100).toFixed(0)}%) — opposes ${pending.direction} order. ${primary.r.reason}`
            : primary.opposed
            ? `opposed but confidence ${(primary.confidence * 100).toFixed(0)}% below ${(dirFlipMinConf * 100).toFixed(0)}%`
            : null,
          primary.wouldInvalidate
            ? `thesis_invalid:direction_flip:${primary.r.direction}:${(primary.confidence * 100).toFixed(0)}`
            : null,
          alt,
        );
      }
    } catch (e) {
      // Fail-open: direction check errored, keep order alive
      console.warn(`[thesis-validator] Direction check error for ${pending.symbol}: ${(e as Error)?.message}`);
      record("direction_flip", false, false, `error: ${(e as Error)?.message}`, null);
    }
  } else {
    record("direction_flip", false, false, "insufficient candles", null);
  }

  return verdict ?? { valid: true, reason: null, checkType: null, cancelReason: null, checks };
}
