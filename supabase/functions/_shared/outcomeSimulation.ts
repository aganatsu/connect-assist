export const DEFAULT_OUTCOME_WINDOW_HOURS = 24;

export interface OutcomeCandle {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface OutcomeResult {
  outcome_status: "inconclusive" | "would_have_won" | "would_have_lost";
  price_reached_entry: boolean;
  tp_hit: boolean;
  sl_hit: boolean;
  tp_hit_time_minutes: number | null;
  sl_hit_time_minutes: number | null;
  mfe_pips: number;
  mae_pips: number;
  outcome_reason: "target_first" | "stop_first" | "entry_not_reached" | "window_expired" | "ambiguous_entry_candle" | "ambiguous_same_candle";
  mfe_r: number | null;
  mae_r: number | null;
  outcome_r: number | null;
}

/**
 * Resolves a hypothetical trade from candles after the observation timestamp.
 *
 * Values named mfe_pips/mae_pips remain raw price units for compatibility with
 * the existing outcome tracker. Callers convert them with the symbol pip size.
 */
export function simulateOutcome(
  candles: OutcomeCandle[],
  direction: "long" | "short",
  entryPrice: number,
  stopLoss: number | null,
  takeProfit: number | null,
  observedAt: string,
  outcomeWindowHours = DEFAULT_OUTCOME_WINDOW_HOURS,
): OutcomeResult {
  const result: OutcomeResult = {
    outcome_status: "inconclusive",
    price_reached_entry: false,
    tp_hit: false,
    sl_hit: false,
    tp_hit_time_minutes: null,
    sl_hit_time_minutes: null,
    mfe_pips: 0,
    mae_pips: 0,
    outcome_reason: "entry_not_reached",
    mfe_r: null,
    mae_r: null,
    outcome_r: null,
  };

  const observedTime = new Date(observedAt).getTime();
  let entryReachedTime: number | null = null;
  let maxFavorable = 0;
  let maxAdverse = 0;

  for (const candle of candles) {
    const candleTime = new Date(candle.datetime).getTime();
    if (candleTime <= observedTime) continue;
    if (
      candleTime >
        observedTime + outcomeWindowHours * 60 * 60 * 1000
    ) break;

    let enteredThisCandle = false;
    if (!result.price_reached_entry) {
      if (direction === "long" && candle.low <= entryPrice) {
        result.price_reached_entry = true;
        entryReachedTime = candleTime;
        enteredThisCandle = true;
      } else if (direction === "short" && candle.high >= entryPrice) {
        result.price_reached_entry = true;
        entryReachedTime = candleTime;
        enteredThisCandle = true;
      }
      if (!result.price_reached_entry) continue;
    }

    if (entryReachedTime !== null) {
      let tpHitThisCandle = false;
      let slHitThisCandle = false;

      if (direction === "long") {
        maxFavorable = Math.max(maxFavorable, candle.high - entryPrice);
        maxAdverse = Math.max(maxAdverse, entryPrice - candle.low);
        tpHitThisCandle = takeProfit !== null && candle.high >= takeProfit;
        slHitThisCandle = stopLoss !== null && candle.low <= stopLoss;
      } else {
        maxFavorable = Math.max(maxFavorable, entryPrice - candle.low);
        maxAdverse = Math.max(maxAdverse, candle.high - entryPrice);
        tpHitThisCandle = takeProfit !== null && candle.low <= takeProfit;
        slHitThisCandle = stopLoss !== null && candle.high >= stopLoss;
      }

      if (tpHitThisCandle && slHitThisCandle) {
        result.tp_hit = true;
        result.sl_hit = true;
        result.tp_hit_time_minutes = Math.round(
          (candleTime - entryReachedTime) / 60000,
        );
        result.sl_hit_time_minutes = result.tp_hit_time_minutes;
        result.outcome_status = "inconclusive";
        result.outcome_reason = enteredThisCandle ? "ambiguous_entry_candle" : "ambiguous_same_candle";
        break;
      }

      if (enteredThisCandle && (tpHitThisCandle || slHitThisCandle)) {
        result.tp_hit = tpHitThisCandle;
        result.sl_hit = slHitThisCandle;
        result.tp_hit_time_minutes = tpHitThisCandle ? 0 : null;
        result.sl_hit_time_minutes = slHitThisCandle ? 0 : null;
        result.outcome_status = "inconclusive";
        result.outcome_reason = "ambiguous_entry_candle";
        break;
      }

      if (slHitThisCandle && !result.tp_hit) {
        result.sl_hit = true;
        result.sl_hit_time_minutes = Math.round(
          (candleTime - entryReachedTime) / 60000,
        );
        if (stopLoss !== null) {
          maxAdverse = Math.abs(entryPrice - stopLoss);
        }
        result.outcome_status = "would_have_lost";
        result.outcome_reason = "stop_first";
        break;
      }

      if (tpHitThisCandle && !result.sl_hit) {
        result.tp_hit = true;
        result.tp_hit_time_minutes = Math.round(
          (candleTime - entryReachedTime) / 60000,
        );
        if (takeProfit !== null) {
          maxFavorable = Math.abs(takeProfit - entryPrice);
        }
        result.outcome_status = "would_have_won";
        result.outcome_reason = "target_first";
        break;
      }
    }
  }

  result.mfe_pips = maxFavorable;
  result.mae_pips = maxAdverse;
  if (result.price_reached_entry && result.outcome_reason === "entry_not_reached") result.outcome_reason = "window_expired";
  const risk = stopLoss === null ? 0 : Math.abs(entryPrice - stopLoss);
  if (risk > 0) {
    result.mfe_r = maxFavorable / risk;
    result.mae_r = maxAdverse / risk;
    result.outcome_r = result.outcome_status === "would_have_lost" ? -1 : result.outcome_status === "would_have_won" && takeProfit !== null ? Math.abs(takeProfit - entryPrice) / risk : null;
  }
  return result;
}
