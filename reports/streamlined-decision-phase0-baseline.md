# Streamlined Trade Decision - Phase 0 Baseline

## Outcome

The current scoring and authorization architecture was reviewed without
changing runtime behavior. A canonical implementation and handoff tracker now
lives at:

docs/STREAMLINED_TRADE_DECISION_ROADMAP.md

## Verified findings

- The strong market detectors and Zone Story must be preserved.
- Direction, lifecycle, cross-timeframe, final authorization, and replay
  authorities already exist and should be reused.
- Weighted factors, tiers, percentages, adjustments, conflict counters, and
  gates still overlap in the setup-quality path.
- Some evidence can affect more than one decision layer.
- Raw, effective, Watchlist, and displayed scores can diverge.
- Existing stored trade, rejection, scan, Watchlist, certificate, and golden
  replay evidence can support an observation-only comparison.
- Missing historical evidence must be marked unavailable rather than inferred.

## Approved target

One versioned summary with four separate outputs:

1. Direction
2. Setup Quality
3. Thesis Health
4. Safety Authorization

## Behavior

Documentation only. No score, threshold, gate, order, position, Watchlist,
backtest, or execution behavior changed.

## Next action

Implement Phase 1 of the roadmap only: a pure, deterministic,
observation-only TradeDecisionSummary contract with tests and scan-detail
evidence.
