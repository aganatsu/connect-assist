# Cross-Timeframe Impulse Authority — Phase 8

## Outcome

One shared Cross-Timeframe Entry Authority now governs every automated entry
route:

- normal scanner entry
- unified-zone entry
- cascade entry
- standalone impulse-zone entry
- Watchlist promotion
- pending-order fill in the main scanner
- pending-order fill in the one-minute confirmation scanner
- breaker pending entry
- manual Scan Now
- backtest and retrospective replay

## Decision behavior

- Observe: records the proposed decision and never changes score or entry.
- Soft: preserves entry eligibility but applies the same fixed score penalty
  when the policy rejects or evidence is missing.
- Hard: blocks a rejected candidate and fails closed when authority evidence is
  missing.

Soft and Hard remain impossible unless the saved request is at or below the
evidence-certified, runtime-enabled activation for the current paper/live
scope.

## Frozen parity

The candidate decision is frozen with its setup and read back at confirmation.
Generated database fields and the read-only
`cross_timeframe_entry_authority_audit` view expose the same decision across
Watchlist, pending orders and positions. New positions with a frozen authority
must carry the matching allowed decision in final authorization.

## Backtest parity

Backtest scoring/gating and retrospective replay use the same normalized
policy and evaluator as forward scanning. Replay evidence remains ineligible
for automatic activation.

## Validation

- shared authority unit tests
- final authorization tests
- all-entry-path wiring contract tests
- frozen-context tests
- scanner/backtest replay tests
- frontend typecheck and production build
