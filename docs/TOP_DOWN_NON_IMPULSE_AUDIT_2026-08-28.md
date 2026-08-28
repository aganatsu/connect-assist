# Top-Down Non-Impulse Setup Audit — 2026-08-28

## Scope

This audit answers one question:

> Can the existing system perform a complete, style-aware top-down trade
> analysis when the impulse-zone engine does not produce an executable zone,
> without adding another detector or parallel decision pipeline?

This branch changes no scanner, backtest, configuration, or execution behavior.
It inventories the live owners, identifies the exact impulse dependencies, and
defines the evidence required before any behavioral change is proposed.

## Executive conclusion

**Analysis: yes. Execution: not safely yet.**

The scanner already computes most of a top-down analysis before it asks the
impulse engine for a zone:

- trading-style policy and timeframe roles;
- Direction Verdict;
- canonical internal/external structure;
- canonical liquidity-to-structure sequences;
- Daily, 4H, and 1H OB/FVG/breaker POIs;
- HTF Fibonacci, rolling premium/discount, and liquidity pools;
- entry-timeframe confluence factors;
- Gameplan and thesis context;
- structural SL/TP candidates.

However, the current executable setup contract is still impulse-owned:

- the hard gate stops the pair before the canonical decision pipeline when no
  impulse zone exists;
- entry-zone identity, canonical dealing range, zone-local evidence,
  cross-timeframe lineage, confirmation bounds, lifecycle progression, and
  pre-armed geometry all come from `impulseZone.bestZone`;
- the only non-impulse entry fallback is a scanner-local nearest-OB/FVG midpoint
  heuristic, and the backtest does not share it.

Therefore, switching `Require Valid POI` from Hard to Soft or Off would not
produce a coherent top-down strategy. It would bypass the impulse requirement
and allow older score-driven or current-price fallback routes to become active.
That would be a behavioral experiment with incomplete provenance and live /
backtest drift, not a consolidation.

The safe way forward is to extend the **existing entry-zone owner** so it can
rank already-detected POIs under a non-impulse setup family, freeze the same
setup contract, and run observation-only in both live and backtest before it can
authorize paper or live execution.

## What “top-down” currently means

The active style already owns the timeframe ladder. The scanner resolves the
style policy, binds candles to semantic roles, and builds decision evidence at
`supabase/functions/bot-scanner/index.ts:3637-3681`.

The resulting conceptual pipeline is:

```text
style/account policy
  -> timeframe roles
  -> direction
  -> structure and liquidity sequence
  -> HTF and entry-TF POIs
  -> impulse-owned POI selection
  -> market location
  -> liquidity trigger
  -> entry confirmation
  -> thesis and operational safety
  -> final authorization
  -> execution and management
```

The first four stages are already genuinely top-down and style-aware. The fifth
stage is where the general analysis narrows into an impulse-only executable
contract.

## Current pipeline, with the real ownership boundary

