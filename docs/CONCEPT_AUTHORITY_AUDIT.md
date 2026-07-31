# Trading Concept Authority Audit

Status: diagnostic baseline  
Scope: detection and interpretation only; no trading behavior changed

## Executive conclusion

The system does not generally contain completely independent implementations of
every SMC concept. Most live paths reuse primitives from
`supabase/functions/_shared/smcAnalysis.ts`.

The material risk is **semantic drift above those primitives**:

- the same detector is run on different candle slices, timeframes, and
  lookbacks;
- consumers use different definitions of "present" or "confirmed";
- lifecycle and confirmation modules apply additional rules after detection;
- multiple concepts have genuinely separate implementations with the same UI
  name;
- the scanner contains compatibility credits that mutate Tier scoring when the
  Zone engine and scoring engine disagree.

This means two surfaces may truthfully report different answers while both say
"FVG", "order block", "BOS", "structure", "liquidity sweep", "displacement",
or "breaker".

## Authority vocabulary

Every concept result should eventually identify its role:

1. **Primitive detection** — what price event or entity exists.
2. **Lifecycle** — whether the entity remains active, tested, mitigated, filled,
   exhausted, absorbed, or broken.
3. **Context qualification** — whether the entity is relevant to a direction,
   timeframe, impulse, zone, or game plan.
4. **Entry readiness** — whether current price and confirmation permit entry.
5. **Scoring** — how much qualified evidence contributes.
6. **Display** — a read-only summary; never an execution authority.

The current system sometimes compresses two or more of these roles into the same
label.

## Consumer map

| Consumer | Primary role | Recomputes concepts? | Execution impact |
|---|---|---:|---:|
| `bot-scanner` | Live orchestration | Yes, through shared engines | Yes |
| `backtest-engine` | Historical orchestration | Yes, through the same core engines | Simulated |
| `smc-analysis` | Analysis API | Yes, through `smcAnalysis` | No direct order |
| `game-plan-refresh` / Gameplan generation | HTF planning | Yes, selected shared detectors | Directional context |
| Direction Engine / Direction Verdict | Direction authority | Structure-based classification | Yes, through final authorization |
| Impulse Zone Engine | Impulse and POI qualification | Yes, shared primitives on scoped candles | Yes |
| Unified Zone Engine | Zone story composition | Composes impulse, liquidity and confirmation | Yes |
| Cascade Zone Engine | Daily-to-entry cascade | Shared primitives on each cascade timeframe | Yes |
| Zone Confirmation | Entry confirmation | Re-analyzes confirmation-timeframe structure | Yes |
| SMC Enhancements | Optional supplemental models | Some separate implementations | Potentially |
| Frontend `confluenceUnify` | Display checklist | Interprets supplied arrays | No |

Positive finding: live scanning and backtesting both call the shared
`runConfluenceAnalysis`, `findUnifiedZone`, and `findCascadeZone` modules. The
largest parity risk is therefore orchestration inputs and post-processing, not
wholly separate backtest detectors.

## Concept inventory

### 1. Swing points and market structure

**Primitive**

- `detectSwingPoints` uses symmetric pivot lookbacks and an optional ATR
  significance filter.
- `analyzeMarketStructure` runs both internal and external swing lookbacks,
  requires closes through swing levels for BOS/CHoCH, and classifies wick-only
  breaks as sweeps.

**Contextual variants**

- `directionEngine.confirmedTrend` is intentionally stricter: coarser swings,
  alternation enforcement, close confirmation, and a Fib-extension threshold.
  It is a macro-direction classifier, not the same thing as entry structure.
- `ictDisplacementMSS` validates that an MSS has displacement.
- `zoneConfirmation` re-runs structure on confirmation candles and then applies
  tier-specific displacement/support rules.
- daily and monthly modules analyze different aggregation horizons.
- the Impulse Zone engine validates a structure break as the origin of an
  impulse leg.

**Finding**

