# Candlestick Confirmation Authority

Date: 2026-08-03

## Scope

Candlestick reversal patterns are entry-trigger evidence inside the existing
Confirmation Authority. They do not add scores or create independent gates.

## Patterns

- Strong: bullish/bearish engulfing, Morning Star, Evening Star
- Moderate: hammer/pin bar, shooting star
- Weak: doji with directional follow-through

Patterns must align with Direction Verdict and occur after the frozen zone
touch within the existing confirmation lookback.

## Route Policy

- Unified: strong pattern requires displacement; moderate pattern requires a
  sweep.
- Cascade: strong pattern requires displacement; moderate pattern requires a
  sweep.
- Standalone: strong patterns require both sweep and displacement; moderate
  patterns require a sweep.
- Doji follow-through always requires sweep and displacement and never confirms
  entry by itself.

The selected pattern, strength, candle time and reason codes are attached to
the versioned Confirmation Authority evidence used by both pending-fill
scanners.
