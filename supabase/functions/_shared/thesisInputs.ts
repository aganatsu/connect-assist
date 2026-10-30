// The inputs of validatePendingOrderThesis, built in ONE place.
//
// The manage loop's cancel check and the scanner's pre-placement check must ask
// the same question of the same data; otherwise the pre-check passes an order
// the cancel check kills a minute later — the place-then-cancel loop this exists
// to end (Oct 2026: 65 direction_flip cancels from 22 setups, 61 within 2 min).
// Candles come through the caller's cached fetch with identical (interval,
// range) keys, so on a full scan the pre-check reuses what the pair loop fetched.

import type { Candle } from "./smcAnalysis.ts";
import type { FOTSIResult } from "./fotsi.ts";
import type { SessionGamePlan } from "./gamePlan.ts";
import type { ThesisValidationOpts } from "./thesisValidator.ts";

// deno-lint-ignore no-explicit-any
export type ThesisFetch = (sym: string, interval: string, range: string, reason: any) => Promise<Candle[]>;

export interface ThesisCandles {
  daily: Candle[];
  h4: Candle[];
  h1: Candle[];
  styleCandles: { bias: Candle[] | null; structure: Candle[] | null; confirm: Candle[] | null } | null;
}

/** D1/4H/1H for the legacy engine, plus the style's own series for the style-aware engine. */
export async function loadThesisCandles(
  fetch: ThesisFetch,
  symbol: string,
  o: { style: string; wantStyleCandles: boolean; confirmCandles: Candle[] | null; h4Window: number },
): Promise<ThesisCandles> {
  const [daily, h4, h1] = await Promise.all([
    fetch(symbol, "1d", "1y", "pending_thesis_htf"),
    fetch(symbol, "4h", "1mo", "pending_thesis_htf").then((c) => c.slice(-o.h4Window)),
    fetch(symbol, "1h", "5d", "pending_thesis_htf"),
  ]);
  let styleCandles: ThesisCandles["styleCandles"] = null;
  if (o.wantStyleCandles) {
    if (o.style === "scalper") {
      const m15 = await fetch(symbol, "15m", "5d", "pending_thesis_m15");
      styleCandles = { bias: h1, structure: m15, confirm: o.confirmCandles };
    } else if (o.style === "swing_trader") {
      const w = await fetch(symbol, "1w", "2y", "pending_thesis_weekly");
      styleCandles = { bias: w, structure: daily, confirm: h4 };
    } else {
      styleCandles = { bias: daily, structure: h4, confirm: h1 };
    }
  }
  return { daily, h4, h1, styleCandles };
}

/** The validator options, from the mapped GLOBAL config (the pending loop has no pairConfig). */
// deno-lint-ignore no-explicit-any
export function thesisValidationOpts(config: any, c: ThesisCandles, ctx: { fotsiResult: FOTSIResult | null; lastGamePlan: SessionGamePlan | null; style: string }): ThesisValidationOpts {
  return {
    fotsiResult: ctx.fotsiResult,
    lastGamePlan: ctx.lastGamePlan,
    dailyCandles: c.daily.length >= 20 ? c.daily : null,
    h4Candles: c.h4.length >= 20 ? c.h4 : null,
    h1Candles: c.h1.length >= 20 ? c.h1 : null,
    enabledChecks: {
      direction_flip: config.thesisCheckDirectionFlip !== false,
      fotsi_veto: config.thesisCheckFotsiVeto !== false,
      gp_bias_reversal: config.thesisCheckGpBiasReversal !== false,
    },
    // The same setting the entry gate applies, so one policy governs the game-plan bias end to end.
    gamePlanGateMode: config.gamePlanGateMode ?? "soft",
    styleAwareDirection: config.thesisDirectionStyleAware === true,
    style: ctx.style,
    styleCandles: c.styleCandles,
    // The same DirectionConfig the scanner builds, so flags such as priceAwareStructureBlocks are honoured.
    dirConfig: {
      structureLookback: config.structureLookback,
      priceAwareStructureBlocks: config.priceAwareStructureBlocks === true,
    },
  };
}