Intentional specialization exists, but persisted evidence does not always state
which structure contract produced the label. "Bullish structure", "BOS", and
"CHoCH" are therefore ambiguous without timeframe, significance, detector
version, and qualification role.

**Required contract**

Every structure result needs:

`detector`, `version`, `timeframe`, `window`, `swingLookback`,
`significance`, `breakMode`, `level`, `eventIndex`, and `eventId`.

### 2. Fair Value Gaps

**Primitive**

- `smcAnalysis.detectFVGs` is the common geometric detector. It also assigns
  quality and lifecycle-related fields.

**Different qualifications of the same primitive**

- Tier scoring only credits an aligned, active FVG when current price is inside
  it; proximity to consequent encroachment, quality, fill percentage, and
  recency change the score.
- Impulse Zone detection calls the same FVG detector on candles inside the
  validated impulse leg, keeps direction-aligned gaps, and later requires Fib,
  S/R, timeframe, and zone qualification.
- Lower-timeframe refinement calls it on candles overlapping the selected zone
  and requires containment inside that zone.
- Gameplan generation calls it on HTF candles to build planning POIs, not entry
  readiness.
- `ictFVGInvalidation` is a separate post-detector lifecycle validator with
  body-close, consequent-encroachment, and Rule-of-Two semantics.

**Confirmed contradiction**

The scanner explicitly documents that the Impulse Zone engine may validate an
FVG while Tier 1 reports no FVG because Tier 1 requires price to be inside the
gap at scoring time. It then mutates the Tier factor and score using
"IMPULSE-ZONE CREDIT".

This is the clearest current example of two authorities being reconciled after
the fact.

**Required contract**

Keep one `fvgId` for the geometric entity. Store separate statuses:

- `detected`
- `lifecycleStatus`
- `directionQualified`
- `impulseQualified`
- `priceAtEntity`
- `tierEligible`
- `entryReady`

An Impulse qualification may legitimately make an FVG Tier-eligible, but that
rule should live in a canonical qualification policy rather than a scanner
mutation.

### 3. Order blocks

**Primitive**

- `smcAnalysis.detectOrderBlocks` detects and scores OB candidates using
  recency, scan-back, displacement/engulfing context, structure-break context,
  volume when available, and local lifecycle state.

**Contextual variants**

- Tier scoring requires a directionally relevant active OB and applies current
  price/context rules.
- Impulse Zone detection deliberately uses a wider pre-impulse candle window so
  the origin candle is not lost and so impulse candles do not falsely break the
  OB.
- HTF Gameplan, Unified/Cascade Zone, and monthly analysis use the shared
  detector on their own timeframes.
- generic `zoneLifecycle` may evaluate a selected OB again using a different
  lifecycle policy.

**Finding**

The different candle windows are technically justified, but the resulting OBs
do not have stable cross-engine identity. Two engines can describe the same
price box without proving it is the same originating entity.

**Required contract**

Create `obId` from symbol, timeframe, origin candle time, direction, and
normalized bounds. Context engines reference that ID and add qualification
records rather than creating anonymous OB evidence.

### 4. Breaker blocks

There are two genuinely different detectors named `detectBreakerBlocks`.

1. `smcAnalysis.detectBreakerBlocks`
   - consumes primary OBs and optional structure breaks;
   - supplies standard scoring, HTF overlays, analysis API, live scanner,
     backtest, and cascade paths.
2. `breakerBlockDetection.detectBreakerBlocks`
   - requires a broken/mitigated OB;
   - validates minimum separation, ATR displacement, optional pre-break sweep,
     and a later retest;
   - is used by the optional SMC Enhancements integration and can create a
     supplemental setup/factor.

**Finding: high semantic-collision risk**

These are not equivalent. The UI can refer to "Breaker Blocks" while the base
factor and SMC Enhancement represent different standards and different result
shapes. The enhancement is appended after confluence rather than replacing the
base factor.

The SMC Enhancement breaker is also an independent live entry model after
retest and confidence checks. It still passes final execution authorization,
but it is not merely display evidence. The backtest engine does not currently
call `runSMCEnhancements`, so this breaker model and other enhancement behavior
are absent from the main backtest path.

