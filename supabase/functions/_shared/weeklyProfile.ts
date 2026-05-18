/**
 * weeklyProfile.ts — ICT Weekly Profile Detection
 *
 * Identifies which of the 12 ICT weekly profile patterns is forming based on
 * the current week's price action. Weekly profiles describe how the week's
 * high and low are typically established and which day tends to produce the
 * main directional move.
 *
 * Core ICT Weekly Profiles:
 *   1. Classic Bullish Tuesday Low — Tuesday makes the week's low, rally into Thursday/Friday
 *   2. Classic Bearish Tuesday High — Tuesday makes the week's high, sell-off into Thursday/Friday
 *   3. Consolidation Monday — Monday ranges tight, breakout Tuesday or Wednesday
 *   4. Wednesday Reversal — Mid-week reversal after Tuesday's directional move
 *   5. Seek & Destroy — Wednesday whipsaws both sides before Thursday trend
 *   6. London Close Reversal — Friday reversal during London close
 *   7. Expansion Monday — Monday breaks range, continuation through week
 *   8. Thursday Reversal — Late-week reversal after mid-week trend
 *
 * Day-of-Week Tendencies (ICT):
 *   - Monday: Accumulation / range establishment
 *   - Tuesday: Manipulation / false move (Judas swing)
 *   - Wednesday: Distribution / real move begins
 *   - Thursday: Continuation or reversal
 *   - Friday: Profit-taking / reduced participation
 *
 * Usage:
 *   - Helps anticipate WHEN the real move will happen during the week
 *   - Informs whether to be aggressive or patient on a given day
 *   - Provides context for the game plan's session-level analysis
 */

import type { Candle } from "./smcAnalysis.ts";
import { toNYTimeAt } from "./sessions.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export type WeeklyProfileType =
  | "classic_tuesday_low"      // Bullish: Tuesday low → rally
  | "classic_tuesday_high"     // Bearish: Tuesday high → sell-off
  | "consolidation_monday"     // Monday tight range, breakout pending
  | "wednesday_reversal"       // Mid-week reversal
  | "seek_and_destroy"         // Wednesday whipsaw
  | "expansion_monday"         // Monday breakout, continuation
  | "thursday_reversal"        // Late-week reversal
  | "london_close_reversal"    // Friday reversal
  | "developing"               // Not enough data yet to classify
  | "unknown";                 // Doesn't match known patterns

export type DayOfWeek = "monday" | "tuesday" | "wednesday" | "thursday" | "friday";

export interface DayTendency {
  day: DayOfWeek;
  tendency: "accumulation" | "manipulation" | "distribution" | "continuation" | "profit_taking";
  aggressiveness: "patient" | "moderate" | "aggressive";
  description: string;
}

