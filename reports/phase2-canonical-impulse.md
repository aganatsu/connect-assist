# Cross-Timeframe Impulse Authority — Phase 2

## Outcome

Phase 2 introduces `canonical-impulse.v1`, a shared, deterministic impulse
observation contract. It records the exact leg selected by the existing engine
plus pair/timeframe-relative measurements:

- ATR-normalized impulse size
- displacement percentile
- directional-body strength percentile
- BOS overshoot normalized by ATR
- recency in bars
- sweep-origin evidence
- structure-intact state

The current detector remains the decision authority. Canonical measurements are
only produced when evidence collection is enabled and are not passed to
ranking, gating, authorization, position sizing, or execution.

## Persistence and UI

Each timeframe slot stores the canonical detector version, selection key,
relative metrics, and whether it selected the same leg as the legacy detector.
Top-level `canonical_detector_version` and `canonical_parity` columns make
disagreement monitoring queryable without scanning large JSON payloads. The
same fields survive compact-summary retention.

The read-only Timeframe Evidence panel displays the canonical metrics and clearly
labels parity or disagreement.

## Safety evidence

- 59 impulse-zone tests pass.
- 5 evidence wiring and immutability tests pass.
- 5 Timeframe Evidence UI tests pass.
- Deno checks pass for the detector, evidence builder, and cleanup function.
- Targeted frontend lint and full TypeScript checks pass.
- Existing observe-only parity test proves enabling collection does not alter
  the selected zone or score.

## Deployment

Apply:

`supabase/migrations/20260801220000_add_canonical_impulse_observability.sql`

Deploy:

- `bot-scanner`
- `data-cleanup`

Publish the frontend to expose the new metrics in Timeframe Evidence.

## Explicitly deferred

Phase 2 does not rank relative metrics and does not turn the canonical detector
into a gate. Those decisions remain deferred to the later shadow-validation and
controlled-enforcement phases.