**Required action**

Rename the contracts before unification:

- `baseBreakerZone`
- `sweepDisplacementRetestBreakerSetup`

Then decide whether the second is a qualification of the first or a separate
entry model.

### 5. Liquidity pools, BSL/SSL, sweeps, and reclaim

These are related but not interchangeable:

- `detectLiquidityPools` detects equal-high/equal-low pools and tracks pool
  state.
- `analyzeMarketStructure.sweeps` identifies wick-through/close-back events at
  swing levels.
- `detectSweepReclaim` checks whether a structure sweep is reclaimed within a
  short window and whether displacement/FVG followed.
- `zoneLiquidity.findZoneLiquidity` classifies pools relative to a selected
  zone as entry-trigger, target, or neutral, and distinguishes unswept,
  swept-rejected, and swept-absorbed.
- `ictJudasSwing.detectJudasSwing` searches for a pre-MSS opposite-side sweep
  using swing levels, ATR depth, lookback, and close-back.
- `smcAnalysis.detectJudasSwing` is a separate NY-midnight/Asian-session
  manipulation heuristic.
- breaker detection has its own local sweep-before-break check against OB
  boundaries.
- Unified Zone uses zone-relative liquidity state to control
  `waiting_for_sweep`.

**Finding**

The system correctly models several stages of liquidity, but labels often
collapse them into "liquidity sweep". A detected structure sweep is not
necessarily the required zone entry-trigger sweep. Likewise, a Judas event is
not automatically a BSL/SSL pool sweep relevant to the selected zone.

**Important gate behavior**

`requireLiquiditySweep` is conditional on finding a relevant nearby
entry-trigger pool. If no such pool is identified, there is nothing for that
gate to wait on. That behavior must be explicit in UI and evidence.

**Required contract**

Use separate IDs and states:

- `poolId`
- `sweepEventId`
- `reclaimEventId`
- `zoneRelevance`
- `entryTriggerState`
- `judasSequenceId`

Never persist a bare `liquiditySweep: true` without the source and role.

### 6. Judas Swing

Two implementations share the same name:

- the confluence factor uses a session/midnight manipulation model;
- the ICT precision gate uses a sweep-before-MSS sequence model.

This is a genuine definition collision, not merely a timeframe difference.

**Required action**

Expose and persist them separately:

- `sessionJudasManipulation`
- `preMssLiquiditySweep`

The UI may group them under Judas concepts, but must not present one toggle or
result as proof of the other.

### 7. Displacement

At least five displacement meanings exist:

- `smcAnalysis.detectDisplacement`: general candle/sequence evidence;
- `ictDisplacementMSS`: displacement validating a structure shift;
- confirmation hierarchy: directional displacement after a zone interaction;
- zone confirmation: body/range threshold on the confirmation candle;
- daily impulse and breaker modules: ATR-relative leg or break displacement;
- sweep reclaim: ATR/body strength of the reclaim candle.

**Finding**

These are valid contextual definitions but must not share one unexplained
boolean. "Displacement present" should state what moved, relative to which ATR
and timeframe, and for which purpose.

### 8. Impulse, zones, and zone story

- Impulse Zone identifies a valid BOS-origin impulse, maps OB/FVG POIs, overlays
  Fib, checks S/R and HTF confluence, refines on LTF, and ranks a zone.
- Unified Zone composes the impulse result with zone-relative liquidity,
  confirmation, distance, and entry state. It is primarily a story/state
  authority, not another FVG/OB primitive detector.
- Cascade Zone independently composes daily, 4H, 1H, and entry-timeframe
  qualification using shared primitives.
- generic lifecycle, ICT FVG invalidation, and the entity's detector-native
  lifecycle may all evaluate the selected zone.

**Finding**

The Zone Story should become the canonical **qualification narrative** for a
candidate, but it should reference canonical primitive entity IDs. It should not
silently redefine those entities.

