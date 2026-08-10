/**
 * exitEvaluation.ts — the single owner of "did this position hit its SL or TP,
 * and at what price?"
 *
 * Before this module, that question was answered in four places that disagreed:
 *
 *   backtest-engine     candle.low <= sl      0.5p slippage + gap-through   sees wicks
 *   paper-trading (5s)  current_price <= sl   0.5p slippage + gap-through   point only
 *   bot-scanner  (5m)   current_price <= sl   NO slippage, fills at exactly sl
 *   live                broker resting order  real                          sees wicks
 *
 * Two consequences. Paper missed every stop-out caused by a wick that recovered
 * inside the poll window, so paper equity was optimistically biased against both
 * backtest and live. And the two paper paths disagreed with each other — the same
 * position exited at a different price depending on which cron reached it first.
 *
 * The backtest implementation was the correct one (gap-through, slippage, and a
 * same-bar SL+TP tie-break). It is the version ported here.
 *
 * ── Bars vs points ──────────────────────────────────────────────────────
 * Callers that have a real OHLC bar pass it and get wick-accurate detection.
 * Poll-based callers that only hold a last price pass `priceAsBar(price)`, which
 * degrades to the old point behaviour — explicitly and greppably, rather than by
 * accident. See PAPER_POLL_LIMITATION below.
 *
 * Locked to a single implementation by
 * supabase/tests/_shared/singleConceptOwnership.test.ts.
 */

/**
 * Known limitation, kept visible on purpose.
 *
 * `paper-trading` polls every 5s and only ever holds a last price, so it cannot
 * see a wick that spikes through SL and recovers between polls. `bot-scanner`
 * evaluates the same positions every ~5 min against a real closed bar, so it
 * catches what the poll missed and closes at the correct gap-adjusted SL price.
 * The position stays open a few minutes longer than it should, but the recorded
 * exit price and reason are correct.
 *
 * Removing the lag entirely requires either per-poll high/low watermark columns
 * on `paper_positions` or a candle fetch in the 5s loop. Neither is done yet.
 */
export const PAPER_POLL_LIMITATION =
  "paper-trading polls a point price; bot-scanner re-checks against a real bar";

export interface ExitBar {
  /** Used only to disambiguate a bar that touched both SL and TP. Falls back to `close`. */
  open?: number;
  high: number;
  low: number;
  close: number;
}

export interface ExitPositionInput {
  direction: "long" | "short";
  stopLoss: number | null;
  takeProfit: number | null;
  /** Instrument pip size, used to convert slippage pips into price. */
  pipSize: number;
  /** Simulated adverse slippage applied to SL fills only. Default 0.5 pips. */
  slippagePips?: number;
  /**
   * Optional SL provenance so the close reason can distinguish a break-even or
   * trailing stop from the original stop. `paper_positions.close_reason` is
   * reused as this tag while the position is open ("" | "be" | "trail").
   */
  slState?: string | null;
}

export type ExitReason = "sl_hit" | "be_hit" | "trail_hit" | "tp_hit";

export interface ExitDecision {
  hit: boolean;
  reason: ExitReason | null;
  exitPrice: number | null;
  /** True when the bar touched both SL and TP and the tie-break picked one. */
  ambiguousBar: boolean;
  detail: string;
}

const DEFAULT_SLIPPAGE_PIPS = 0.5;

/**
 * Wrap a single price as a zero-width bar, for callers that poll a last price
 * rather than reading a candle. Detection degrades to the old point behaviour.
 */
export function priceAsBar(price: number): ExitBar {
  return { open: price, high: price, low: price, close: price };
}

function slReasonFor(slState: string | null | undefined): ExitReason {
  const tag = (slState ?? "").toString();
  if (tag === "trail") return "trail_hit";
  if (tag === "be") return "be_hit";
  return "sl_hit";
}

/**
 * Decide whether a bar closed a position, and at what price.
 *
 * SL fills use the worse of (stop, bar extreme) so a gap through the stop fills
 * at the gap price, then worsen by `slippagePips`. TP fills are exact — no
 * positive slippage is assumed.
 */
export function evaluateExit(
  bar: ExitBar,
  pos: ExitPositionInput,
): ExitDecision {
  const isLong = pos.direction === "long";
  const sl = pos.stopLoss;
  const tp = pos.takeProfit;
  const slippage = (pos.slippagePips ?? DEFAULT_SLIPPAGE_PIPS) * pos.pipSize;

  const slValid = sl !== null && Number.isFinite(sl) && sl > 0;
  const tpValid = tp !== null && Number.isFinite(tp) && tp > 0;

  const slHit = slValid && (isLong ? bar.low <= sl! : bar.high >= sl!);
  const tpHit = tpValid && (isLong ? bar.high >= tp! : bar.low <= tp!);

  const noExit: ExitDecision = {
    hit: false,
    reason: null,
    exitPrice: null,
    ambiguousBar: false,
    detail: "No SL/TP breach",
  };
  if (!slHit && !tpHit) return noExit;

  const closeAtStop = (ambiguous: boolean): ExitDecision => {
    // Gap-through: fill at the worse of the stop and the bar extreme.
    const gapPrice = isLong ? Math.min(sl!, bar.low) : Math.max(sl!, bar.high);
    const exitPrice = isLong ? gapPrice - slippage : gapPrice + slippage;
    const reason = slReasonFor(pos.slState);
    return {
      hit: true,
      reason,
      exitPrice,
      ambiguousBar: ambiguous,
      detail: ambiguous
        ? `Bar touched both SL and TP; SL was nearer the open — ${reason} at ${exitPrice}`
        : `${reason} at ${exitPrice} (stop ${sl}, gap ${gapPrice}, slippage ${slippage})`,
    };
  };

  const closeAtTarget = (ambiguous: boolean): ExitDecision => ({
    hit: true,
    reason: "tp_hit",
    exitPrice: tp!,
    ambiguousBar: ambiguous,
    detail: ambiguous
      ? `Bar touched both SL and TP; TP was nearer the open — tp_hit at ${tp}`
      : `tp_hit at ${tp}`,
  });

  if (slHit && tpHit) {
    // Both touched inside one bar and the sequence is unknowable from OHLC.
    // Resolve by distance from the open and break ties toward the stop, so the
    // ambiguous case is never scored as a win.
    const ref = Number.isFinite(bar.open as number)
      ? (bar.open as number)
      : bar.close;
    const slDist = Math.abs(ref - sl!);
    const tpDist = Math.abs(ref - tp!);
    return slDist <= tpDist ? closeAtStop(true) : closeAtTarget(true);
  }

  return slHit ? closeAtStop(false) : closeAtTarget(false);
}