| Stage                           | Current owner                                                           |                 Runs before no-impulse skip? |       Impulse-dependent? | Notes                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------: | -----------------------: | ---------------------------------------------------------------------------------------------------------------- |
| Style and timeframe roles       | `_shared/stylePolicy.ts`, `_shared/timeframeAuthority.ts`               |                                          Yes |                       No | Scalper, day-trader, and swing roles are resolved before analysis.                                               |
| Direction                       | `_shared/directionEngine.ts` plus persisted Direction Verdict           |                                          Yes |                       No | The verdict is synchronized into `analysis.direction` before zone selection.                                     |
| Structure                       | `_shared/canonicalStructureAuthority.ts`                                |                                          Yes |                       No | Produces frozen internal/external swings and BOS/CHoCH/MSS/sweep events.                                         |
| Liquidity sequence              | `_shared/canonicalLiquiditySequence.ts`                                 |                                          Yes |                       No | Orders sweep and structure-shift evidence on the style confirmation timeframe.                                   |
| HTF POI detection               | existing OB/FVG/breaker detectors                                       |                                          Yes |                       No | Daily, 4H, and 1H POIs are already collected.                                                                    |
| HTF Fib / P-D / liquidity       | existing shared detectors plus one known scanner-local P/D copy         |                                          Yes |                       No | Available for context, but canonical P/D later uses an impulse range.                                            |
| Entry-TF analysis               | `_shared/confluenceScoring.ts`                                          |                                          Yes |                       No | Provides OBs, FVGs, structure, liquidity, factors, and provisional SL/TP.                                        |
| Impulse and zone selection      | `_shared/unifiedZoneEngine.ts` composing `_shared/impulseZoneEngine.ts` |                                          Yes |                      Yes | One engine call; `detail.impulseZone` is a compatibility projection of the unified result.                       |
| Type-neutral zone ranking       | `_shared/ictEntryZoneAuthority.ts`                                      |                     During impulse selection |                Yes today | Standard candidates with an empty `impulseId` are discarded.                                                     |
| Canonical dealing range         | `_shared/canonicalDealingRange.ts`                                      |                     During impulse selection |                Yes today | Its range comes from the selected frozen impulse evidence.                                                       |
| Zone-local / cross-TF decisions | existing shared enforcement modules                                     | Before hard skip, but over impulse candidate |                Yes today | No selected impulse candidate means no candidate-specific evidence.                                              |
| Canonical setup decision        | `_shared/singleOwnershipDecision.ts`                                    |                                           No |                Yes today | Its `zoneStory` input is populated from cascade/unified/impulse availability.                                    |
| Decision pipeline presentation  | `_shared/canonicalScannerState.ts`                                      |                                           No | Yes in contract language | Role is named `impulse_zone`; discovery explicitly searches for an impulse-owned POI.                            |
| Confirmation                    | `_shared/zoneConfirmation.ts` and frozen confirmation policy            |                                           No |           Zone-dependent | Requires exact zone bounds and setup-specific timing.                                                            |
| Setup lifecycle                 | `_shared/setupLifecycle.ts` and impulse lifecycle modules               |                                           No |                Yes today | The frozen context retains the originating zone, candidate identity, style, timeframes, and confirmation policy. |
| Final authorization             | `_shared/finalTradeAuthorization.ts`                                    |                                           No |          No in principle | Route-independent, but requires complete entry/SL/TP geometry and upstream decisions.                            |

## Verified findings

### 1. The system does not lack top-down detectors

Before the impulse gate, the scanner:

1. resolves the effective style and role timeframes
   (`bot-scanner/index.ts:3637-3661`);
2. builds shared decision evidence, canonical structure, and canonical liquidity
   sequences (`bot-scanner/index.ts:3662-3681`);
3. detects Daily, 4H, and 1H FVGs, order blocks, and breakers
   (`bot-scanner/index.ts:3692-3773`);
4. detects HTF Fib, premium/discount, and liquidity pools
   (`bot-scanner/index.ts:3775-3832`);
5. produces and persists Direction Verdict before zone selection
   (`bot-scanner/index.ts:4151-4233`);
6. synchronizes that verdict into every downstream consumer
   (`bot-scanner/index.ts:4240-4343`); and
7. can calculate provisional SL/TP from existing swings, OBs, liquidity, FVGs,
   and Fib extensions (`bot-scanner/index.ts:4302-4334`).

These are existing capabilities. A new “top-down engine” would duplicate them.

### 2. Unified and impulse are one detection result, not two engines

The scanner calls `findUnifiedZone` once (`bot-scanner/index.ts:4451-4501`). The
unified result is persisted for the Zone Story UI
(`bot-scanner/index.ts:4503-4547`). `detail.impulseZone` is then derived from
that same result for backward compatibility (`bot-scanner/index.ts:4549-4628`).

This distinction matters because the desired change is not “choose the other
zone engine.” There is no second live impulse detector to select. The missing
capability is an executable non-impulse POI selection contract.

### 3. “Impulse exists” and “executable impulse zone exists” are different

`UnifiedZoneResult` distinguishes:

- `no_impulse`: no accepted structural leg;
- `no_zone`: an impulse candidate exists, but no acceptable OB/FVG zone was
  created or qualified;
- `watching`, `at_zone`, `confirmed`, and `triggered`: a zone exists and has
  progressed through proximity/confirmation states.

`buildNoZoneResult` deliberately retains a developing or invalidated impulse's
direction, bounds, dates, span, BOS price, and qualification reasons while
setting `hasZone: false` and `zone: null`
(`supabase/functions/_shared/unifiedZoneEngine.ts:691-725`).

That is why the UI can truthfully show an impulse trace and dates while also
saying “No valid entry zone.” The impulse is context; it is not an accepted
entry POI.

### 4. The hard gate exits before the canonical decision pipeline

Signal source is selected first: cascade for a completed swing cascade, unified
for a completed unified story, otherwise `standalone`
(`bot-scanner/index.ts:5654-5676`). `standalone` is a route label, not another
detector.