### 9. Tier scoring

Tier 1 is not a detector. It is an eligibility and scoring consumer.

Current confusion arises because its display says an entity is absent when the
entity may exist but fail Tier's current-price qualification. For example:

- "No active FVGs" can mean no FVG was detected.
- "FVGs exist — not at level" means detected but not Tier-present.
- Impulse credit can then make it Tier-present through a different
  qualification route.

**Required action**

Tier output must separate:

- detected count
- qualified count
- matched entity ID
- score contribution
- rejection/qualification reason
- authority that granted eligibility

### 10. Gameplan and Direction Verdict

Gameplan uses HTF POIs and structure for planning. Direction Verdict is the
pre-zone direction authority. Neither should be treated as entry-level entity
detection.

Their responsibility is:

- Gameplan: session thesis, HTF bias, target/draw-on-liquidity, key levels.
- Direction Verdict: authoritative direction decision tied to a Gameplan
  version.
- Zone/Tier/confirmation: determine whether a concrete candidate satisfies that
  direction and plan.

An HTF Gameplan FVG or OB is context/layer evidence unless the entry engine
references that same entity and proves price relationship.

### 11. Backtest parity

The backtest imports the same main confluence and zone engines as the live
scanner. This is good.

Parity can still drift through:

- different candle truncation/window sizes;
- synthetic clock/session inputs;
- missing correlated-pair or broker data;
- different management timing;
- post-analysis patches added in live orchestration but omitted in backtest;
- feature configuration/default resolution.

The Impulse Zone Tier-credit mutation is currently reproduced in both
`bot-scanner/index.ts` and `backtest-engine/index.ts`. This specific
compatibility rule has source-level parity. Sharing `confluenceScoring` still
does not prove parity for every future orchestration patch, so the rule is
covered by an explicit audit guardrail.

### 12. Frontend interpretation

`src/lib/confluenceUnify.ts` produces a display checklist from already supplied
OB/FVG/structure arrays. It uses broad existence checks, while live scoring uses
direction, price-at-level, quality, lifecycle, and recency.

This code is not an execution authority, but its wording can make the UI appear
to contradict the scanner. Display models must be labelled as summaries and
should consume persisted qualification results instead of reinterpreting raw
arrays.

### 13. Persistence and frozen evidence

The system now freezes important strategy-level authority correctly:

- candidate and setup IDs;
- style policy and frozen runtime configuration;
- Gameplan and Direction Verdict IDs/versions;
- decision context;
- originating zone;
- scenario candidates;
- confirmation policy.

The scanner also persists useful analysis snapshots, including factor details,
entity lifecycle counts, sweep/reclaim details, structure intelligence, Impulse
Zone data, and Unified Zone data.

That is not yet the same as a reproducible concept-evidence chain. The frozen
contract does not identify the exact FVG, order block, swing, liquidity pool,
structure break, or displacement candle that authorized the candidate. The
analysis snapshot commonly stores counts, bounds, levels, or copied objects,
but it has no cross-engine `evidenceId` and no detector name/version. Therefore:

- a later audit cannot prove that Tier, Impulse Zone, Unified Zone, Gameplan,
  and the UI referred to the same market entity;
- a detector implementation change cannot be separated cleanly from a policy
  change when comparing historical outcomes;
- matching prices/bounds must currently be inferred rather than joined by a
  stable identity;
- frozen configuration proves which policy was active, but not which precise
  primitive observation satisfied that policy.

The existing lifecycle freeze is valuable and should remain. The recommended
evidence envelope extends it; it does not replace it.

## Configuration collisions discovered

Some similarly named settings address different layers:

- base Breaker scoring uses runtime `useBreakerBlocks`;
- the optional SMC Enhancement uses
  `smcEnhancements.enableBreakerBlocks`;
- base Judas/session scoring and ICT pre-MSS Judas gating are different
  consumers;
- `enableLiquiditySweep` controls the scoring factor, while
  `requireLiquiditySweep` controls zone entry readiness;
