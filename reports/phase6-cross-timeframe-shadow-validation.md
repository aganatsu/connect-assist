# Cross-Timeframe Impulse Authority — Phase 6

## Outcome

Phase 6 adds `cross-tf-shadow-policy.v1`, one fixed observation-only reference
policy used by both natural scanner evidence and opt-in historical replay.

The reference policy asks the questions that the live system did not previously
answer:

- Is the lower-timeframe candidate nested inside its configured parent?
- If it is only nearby, is the parent separation within 0.25 ATR?
- Is the parent direction in conflict?
- Is the lower-timeframe candidate standing alone?
- Is the zone fresh or tapped-and-held rather than partially mitigated or
  violated?
- Is the candidate in the top three for its timeframe?

It records what the policy **would** have done. It does not change the current
decision.

## Outcome evidence

Every observed candidate stores:

- current legacy decision
- proposed cross-timeframe decision
- exact disagreement reason codes
- complete reference policy and evaluation
- source (`forward_observation` or `retrospective_replay`)
- MAE, MFE, TP/SL result, and R outcome when resolved

The validation view reports:

- winners retained
- losers avoided
- missed opportunities
- false positives
- legacy and proposed expectancy in R
- expectancy delta
- average MAE and MFE
- disagreement sample readiness

Forward and replay datasets remain separated. A replay row is research-only,
cannot be activation evidence, and is visible only after its owning backtest
completes.

## GBP/CAD 2:25 regression

The required regression contract states that a 15-minute candidate classified
as conflicting with its 1-hour parent cannot replace that parent story. The
reference policy returns `block` with `parent_direction_conflict`, while the
legacy winner remains recorded as `allow`.

This is a deterministic classification fixture, not a claim that the original
trade contained evidence that was never persisted. Running Historical Replay
with the available GBP/CAD candle/config inputs supplies the full per-timeframe
evidence and outcome row.

## Runtime safety

- policy enforcement is hard-coded to `observe_only`
- no Bot Config field activates it in this phase
- scanner selection, score, gates, sizing, and broker calls are unchanged
- historical replay is opt-in and permanently activation-ineligible

## Validation

- 16 focused Deno tests pass
- the GBP/CAD regression classification passes
- frontend TypeScript passes
- production build passes

## Deployment

Apply:

`supabase/migrations/20260802020000_add_cross_timeframe_shadow_validation.sql`

Deploy:

- `bot-scanner`
- `backtest-engine`

Publish the frontend to expose the new validation columns on Rejected Setups.

## Next

Phase 7 adds clear Bot Config controls and shows requested, certified, and
effective runtime values separately. Observe remains the only permitted mode
until evidence and parity requirements pass.