With the default `impulseZoneGateMode: "hard"`, a missing zone sets
`skipped_no_impulse_zone` and immediately continues to the next pair
(`bot-scanner/index.ts:6345-6353`).

The canonical structure decision, Single Ownership decision, scanner-state
projection, safety gates, setup geometry, and final authorization are all later
in the function. Consequently, they never evaluate the no-impulse cohort.

This ordering is the core limitation. The system already knows direction,
structure, and POIs, but it stops before turning them into one frozen candidate.

### 5. Existing canonical contracts are still impulse-shaped

The current type-neutral selector is the correct owner to evolve, but its
standard-input path filters out candidates that do not have an `impulseId`
(`_shared/ictEntryZoneAuthority.ts:464-474`). Its explanation and candidate
identity also explicitly bind every candidate to an impulse
(`_shared/ictEntryZoneAuthority.ts:439-459`).

The Single Ownership decision requires a `zoneStory` with availability,
validity, entry readiness, candidate identity, and optional impulse identity
(`_shared/singleOwnershipDecision.ts:12-56`). It treats a missing Zone Story as
unavailable (`_shared/singleOwnershipDecision.ts:141-149`).

The canonical scanner state names the role `impulse_zone` and describes its
discovery stage as searching for an “impulse-owned POI”
(`_shared/canonicalScannerState.ts:19-28`, `:93-98`).

This is contract coupling, not proof that top-down analysis is absent.

### 6. Lifecycle state must remain frozen and style-aware

`FrozenSetupStrategyContext` already freezes:

- setup and candidate identity;
- style policy and timeframe roles;
- runtime configuration provenance;
- Direction Verdict and Gameplan versions;
- concept, local, and cross-timeframe evidence;
- originating zone and nested entry plan;
- liquidity activation policy; and
- confirmation method, timeframes, and attempt limits.

See `_shared/setupLifecycle.ts:99-154` and `:480-579`.

This is the correct model. Any non-impulse candidate must be born with the same
immutable context. Bot Config changes should apply to newly created setups, not
rewrite a waiting setup's entry model mid-lifecycle.

### 7. Final authorization is reusable once geometry exists

`evaluateFinalTradeAuthorization` is explicitly route-independent
(`_shared/finalTradeAuthorization.ts:178-188`). It validates fresh account and
runtime state, price/SL/TP orientation, spread, cost-adjusted R:R,
cross-timeframe authority, direction/Gameplan/thesis/confirmation, prop-firm
rules, portfolio limits, daily loss, drawdown, and additional gates
(`_shared/finalTradeAuthorization.ts:193-389` and following).

No new final gate is needed. A future non-impulse family needs to supply a
proper frozen candidate to this existing owner.

### 8. The current non-impulse fallback is not a safe foundation as written

`computeLimitEntryPrice` is local to `bot-scanner`. It chooses the nearest
direction-aligned, unmitigated entry-timeframe OB or FVG midpoint within the
configured distance (`bot-scanner/index.ts:2470-2542`). It does not use the
canonical HTF POI hierarchy, candidate identity, cross-timeframe lineage, or the
full lifecycle contract.

It is only called when a zone engine will not override the entry
(`bot-scanner/index.ts:8540-8547`). If no limit entry is used, execution can
fall through to a market order at current price as a documented legacy fallback
(`bot-scanner/index.ts:9394-9425`).

The backtest has no `computeLimitEntryPrice` implementation or shared call.
Activating this path by turning the impulse gate Soft/Off would therefore break
the live/backtest invariant in addition to weakening provenance.

This function should eventually be removed or reduced to a delegating adapter
after its useful rules are moved into the existing shared entry-zone owner. It
must not be copied into backtest.

### 9. Breaker and enhancement logic cannot rescue a hard no-impulse scan

The SMC enhancement/breaker analysis runs after the hard impulse gate
(`bot-scanner/index.ts:7589-7621`). A pair skipped at
`bot-scanner/index.ts:6353` never reaches it. It is also not a fully shared
live/backtest route.

This is another reason not to describe an existing downstream detector as an
independent alternative entry framework. Its current placement prevents that.

### 10. Backtest has the same impulse hard stop, but not the same fallback

Backtest calls the same `findUnifiedZone` (`backtest-engine/index.ts:2837-2852`)
and uses the same cascade → unified → standalone labels
(`backtest-engine/index.ts:2871-2887`). It then skips when the hard impulse gate
has no zone or price is not at the zone (`backtest-engine/index.ts:3394-3414`).