export interface WeeklyProfile {
  /** Detected profile pattern */
  profile: WeeklyProfileType;
  /** Confidence in the detection (0-100) */
  confidence: number;
  /** Current day of the week */
  currentDay: DayOfWeek;
  /** Day index (0=Monday, 4=Friday) */
  dayIndex: number;
  /** Which day made the week's high so far */
  highDay: DayOfWeek | null;
  /** Which day made the week's low so far */
  lowDay: DayOfWeek | null;
  /** Week's high so far */
  weekHigh: number;
  /** Week's low so far */
  weekLow: number;
  /** Monday's range in pips (for consolidation detection) */
  mondayRangePips: number | null;
  /** Expected behavior for the rest of the week */
  expectation: string;
  /** Tendency for the current day */
  dayTendency: DayTendency;
  /** Whether the current day is favorable for new entries */
  favorableForEntry: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DAY_NAMES: DayOfWeek[] = ["monday", "tuesday", "wednesday", "thursday", "friday"];

const DAY_TENDENCIES: Record<DayOfWeek, DayTendency> = {
  monday: {
    day: "monday",
    tendency: "accumulation",
    aggressiveness: "patient",
    description: "Range establishment — smart money accumulates positions. Expect tight range or false breakouts.",
  },
  tuesday: {
    day: "tuesday",
    tendency: "manipulation",
    aggressiveness: "patient",
    description: "Judas swing day — expect false moves to trap retail. Wait for reversal confirmation.",
  },
  wednesday: {
    day: "wednesday",
    tendency: "distribution",
    aggressiveness: "aggressive",
    description: "Real move day — distribution begins. Best day for directional entries.",
  },
  thursday: {
    day: "thursday",
    tendency: "continuation",
    aggressiveness: "moderate",
    description: "Continuation or reversal — follow Wednesday's move or watch for exhaustion.",
  },
  friday: {
    day: "friday",
    tendency: "profit_taking",
    aggressiveness: "patient",
    description: "Profit-taking and position squaring. Reduced participation, avoid new entries after London close.",
  },
};

// ─── Core Detection ─────────────────────────────────────────────────────────

/**
 * Get the day of the week (0=Monday, 4=Friday) from a candle timestamp.
 * Uses NY-local time (via toNYTimeAt) to align with ICT trading day semantics.
 * JS Date.getDay() returns 0=Sunday, so we convert to 0=Mon, 4=Fri.
 */
function getCandleDayIndex(candle: Candle): number {
  const { nyDay } = toNYTimeAt(new Date(candle.datetime).getTime());
  // nyDay: 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat
  // Convert to 0=Mon, 1=Tue, ..., 4=Fri
  return nyDay === 0 ? 6 : nyDay - 1; // Sunday becomes 6 (weekend)
}

/**
 * Group daily candles into the current week's candles (Monday-Friday).
 * Returns candles indexed by day (0=Monday, 4=Friday).
 */
function getCurrentWeekCandles(dailyCandles: Candle[]): Map<number, Candle> {
  if (dailyCandles.length === 0) return new Map();

  const lastCandle = dailyCandles[dailyCandles.length - 1];
  const lastDate = new Date(lastCandle.datetime);

  // Find the Monday of the current week (using NY-local day index)
  const lastDayIndex = getCandleDayIndex(lastCandle);
  // Subtract days to get to Monday, then set to start of day (UTC approximation)
  const mondayDate = new Date(lastDate);
  mondayDate.setUTCDate(mondayDate.getUTCDate() - Math.min(lastDayIndex, 4));
  mondayDate.setUTCHours(0, 0, 0, 0);

  const weekCandles = new Map<number, Candle>();

  for (const candle of dailyCandles) {
    const candleDate = new Date(candle.datetime);
    const dayIndex = getCandleDayIndex(candle);

    // Check if this candle is in the current week (on or after Monday)
    if (candleDate >= mondayDate && dayIndex >= 0 && dayIndex <= 4) {
      weekCandles.set(dayIndex, candle);
    }
  }

  return weekCandles;
}

/**
 * Detect the weekly profile pattern from the current week's daily candles.
 *
 * @param dailyCandles - Daily candle array, newest last (needs at least current week's candles)
 * @param pipSize - Pip size for the instrument (for range calculations)
 * @returns WeeklyProfile with detected pattern and expectations
 */
export function detectWeeklyProfile(
  dailyCandles: Candle[],
  pipSize: number,
): WeeklyProfile {
  const weekCandles = getCurrentWeekCandles(dailyCandles);

  if (weekCandles.size === 0) {
    return makeDefaultProfile("developing", 0, "No weekly candles available");
  }

  // Determine current day
  const maxDayIndex = Math.max(...weekCandles.keys());
  const currentDay = DAY_NAMES[maxDayIndex] || "monday";

  // Calculate week's high and low
  let weekHigh = -Infinity;
  let weekLow = Infinity;
  let highDayIndex = 0;
  let lowDayIndex = 0;

  for (const [dayIdx, candle] of weekCandles) {
    if (candle.high > weekHigh) {
      weekHigh = candle.high;
      highDayIndex = dayIdx;
    }
    if (candle.low < weekLow) {
      weekLow = candle.low;
      lowDayIndex = dayIdx;
    }
  }

  const highDay = DAY_NAMES[highDayIndex] || null;
  const lowDay = DAY_NAMES[lowDayIndex] || null;

  // Monday's range for consolidation detection
  const mondayCandle = weekCandles.get(0);
  const mondayRangePips = mondayCandle
    ? (mondayCandle.high - mondayCandle.low) / pipSize
    : null;

  // Average daily range from recent history (for comparison)
  const recentCandles = dailyCandles.slice(-20);
  const avgDailyRange = recentCandles.length > 0
    ? recentCandles.reduce((sum, c) => sum + (c.high - c.low), 0) / recentCandles.length / pipSize
    : 0;

  // ── Pattern Detection ──
  let profile: WeeklyProfileType = "developing";
  let confidence = 0;
  let expectation = "";

  // Need at least Monday to start classifying
  if (weekCandles.size === 1 && maxDayIndex === 0) {
    // Only Monday — check for expansion or consolidation
    if (mondayRangePips !== null && avgDailyRange > 0) {
      if (mondayRangePips > avgDailyRange * 1.5) {
        profile = "expansion_monday";
        confidence = 40;
        expectation = "Monday expanded beyond average — expect continuation Tuesday-Wednesday. Look for pullback entries.";
      } else if (mondayRangePips < avgDailyRange * 0.6) {
        profile = "consolidation_monday";
        confidence = 45;
        expectation = "Monday consolidated — expect breakout Tuesday or Wednesday. Wait for direction confirmation.";
      } else {
        profile = "developing";
        confidence = 20;
        expectation = "Monday range is average — pattern will become clearer Tuesday.";
      }
    }
  } else if (weekCandles.size >= 2) {
    const tuesdayCandle = weekCandles.get(1);

    if (tuesdayCandle && mondayCandle) {
      const tuesdayRange = (tuesdayCandle.high - tuesdayCandle.low) / pipSize;
      const tuesdayClose = tuesdayCandle.close;
      const mondayMid = (mondayCandle.high + mondayCandle.low) / 2;

      // Classic Tuesday Low: Tuesday makes the week's low and closes higher
      if (lowDayIndex === 1 && tuesdayClose > mondayMid) {
        profile = "classic_tuesday_low";
        confidence = maxDayIndex >= 2 ? 70 : 55;
        expectation = "Tuesday established the week's low — expect bullish continuation Wednesday-Thursday. Look for long entries on pullbacks.";
      }
      // Classic Tuesday High: Tuesday makes the week's high and closes lower
      else if (highDayIndex === 1 && tuesdayClose < mondayMid) {
        profile = "classic_tuesday_high";
        confidence = maxDayIndex >= 2 ? 70 : 55;
        expectation = "Tuesday established the week's high — expect bearish continuation Wednesday-Thursday. Look for short entries on pullbacks.";
      }
      // Wednesday Reversal: Tuesday trends, Wednesday reverses
      else if (maxDayIndex >= 2) {
        const wednesdayCandle = weekCandles.get(2);
        if (wednesdayCandle) {
          const tuesdayBullish = tuesdayCandle.close > tuesdayCandle.open;
          const wednesdayBearish = wednesdayCandle.close < wednesdayCandle.open;
          const tuesdayBearish = tuesdayCandle.close < tuesdayCandle.open;
          const wednesdayBullish = wednesdayCandle.close > wednesdayCandle.open;

          if ((tuesdayBullish && wednesdayBearish) || (tuesdayBearish && wednesdayBullish)) {
            const wednesdayRange = (wednesdayCandle.high - wednesdayCandle.low) / pipSize;
            if (wednesdayRange > tuesdayRange * 0.8) {
              profile = "wednesday_reversal";
              confidence = 60;
              expectation = wednesdayBullish
                ? "Wednesday reversed Tuesday's bearish move — expect bullish continuation Thursday."
                : "Wednesday reversed Tuesday's bullish move — expect bearish continuation Thursday.";
            }
          }

          // Seek & Destroy: Wednesday takes out both Tuesday's high and low
          if (wednesdayCandle.high > tuesdayCandle.high && wednesdayCandle.low < tuesdayCandle.low) {
            profile = "seek_and_destroy";
            confidence = 65;
            expectation = "Wednesday swept both sides (Seek & Destroy) — expect directional move Thursday. Wait for Thursday's direction before entering.";
          }
        }
      }
    }

    // Thursday Reversal: Check if Thursday reverses the mid-week trend
    if (maxDayIndex >= 3) {
      const wednesdayCandle = weekCandles.get(2);
      const thursdayCandle = weekCandles.get(3);
      if (wednesdayCandle && thursdayCandle) {
        const wedBullish = wednesdayCandle.close > wednesdayCandle.open;
        const thuBearish = thursdayCandle.close < thursdayCandle.open;
        const wedBearish = wednesdayCandle.close < wednesdayCandle.open;
        const thuBullish = thursdayCandle.close > thursdayCandle.open;

        if ((wedBullish && thuBearish) || (wedBearish && thuBullish)) {
          // Only override if current profile isn't already high-confidence
          if (confidence < 60) {
            profile = "thursday_reversal";
            confidence = 55;
            expectation = thuBullish
              ? "Thursday reversed Wednesday's bearish move — late-week bullish bias. Manage risk tightly."
              : "Thursday reversed Wednesday's bullish move — late-week bearish bias. Manage risk tightly.";
          }
        }
      }
    }

    // London Close Reversal: Friday reversal
    if (maxDayIndex >= 4) {
      const thursdayCandle = weekCandles.get(3);
      const fridayCandle = weekCandles.get(4);
      if (thursdayCandle && fridayCandle) {
        const thuBullish = thursdayCandle.close > thursdayCandle.open;
        const friBearish = fridayCandle.close < fridayCandle.open;
        const thuBearish = thursdayCandle.close < thursdayCandle.open;
        const friBullish = fridayCandle.close > fridayCandle.open;

        if ((thuBullish && friBearish) || (thuBearish && friBullish)) {
          if (confidence < 55) {
            profile = "london_close_reversal";
            confidence = 45;
            expectation = "Friday reversed Thursday — typical London close reversal. Avoid new entries, manage existing positions.";
          }
        }
      }
    }
  }

  // If still developing, provide generic expectation
  if (profile === "developing") {
    expectation = `Week is still developing (${currentDay}). Pattern will become clearer as more daily candles form.`;
    confidence = Math.min(confidence, 30);
  }

  // Determine if current day is favorable for entry
  const favorableForEntry = determineFavorableEntry(maxDayIndex, profile);

  return {
    profile,
    confidence,
    currentDay,
    dayIndex: maxDayIndex,
    highDay,
    lowDay,
    weekHigh: weekHigh === -Infinity ? 0 : weekHigh,
    weekLow: weekLow === Infinity ? 0 : weekLow,
    mondayRangePips,
    expectation,
    dayTendency: DAY_TENDENCIES[currentDay] || DAY_TENDENCIES.monday,
    favorableForEntry,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeDefaultProfile(
  profile: WeeklyProfileType,
  dayIndex: number,
  expectation: string,
): WeeklyProfile {
  const currentDay = DAY_NAMES[dayIndex] || "monday";
  return {
    profile,
    confidence: 0,
    currentDay,
    dayIndex,
    highDay: null,
    lowDay: null,
    weekHigh: 0,
    weekLow: 0,
    mondayRangePips: null,
    expectation,
    dayTendency: DAY_TENDENCIES[currentDay] || DAY_TENDENCIES.monday,
    favorableForEntry: dayIndex >= 1 && dayIndex <= 3, // Tue-Thu default
  };
}

/**
 * Determine if the current day is favorable for new entries based on
 * the detected weekly profile and day-of-week tendencies.
 */
function determineFavorableEntry(dayIndex: number, profile: WeeklyProfileType): boolean {
  // Friday is generally unfavorable (profit-taking)
  if (dayIndex >= 4) return false;

  // Monday is generally unfavorable (accumulation, wait for direction)
  // Exception: expansion_monday suggests early directional move
  if (dayIndex === 0) return profile === "expansion_monday";

  // Tuesday: favorable only if we expect a reversal (classic patterns)
  if (dayIndex === 1) {
    return profile === "classic_tuesday_low" || profile === "classic_tuesday_high" || profile === "developing";
  }

  // Wednesday: most favorable day (distribution)
  if (dayIndex === 2) return true;

  // Thursday: favorable for continuation, less so for reversal
  if (dayIndex === 3) {
    return profile !== "seek_and_destroy"; // S&D means Thursday is the real move
  }

  return true;
}
