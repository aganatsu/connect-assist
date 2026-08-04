# End-to-End Trade Streamlining

Date: 2026-08-04
Status: In progress

## Objective

Make every setup-to-trade route use one decision contract:

1. HTF Bias
2. ICT Setup Model and frozen POI identity
3. Premium/Discount location inside the frozen HTF impulse
4. Entry Confirmation
5. Setup Thesis validity
6. Operational Safety
7. Atomic execution and broker reconciliation

Legacy scores, percentages, factor weights and custom score tiers remain
diagnostics when Trade Decision Mode is Enforce.

## Verified Runtime Routes

- Direct market entry
- Market fill at a validated POI
- Watchlist promotion to direct entry
- Watchlist promotion to pending POI order
- Main-scanner pending confirmation fill
- Fast zone-confirmation fill
- Paper execution
- Live broker execution and reverse-position closure

## Findings

- Direct market entry synthesizes confirmation instead of using the shared
  MSS/CHoCH/reversal evaluator.
- Watchlist promotion still uses legacy score and cycle thresholds under
  enforcement.
- Pending fills freeze the HTF range but read the current Premium/Discount
  mode.
- ICT Risk can block before the unified operational-safety decision.
- Ownership fill failures lose permanent/retryable semantics.
- Internal live positions are opened before broker execution is confirmed.
- Reverse closure can mark the internal position closed before broker closure
  succeeds.

## Phases

### Phase 1: Entry Confirmation parity

Status: Complete

- Use one shared evaluator for direct and pending routes.
- Do not treat POI touch alone as confirmation when the configured method
  requires MSS/CHoCH/reversal evidence.
- Preserve an explicit market-at-POI option only as a named confirmation mode.

### Phase 2: Frozen setup policy and promotion

Status: Complete

- Freeze Premium/Discount mode with the setup.
- Recalculate only current price location at final authorization.
- Promote Watchlist setups from the unified Trade Decision under Enforce.
- Keep score/cycle promotion only in Observe mode.

### Phase 3: One operational-safety owner

Status: Complete

- Move ICT Risk output into the shared operational-safety checks.
- Remove independent pre-decision blocking under Enforce.
- Preserve fail-closed treatment for unknown safety checks.

### Phase 4: Pending outcome parity

Status: Complete

- Preserve watch, permanent block and retryable block semantics.
- Persist the exact authority and reason on pending-order updates.
- Apply identical behavior in both pending-fill scanners.

### Phase 5: Live execution reconciliation

Status: Complete

- Introduce durable execution states before broker submission.
- Mark live positions open only after confirmed broker success.
- Record uncertain outcomes as reconciliation required.
- Do not mark reverse closes complete until broker closure is confirmed.

### Phase 6: End-to-end verification

Status: Complete

- Route-parity tests across direct, Watchlist, pending and backtest paths.
- Paper/live parity apart from broker execution.
- Rejected/Waiting/Blocked explanation coverage.
- Deployment and rollback checklist.

## Deployment

1. Apply `20260804030000_finalize_live_broker_position_lifecycle.sql`.
2. Deploy `bot-scanner` and `zone-confirmation-scanner`.
3. Verify a paper entry remains immediately `open`.
4. Verify a live entry stays `pending` until a broker ledger row succeeds.
5. Verify uncertain execution shows `reconciliation_required`.

Rollback scanner functions first. Keep the migration columns and trigger in place until no
live rows remain `pending` or `reconciliation_required`; dropping them earlier can
restore false-open behavior.

## Verification Result

- PR 191: Deno shared-function tests passed; Node lint, tests and build passed.
- PR 192: Deno shared-function tests passed; Node lint, tests and build passed.

## Resume Prompt

Read this report, inspect merged PRs after 2026-08-04, verify each phase status
against code and CI, then continue at the first incomplete phase. Do not restore
legacy score ownership under Trade Decision Mode Enforce.