- FVG detection, ICT FVG invalidation, and zone lifecycle are separately
  configured.

These should remain separate only if the UI names and evidence make their roles
unambiguous.

## Severity findings

### High

1. Impulse Zone mutates Tier FVG/OB presence and score after the scoring engine
   has completed.
2. Two Breaker detectors share the same concept name but enforce materially
   different standards.
3. Two Judas detectors share the same name but detect different phenomena.
4. Persisted/displayed structure and displacement evidence often lacks a
   detector contract and role.
5. Frontend summaries can report broad presence where execution scoring reports
   non-qualification.
6. The optional SMC Enhancement breaker can create live candidates, but the
   backtest does not run the SMC Enhancements integration.
7. Frozen trade evidence does not record exact primitive entity IDs and
   detector versions, so concept-level execution decisions are not fully
   reproducible.

### Medium

1. OB/FVG entities have no stable cross-engine identity.
2. Multiple lifecycle layers can disagree without a precedence record.
3. Liquidity evidence can lose the distinction between pool, sweep, reclaim,
   inducement, and zone relevance.
4. Live/backtest shared modules do not guarantee parity for orchestration
   patches.

### Positive controls already present

1. Core FVG, OB, structure, liquidity-pool, and primary breaker primitives are
   shared.
2. Live and backtest use the same main confluence and zone engines and both
   reproduce the current Impulse-to-Tier compatibility credits.
3. Zone confirmation delegates to the shared confirmation hierarchy when full
   zone context is available.
4. Existing regression tests acknowledge several known mismatches and protect
   some compatibility behavior.

## Canonical design

Introduce a versioned `MarketConceptEvidence` envelope:

```ts
interface MarketConceptEvidence {
  evidenceId: string;
  concept:
    | "swing"
    | "structure_break"
    | "fvg"
    | "order_block"
    | "liquidity_pool"
    | "sweep"
    | "reclaim"
    | "displacement"
    | "breaker";
  detector: string;
  detectorVersion: string;
  symbol: string;
  timeframe: string;
  observedAt: string;
  sourceCandleStart: string;
  sourceCandleEnd: string;
  direction: "bullish" | "bearish" | "neutral";
  bounds?: { high: number; low: number };
  level?: number;
  lifecycle?: string;
  attributes: Record<string, unknown>;
}
```

Context engines then create `ConceptQualification` records:

```ts
interface ConceptQualification {
  evidenceId: string;
  candidateId: string;
  role:
    | "gameplan_context"
    | "direction_evidence"
    | "tier_factor"
    | "impulse_poi"
    | "zone_layer"
    | "entry_trigger"
    | "confirmation";
  qualified: boolean;
  policyVersion: string;
  reasonCode: string;
  scoreContribution: number;
}
```

This preserves intentional contextual differences without allowing engines to
silently disagree about whether the underlying market entity exists.

## Safe implementation order

1. Add evidence IDs, detector/version metadata, and qualification role to logs
   and frozen strategy context in observe-only mode.
2. Add parity fixtures for FVG, OB, structure, liquidity, displacement, Breaker,
   and Judas concepts.
3. Split colliding names in code and UI without changing behavior.
4. Move Impulse-to-Tier credit into one canonical qualification policy and run
   old/new decisions side by side.
5. Make UI consume persisted qualifications.
6. Compare live and backtest qualification chains using identical golden replay
   fixtures.
7. Only after evidence proves parity, remove compatibility mutations and legacy
   interpretations.

## Acceptance criteria before behavior changes

- Every trade and rejection identifies the exact concept evidence used.
- The same detected FVG/OB has the same ID across Tier, Zone, Gameplan layers,
  live scan, and backtest.
- Any disagreement is expressed as a qualification difference with a reason,
  not as conflicting existence booleans.
- Breaker and Judas variants have distinct names and contracts.
- Live and backtest produce the same qualification chain for the same frozen
  candle/config fixture.
- UI labels match the persisted authority and do not recompute broader claims.
