# Cross-Timeframe Impulse Authority — Phase 3

## Outcome

Phase 3 adds `zone-candidate-model.v1`, an observation-only lifecycle and
ranking contract for zone candidates.

Each surviving candidate is classified as:

- `fresh`
- `tapped_and_held`
- `partially_mitigated`
- `violated`

The model keeps up to three candidates and orders them using:

- zone-local confluence
- proximity to current price, normalized by ATR
- impulse-origin and entry-liquidity sweep quality
- retest quality
- relative displacement percentile
- structural importance

A violated candidate remains visible in evidence but is not eligible to win the
model rank. A tapped-and-held candidate receives stronger retest credit than an
untested or partially mitigated candidate.

## Runtime safety

The production winner is still `multiTFResult.bestZone`, selected by the
existing engine. The new model runs after local and liquidity observations,
labels itself `observe_only`, and is never passed into a production gate,
authorization decision, size calculation, or broker call.

The existing exact-parity test remains green: enabling evidence collection does
not change the selected zone, levels, or score.

## Persistence and UI

The model top three are persisted in
`zone_candidate_shadow_observations`, including immutable lifecycle and factor
snapshots. The selected legacy/local disagreement candidates are still retained
for backward compatibility.

Zone Story shows the selected legacy candidate's lifecycle, model rank, factor
breakdown, and explanation. Timeframe Evidence shows every model top-three
candidate per slot.

## Validation

- 70 focused backend tests pass for the impulse engine, lifecycle/model,
  persistence, and wiring.
- 9 unified-zone tests pass.
- 8 focused UI tests pass.
- Deno checks pass for the changed shared modules.
- Full TypeScript checking and targeted frontend lint pass.

## Deployment

Apply:

`supabase/migrations/20260801230000_add_zone_candidate_lifecycle_model.sql`

Deploy:

- `bot-scanner`

Publish the frontend to expose lifecycle/model evidence.

## Explicitly deferred

The candidate model is not an active zone selector. Cross-timeframe parent/child
lineage is Phase 4, and runtime enforcement remains deferred until the later
controlled-enforcement phase.
