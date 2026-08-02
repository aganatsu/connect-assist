# Cross-Timeframe Impulse Authority — Phase 4

## Outcome

Phase 4 adds `cross-tf-zone-lineage.v1`, an explicit observation-only
parent/child relationship for every evidenced zone candidate.

Each candidate is classified as:

- `qualified_nested` — the child overlaps a direction-aligned higher-timeframe
  parent
- `context_only` — higher-timeframe direction agrees, but the zones do not
  overlap
- `standalone_lower_tf` — a lower-timeframe candidate exists without a
  higher-timeframe candidate
- `timeframe_conflict` — the closest higher-timeframe candidate points in the
  opposite direction
- `no_parent_context` — the candidate is the highest configured timeframe or
  sits outside the configured hierarchy

The lineage snapshot includes the exact parent candidate and timeframe,
direction agreement, child-overlap percentage, distance to the parent, and
ATR-normalized distance.

## Why this resolves the ambiguity

A 15-minute zone can no longer be presented as if it were automatically the
same story as a visible 1-hour impulse. Evidence now states whether that
15-minute candidate is inside the 1-hour zone, merely agrees directionally,
stands alone, or conflicts.

## Runtime safety

Lineage is only attached when evidence collection is enabled. It is not consumed
by the existing zone selector or any execution gate. The legacy winner,
entry/stop levels, score, and authorization path remain unchanged.

## Persistence and UI

Lineage is stored immutably with the model top-three observations in
`zone_candidate_shadow_observations`. Zone Story shows the selected candidate's
relationship and parent explanation. Timeframe Evidence shows the relationship
for every model top-three candidate.

## Validation

- 82 focused backend tests pass across impulse, unified-zone, candidate model,
  lineage, persistence, and wiring.
- 8 focused UI tests pass.
- Deno checks pass.
- Full TypeScript checking, targeted lint, and production build pass.

## Deployment

Apply:

`supabase/migrations/20260802000000_add_cross_timeframe_zone_lineage.sql`

Deploy:

- `bot-scanner`

Publish the frontend to expose lineage evidence.

## Explicitly deferred

Nesting is not yet an active gate or score. Phase 5 carries this exact lineage
into the Gameplan/Direction Verdict/Zone Story and frozen setup context. Runtime
enforcement remains a later controlled decision.
