# Streamlined Trade Decision - Phase 1

Status: implementation complete; CI verification pending

## Outcome

Phase 1 introduces the pure, versioned
streamlined-trade-decision.v1 observation contract.

It records:

- candidate identity and evaluation timestamp;
- frozen style, timeframe, Game Plan, and Direction Verdict references;
- one Direction result and confidence band;
- four Setup Quality pillar slots;
- Thesis Health;
- required confirmation state;
- normalized observed safety checks;
- legacy raw/effective score diagnostics;
- proposed allow, watch, block, or unavailable decision;
- evidence coverage and unavailable fields.

## Scanner integration

The main scanner attaches the result to pair scan detail as:

streamlinedTradeDecision

The scanner calls a separate Phase 1 observation adapter. The adapter translates
existing decision context and legacy diagnostics into the new contract without
becoming a second scoring authority.

## Deliberate incompleteness

Phase 1 does not assign evidence to the four Setup Quality pillars. Every pillar
is marked incomplete with phase2_evidence_mapping_pending.

Therefore normal Phase 1 candidate observations produce an unavailable proposal
unless an already-known directional, thesis, or safety failure produces an
explanatory block. Even that block is observational:

- observationOnly is always true;
- affectsAuthorization is always false;
- no scanner branch reads the summary;
- no score, threshold, gate, lifecycle, order, or position is changed.

Final runtime Safety Authorization is also marked incomplete because candidate
discovery occurs before final authorization.

## Protected evidence

The adapter preserves an explicit Zone Story and market-location evidence
reference. Phase 2 will define canonical ownership for Zone Story, impulse,
OB/FVG, canonical range, liquidity, confirmation, structure, and timing.

## Tests

- deterministic output for identical evidence;
- complete synthetic evidence can express allow;
- incomplete pillars remain unavailable instead of becoming zero;
- safety failures remain visible but cannot authorize;
- invalid thesis produces an observational block;
- duplicate normalized safety gates preserve any failure;
- scanner wiring attaches exactly one observation;
- wiring contracts prohibit authorization reads;
- Zone Story evidence remains referenced.

## Behavior

Observation only. No execution behavior changed.

## Files

- supabase/functions/_shared/streamlinedTradeDecision.ts
- supabase/functions/_shared/streamlinedTradeDecisionObservation.ts
- supabase/functions/_shared/streamlinedTradeDecision.test.ts
- supabase/functions/_shared/streamlinedTradeDecisionObservation.test.ts
- supabase/functions/_shared/streamlinedTradeDecisionWiring.test.ts
- supabase/functions/bot-scanner/index.ts

## Verification

- Local diff formatting: passed
- Local Node/Deno execution: unavailable in the workspace environment
- GitHub Actions Node tests/build: pending
- GitHub Actions Deno tests: pending
- Pull request: pending
- Merge commit: pending

## Next proposed phase

Phase 2: inventory every active factor, promotion, adjustment, and gate, then
assign each market-evidence item to exactly one pillar. It remains
observation-only and requires owner approval before work begins.
