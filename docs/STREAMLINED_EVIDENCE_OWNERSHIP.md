# Streamlined Evidence Ownership

Status: Phase 2 observation contract
Registry: streamlined-evidence-registry.v1

## Rule

Every market fact has one decision owner. A fact may remain visible in other
views as explanation, but it cannot contribute points to multiple decision
layers.

The current trading system remains authoritative. This registry produces only
the observation attached to streamlinedTradeDecision.

## Setup Quality Formula

Each Setup Quality pillar has a maximum of 25 points.

For registered, enabled factors owned by a pillar:

1. the denominator is the sum of their configured canonical maximum weights;
2. a present factor contributes its signed observed legacy weight, clamped to
   its canonical maximum;
3. an absent enabled factor contributes zero;
4. opposing evidence contributes a negative weight;
5. the pillar result is 25 times earned weight divided by maximum weight,
   clamped to 0-25.

This preserves already-observed quality weights while preventing evidence from
crossing decision roles. Unknown factors fail mapping closed and make the
proposed Setup Quality unavailable.

## Factor Ownership

### Structure

| Factor | Reason |
|---|---|
| Market Structure | Entry/setup-timeframe structural quality |
| Displacement | Impulse and structural quality |

### Location

| Factor | Reason |
|---|---|
| Order Block | Institutional entry location |
| Fair Value Gap | Imbalance entry location |
| Premium/Discount & Fib | Canonical value and retracement |
| PD/PW Levels | Prior-day and prior-week location |
| Breaker Block | Flipped order-flow location |
| Unicorn Model | Breaker and FVG overlap |
| Volume Profile | Volume-derived location |
| Confluence Stack | Overlapping location after existing anti-double-count rules |
| HTF POI Alignment | Higher-timeframe containment |
| HTF Fib + PD + Liquidity | Higher-timeframe value and liquidity |
| GP Key Level Alignment | Game Plan level location, not direction |

Zone Story is preserved as Location provenance. It explains how impulse,
OB/FVG, canonical range, liquidity, and timeframe authority connect. It adds no
separate points.

### Confirmation

| Factor | Reason |
|---|---|
| Judas Swing | Manipulation/reversal confirmation |
| Reversal Candle | Price rejection |
| Liquidity Sweep | Liquidity event confirmation |
| AMD Phase | Accumulation-manipulation-distribution confirmation |
| Pullback Health | Pullback response quality |

### Timing

| Factor | Reason |
|---|---|
| Session Quality | Tradable session window |
| Session Affinity | Pair-specific session suitability |
| Opening Range factors | Opening-range timing window |

### Direction Only

These remain evidence for Direction Verdict and add no Setup Quality points:

- SMT Divergence
- Currency Strength / FOTSI
- Daily Bias
- Regime Alignment
- GP Bias Confidence

### Safety Only

- Spread Quality is informational only.
- Actual broker spread remains a final Safety Authorization check.

### Derived Diagnostic Only

Power of 3 Combo is derived from AMD, sweep/Judas, and structure. Those inputs
are already owned, so the combo remains visible but adds no new pillar points.

## Promotion Ownership

Promotions qualify existing Location evidence; they are not extra factors:

- Unicorn Tier 1 promotion
- nested HTF FVG
- nested HTF order block
- nested HTF Fibonacci
- impulse-zone compatibility credit

## Adjustment Ownership

| Existing adjustment | Owner | Phase 2 treatment |
|---|---|---|
| FOTSI penalty | Direction | Evidence only |
| Direction Verdict adjustment | Direction | Evidence only |
| ICT HTF adjustment | Direction | Evidence only |
| Impulse-zone adjustment | Location | Evidence only |
| ICT FVG adjustment | Location | Evidence only |
| Zone-local adjustment | Confirmation | Evidence only |
| ICT MSS adjustment | Confirmation | Evidence only |
| ICT Judas adjustment | Confirmation | Evidence only |
| ICT Kill Zone adjustment | Timing | Evidence only |
| Cross-timeframe adjustment | Structure | Evidence only |
| Thesis Conviction adjustment | Thesis Health | Evidence only |
| Conflict counter | Derived diagnostic | Excluded duplicate |

Evidence-only means the observation records its conceptual owner but does not
add the legacy adjustment again. The current scanner still applies existing
adjustments to its own effective score.

## Gate Ownership

### Direction

- Direction Verdict
- legacy HTF alignment fallback
- Game Plan alignment
- regime alignment
- SMT veto

### Setup Quality or Confirmation

- premium/discount: Location
- structural conviction: Structure
- reaction confirmation: Confirmation
- opening range and kill zone: Timing
- cross-timeframe and zone-local policy: their mapped pillar evidence
- Tier 1 minimum and minimum score: legacy decision rules, not new evidence

### Thesis Health

- fresh thesis validation
- frozen structural invalidation
- thesis-conviction degradation

### Safety Authorization

- instrument availability
- maximum positions and per-symbol exposure
- duplicate direction
- portfolio heat and correlation
- daily loss, drawdown, and consecutive-loss protection
- cooldown
- high-impact news
- broker spread
- minimum risk/reward
- valid SL/TP orientation
- account, execution mode, kill switch, freshness, and prop-firm checks

## Missing and Contradictory Evidence

- Unknown factor: mapping incomplete; no guessed owner.
- Pillar with no enabled mapped evidence: pillar unavailable.
- Missing Zone Story: mapped factor score may exist, but provenance reports the
  missing reference.
- Opposing factor: negative contribution within its one pillar.
- Directional conflict: Direction owns it; Setup Quality does not deduct it
  again.
- Safety failure: visible as an observational block, while
  affectsAuthorization remains false.
- Final Safety Authorization unavailable at candidate discovery: overall
  proposed decision remains unavailable.