This is correct parity for the current impulse-owned strategy. It also confirms
that a future alternative family must be implemented in a shared module and
called identically by both orchestrators.

## Configuration-mode interactions

Changing an Observe control does not automatically make a coherent alternative
pipeline. The controls have different activation semantics:

| Control                                       | Current effective behavior                                                      | Dependency                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Require Valid POI (`impulseZoneGateMode`)     | Hard skips; Soft changes score; Off is informational                            | Independent direct runtime switch; default Hard (`configMapper.ts:221-238`).                                                                   |
| POI Confluence (`zoneLocalEnforcementMode`)   | Observe/Soft/Hard requested, but activation certificate caps the effective mode | Requires a selected zone's shadow ranking (`zoneLocalEnforcement.ts:124-162`, `:170-230`).                                                     |
| HTF-to-LTF Alignment (`crossTfAuthorityMode`) | Saved Soft/Hard becomes effective immediately in current source                 | Still evaluates the selected impulse candidate (`crossTimeframeAuthority.ts:179-214`; scanner `:5693-5706`).                                   |
| Impulse Entry Lifecycle                       | Saved Off/Observe/Enforce is directly effective and frozen into a new setup     | Requires a qualified canonical impulse and executable zone (`impulseLifecycleEnforcement.ts:25-47`; `frozenCrossTimeframeContext.ts:292-377`). |
| Trade Decision / Single Ownership             | Observe or enforce immediately                                                  | Its Zone Story is currently cascade/unified/impulse-backed (`bot-scanner/index.ts:7771-7816`).                                                 |
| ICT Scanner Workflow                          | Can enforce only when Trade Decision is enforcing                               | Projects the already-built setup state (`canonicalScannerEnforcement.ts:13-56`).                                                               |
| Market Structure Authority                    | Can enforce only when Trade Decision is enforcing                               | Evaluated after the hard no-impulse return in the current pipeline.                                                                            |
| Nested POI Market Trigger                     | Off/Observe/Paper/Live, requires Market Fill, then freezes route                | Requires an outer impulse zone; it refines rather than replaces that zone.                                                                     |

Two source/documentation inconsistencies should be kept visible during future
work:

1. `configMapper.ts` comments say cross-timeframe authority is
   certificate-capped, while `resolveCrossTimeframeAuthority` currently makes
   the saved mode the effective mode and reports `requested_mode_enabled`.
2. `zoneLocalEnforcement` really is certificate-capped, so the superficially
   similar controls do not have matching rollout semantics.

Neither inconsistency justifies adding an arbiter. They should be resolved in
their existing owners when that behavior is intentionally changed.

## Existing plans and duplication hazards checked

This audit does not introduce a plan that already exists under another name. The
closest repository documents were checked against current source:

| Existing document / component                | What it already covers                                          | Why it is not the requested non-impulse route                                                               |
| -------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `docs/UNIFIED_IMPULSE_ENGINE_SPEC.md`        | One narrative around impulse, zone, liquidity, and confirmation | It intentionally keeps impulse as the setup foundation.                                                     |
| `docs/ICT_ENTRY_ZONE_AUTHORITY_PHASES.md`    | Type-neutral ranking of OB/FVG/breaker candidates               | Current standard candidates are still scoped to one impulse ID. This is the owner to evolve, not duplicate. |
| `docs/SINGLE_OWNERSHIP_SCANNER_ROADMAP.md`   | Consolidation of decision ownership and scanner stages          | Current implementation still receives an impulse-shaped Zone Story.                                         |
| `docs/STREAMLINED_TRADE_DECISION_ROADMAP.md` | Direction/thesis/confirmation/safety decision consolidation     | It does not create or freeze an alternative entry candidate.                                                |
| `docs/PREARM_GATE_AUDIT.md`                  | Pending-order reachability and arm-time controls                | It begins after executable zone geometry exists.                                                            |
| `computeLimitEntryPrice`                     | Legacy entry-TF OB/FVG midpoint fallback                        | Scanner-local, simpler than the current authority model, and absent from backtest.                          |

Known duplication or overlap that directly affects a future implementation:

