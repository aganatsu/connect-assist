# Streamlined Trade Decision - Phase 2

Status: complete and CI-verified

## Outcome

Phase 2 introduces streamlined-evidence-registry.v1, one explicit owner for
every current confluence factor and the scanner's known promotions and score
adjustments.

The scanner now passes its existing factor array to the observation adapter.
The adapter creates four deterministic Setup Quality pillar scores while the
current trading system remains authoritative.

## Pillars

- Structure: setup structure and displacement
- Location: Zone Story provenance, OB/FVG, canonical value, liquidity/levels,
  HTF containment, and related location evidence
- Confirmation: sweep, rejection, AMD, Judas, and pullback response
- Timing: session quality and pair/session affinity

Each pillar has a maximum of 25 points.

## Formula

For enabled factors owned by one pillar:

1. denominator = sum of canonical maximum weights;
2. present evidence contributes its signed observed legacy weight;
3. opposing evidence contributes negatively;
4. absent enabled evidence contributes zero;
5. pillar score = 25 times earned divided by maximum, clamped to 0-25.

The total Setup Quality score is the sum of four complete pillars.

## Evidence excluded from pillar points

Direction only:

- SMT Divergence
- Currency Strength / FOTSI
- Daily Bias
- Regime Alignment
- Game Plan bias confidence

Safety only:

- Spread Quality

Derived diagnostic:

- Power of 3 Combo, because AMD, sweep/Judas, and structure are already mapped

Promotions and compatibility credits qualify existing Location evidence. They
do not add a second contribution.

## Zone Story

Zone Story remains explicit Location provenance. It is not removed, weakened,
or converted into an additional score. Its underlying impulse, OB/FVG,
canonical range, liquidity, and timeframe evidence remain visible through
their owned factors and authority references.

## Fail-closed mapping

An unknown future factor is never guessed into a pillar. It:

- appears in unmappedFactors;
- marks mapping incomplete;
- makes all pillar scores and proposed Setup Quality unavailable.

This forces every new detector to receive an intentional owner.

## Behavior

Observation only:

- current confluence and effective scores are unchanged;
- tiers and promotions are unchanged;
- all existing adjustments and gates still execute unchanged;
- Watchlist, pending orders, fills, positions, and backtests are unchanged;
- final candidate Safety Authorization remains incomplete;
- affectsAuthorization remains false.

## Documentation

The complete ownership and duplicate-influence audit is:

docs/STREAMLINED_EVIDENCE_OWNERSHIP.md

## Tests

- exact ownership for every currently emitted confluence factor;
- four pillar calculations;
- directional and safety evidence exclusion;
- derived duplicate exclusion;
- unknown factor fail-closed behavior;
- opposing evidence behavior;
- promotion and adjustment classification;
- scanner factor-array wiring;
- observation-only authorization isolation.

## Verification

- Local diff formatting: passed
- Local Node/Deno execution: unavailable in workspace
- GitHub Actions Node tests/build: passed
- GitHub Actions Deno tests: passed after retrying an external esm.sh HTTP 522
- GitHub Actions run: 30834487774
- Pull request: #169
- Merge: completed through PR #169

## Next proposed phase

Phase 3: persist the observation summary through scan candidate, Watchlist,
pending order, rejection, position, and closed-trade lifecycle. Phase 3
requires owner approval and remains observation-only.
