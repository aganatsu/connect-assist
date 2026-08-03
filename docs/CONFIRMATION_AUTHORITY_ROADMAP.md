# Confirmation Authority Roadmap

Status: Phase 2 attempt persistence implemented; verification pending

## Verified current behavior

Three mechanisms contribute to entry confirmation:

1. `confirmationHierarchy.ts` evaluates sweep plus close-based CHoCH, CHoCH,
   displacement, inducement, and watch-only results for Unified Zone scoring.
2. `zoneConfirmation.ts` delegates to that hierarchy, then retains legacy
   Tier 1 close CHoCH, Tier 2 wick CHoCH with support, and Tier 3 reversal
   pattern fallbacks for pending fills.
3. Scanner routing can require indicators alone or combine structural and
   indicator confirmation.

The hierarchy and legacy tiers overlap but are not equivalent. Removing a
fallback now would change entries without outcome evidence.

## Phase 1 - Observation contract

`confirmation-authority.v1` records:

- hierarchy, legacy-tier, or indicator source;
- explicit named level;
- candle index, time, price, direction, and displacement;
- close-based status and supporting signals;
- whether current behavior considered the result entry-ready;
- normalized reason codes;
- immutable observation-only markers.

The observation travels in final decision evidence and fill `signal_reason`.
It does not replace `confirmationPassed`, change tier selection, alter Unified
Zone scores, or participate in authorization.

## Next phases

Phase 2 stores router-level authority on immutable fast-scanner confirmation
attempt rows, including unsuccessful and combined partial results. Both fill
routes also carry routed authority on successful signals.

1. Persist watch-only and rejected confirmation observations for replay.
2. Compare hierarchy-only decisions with current legacy/indicator routing.
3. Add outcome reports by source, level, symbol, style, and route.
4. Move accepted fallback patterns into named hierarchy levels without
   changing their predicates.
5. Prove live/backtest parity for each level.
6. Retire hidden fallback code only after forward and historical evidence.

Any enforcement change requires a separate PR, paper scope, evidence review,
and rollback to the current routing behavior.