| Concept                 | Current risk                                                                                                                                              | Requirement before reuse                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Premium/discount        | The inventory records a shared implementation and a scanner-local byte-identical copy. The canonical location path also expects an impulse dealing range. | Do not add a third calculation. Resolve the existing owner and explicitly define what range a `structure_poi` candidate uses.            |
| Post-touch confirmation | `detectZoneConfirmation` and the persisted impulse confirmation lock both enforce parts of confirmation.                                                  | Do not add “top-down confirmation.” Adapt the existing confirmation contract to the selected candidate and preserve closed-bar ordering. |
| Entry selection         | Impulse/cascade selection and scanner-local `computeLimitEntryPrice` use different methodologies.                                                         | Move reusable fallback rules into `ictEntryZoneAuthority`; delete or delegate the local body once parity is proven.                      |
| Candidate identity      | Zone evidence IDs and setup lifecycle IDs intentionally identify different things.                                                                        | Keep both semantics explicit; never synthesize a new ID each scan for the same preserved opportunity.                                    |
| Market structure        | Legacy structure fields and canonical structure evidence coexist.                                                                                         | Use `canonicalStructureAuthority` for decisions; retain legacy output only as diagnostics until safely removed.                          |
| Cascade                 | A separate swing-only entry strategy remains in source despite the older unified-engine design goal.                                                      | Treat it as an existing setup family during observation. Do not build a second cascade or silently broaden it to other styles.           |

The broad cleanup of these concepts is larger than this task. The rule for the
non-impulse work is narrower: depend only on the named current owner, do not
copy logic into either orchestrator, and delete/delegate obsolete local code as
ownership moves.

## Evidence coverage: what the system can answer now

### Available today

For every completed scan, `scan_logs.details_json` can retain the following
before the hard no-impulse return:

- style and timeframe policy;
- Direction Verdict and effective direction;
- canonical structure and liquidity-sequence evidence;
- Daily/4H/1H POIs and entry-timeframe OB/FVG/breaker entities;
- factor and tiered-score diagnostics;
- current price;
- unified impulse state and qualification reasons;
- the per-timeframe evidence identity and scan cycle.

`scan_candle_snapshots` stores the exact closed candles used by the scan, keyed
by scan cycle, symbol, and timeframe. Routine scan logs and candle snapshots are
retained for 30 days by `data-cleanup`.

This is enough to count and inspect a descriptive cohort such as:

> No accepted impulse zone, but direction was available, external structure did
> not oppose it, an aligned HTF POI existed, and price was inside that POI.

The companion query is `reports/non-impulse-top-down-opportunity-audit.sql`.

### Not available today

The no-impulse hard-return path does **not** freeze:

- one canonical non-impulse candidate ID and exact zone bounds;
- an entry price selected by the shared authority;
- candidate-specific structural invalidation and position stop;
- a frozen target;
- confirmation evaluated against those exact bounds;
- final authorization for that exact geometry; or
- a counterfactual outcome linked to the candidate.

`rejected_setups` is written later in the pipeline, so it does not contain the
hard no-impulse cohort. The zone-candidate and ICT entry-zone shadow tables also
require impulse-created candidates. Existing dead-setup outcome statistics
therefore cannot be used as the win rate for non-impulse top-down opportunities.

Any result claiming “these no-impulse scans would have won” from current tables
would be inventing the missing entry and risk model.

## Recommended target architecture

No new detector, authority, canonical module, or reconciliation layer is needed.
The target should reuse the current owners:

```text
ResolvedStylePolicy / TimeframeAuthority
  -> Direction Verdict
  -> Canonical Structure + Liquidity Sequence
  -> existing OB/FVG/Breaker/Fib/liquidity evidence
  -> ICT Entry Zone Authority chooses one candidate
       setupFamily = impulse | cascade | structure_poi
  -> canonical market-location evaluation for that candidate
  -> existing confirmation policy against frozen candidate bounds
  -> Single Ownership Decision
  -> Canonical Scanner State
  -> Final Trade Authorization
  -> existing execution and management
```

The impulse setup remains available. It becomes one setup family and one source
of POI provenance rather than the universal prerequisite for every setup.

The important consolidation is semantic:

- one direction owner;
- one entry-zone selection owner;
- one candidate identity;
- one frozen setup contract;
- one confirmation contract;
- one final authorization owner;
- identical live and backtest orchestration.

## Minimal future implementation sequence

Each item below should be a separate, reviewable PR. None should begin until the
observation query has been run and reviewed.

### Phase 0 — Baseline only (this branch)

1. Run the companion SQL over the most recent 21 days.
2. Review rows in the final two categories, especially by style and pair.
3. Confirm snapshot coverage and the actual volume of opportunities.
4. Do not change `impulseZoneGateMode` for this experiment.

### Phase 1 — Observation-only candidate adapter

Modify `_shared/ictEntryZoneAuthority.ts`, the existing owner, so it can accept
already-detected non-impulse POI components with explicit provenance such as
`structure_poi`. Do not create `TopDownZoneEngine`, `POIAuthorityV2`, or another
arbiter.

Rules:

- accept only closed-bar evidence already produced by shared detectors;
- rank type-neutrally across OB, FVG, breaker, and valid overlaps;
- use the resolved style's setup/structure/confirmation timeframes;
- require stable entity/candidate identity;
- return observation-only output;
- do not modify scores, setup admission, orders, or execution.

If useful rules from scanner-local `computeLimitEntryPrice` are retained, move
them into this owner and leave a one-line delegating adapter until the legacy
caller is removed.

### Phase 2 — Generalize the existing setup contract

Change the existing `zoneStory` contract to a neutral `entryZone` concept with
provenance:

```text
setupFamily: impulse | cascade | structure_poi
candidateId
sourceEvidenceIds
zone type, timeframe, bounds, lifecycle
entry, structural invalidation, position stop, target
style policy and timeframe roles
```

Version the persisted contract. Keep compatibility readers for old rows, but do
not maintain two decision implementations. Rename the canonical scanner role
from `impulse_zone` to `entry_zone` in the same migration.

### Phase 3 — Freeze comparable observation evidence in live and backtest

For every disagreement where impulse says “no executable zone” and the existing
POI selector proposes a candidate, persist:

- exact candidate and source evidence IDs;
- style/timeframe policy hash;
- entry, structural invalidation, stop, target, and gross/cost-adjusted R:R;
- location, liquidity, confirmation, thesis, and safety observations;
- the current impulse decision for comparison;
- exact candle snapshot references.

Call the same shared adapter from `bot-scanner` and `backtest-engine`. Add
parity tests before collecting outcome evidence.

### Phase 4 — Resolve outcomes without runtime authority

Use later closed candles only. Define first-touch ordering, same-candle
inconclusive treatment, spread/commission assumptions, and style-specific
horizons before measuring results.

Use the repository's existing evidence convention: at least 30 resolved forward
disagreements for each style/pair segment under consideration, enough changed
decisions to be meaningful, and explicit winner-retention / loss-admission
reporting. Historical replay may guide research but must not unlock runtime.

### Phase 5 — Paper-only rollout

Only after review:

1. add a setup-family policy to the existing entry authority;
2. enable `structure_poi` for paper only;
3. preserve impulse/cascade as separate families, not duplicate detectors;
4. monitor authorization, fill, cancellation, and outcome evidence;
5. require explicit approval before any live rollout.

## Acceptance criteria for any later behavior PR

- No new detector or arbitration module.
- `singleConceptOwnership.test.ts` remains green and the consolidated owner is
  added to `SINGLE_OWNER` if ownership becomes stricter.
- All detectors receive closed bars only.
- The same shared candidate-selection function and configuration are used in
  live and backtest.
- A setup freezes style, timeframes, candidate identity, zone bounds, entry,
  invalidation, stop, target, and confirmation policy at creation.
- Bot Config changes affect new setups only unless an explicit lifecycle rule
  invalidates an old one.
- Detail Breakdown, Zone Setups, and Lifecycle render the same candidate ID and
  clearly label live scan versus frozen setup evidence.
- Observe mode has no execution, score, sizing, or lifecycle effect.
- Paper and live enforcement are separate, explicit decisions.
- A regression test fails when the intended change is removed.
- Full Deno test suite passes and the `bot-scanner` type-error set does not
  grow.

## Actions explicitly rejected by this audit

- Do not add a new top-down detector or “unified top-down authority.”
- Do not add an arbiter that reconciles impulse and non-impulse engines.
- Do not duplicate `computeLimitEntryPrice` into backtest.
- Do not infer a candidate from whichever UI panel happens to have data.
- Do not turn Hard to Soft/Off as a substitute for defining candidate geometry.
- Do not use current dead-setup outcome percentages as evidence for this cohort.
- Do not let current Bot Config reinterpret an already-frozen setup.
- Do not enable live authority directly from historical replay.

## Decision

The repo already has enough detection capability for a broader top-down setup
family. It does **not** yet have a safe, shared, evidence-backed executable
contract for that family.

The next action is data review, then an observation-only extension of the
existing `ictEntryZoneAuthority` owner. The impulse concept should be loosened
from “mandatory parent of every setup” to “one validated setup family” only if
forward evidence supports it.
