# Concept Inventory

Date: 2026-08-10
Purpose: for every trading concept in the system, list **every implementation**, identify
**which one is live**, and mark what must be deleted.

This document exists because the same concept has repeatedly been implemented more than
once, and the copies drift. Nine previous consolidation branches
(`consolidate-zone-engines`, `consolidate-pre-gates`, `shared-consolidation`,
`consolidate-decision-domains`, `consolidate-correlation`, `partial-tp-consolidation`,
`smc-chart-consolidation`, `gameplan-session-consolidation`, `remove-cascade-engine`)
attempted to fix this by adding an arbiter *between* the copies rather than deleting one.
That converts 2 implementations into 3. This inventory is the prerequisite for deleting
instead of arbitrating.

## Method

- Extracted all 568 `export function` declarations across `supabase/functions/`
- Grouped by concept keyword, not by name (most duplicates have different names)
- Traced live call sites from the three runtime entry points: `bot-scanner`,
  `backtest-engine`, `zone-confirmation-scanner`
- Distinguished: **duplicate** (two impls of one concept) vs **delegation** (thin wrapper,
  correct) vs **dead** (defined, never called)

---

## Summary

| Concept | Impls | Live owner | Status |
|---|---|---|---|
| **Exit fill (SL/TP hit)** | 4 | *none — no shared owner* | 🔴 **DUPLICATE, drifted** |
| **Paper final-close persistence** | 1 | `finalizePaperPositionClose` + `finalize_paper_position_close` RPC | 🟢 Single owner |
| **Full broker close** | 1 | `reconcileBrokerState.ts:reconcileFullBrokerClose` | 🟢 Single owner |
| Instrument-aware P&L | 1 | `smcAnalysis.ts:calcPnl` | 🟢 Single owner |
| Live broker target-count safety | 1 | `finalRuntimeGates.ts` | 🟢 Single owner |
| Premium/Discount | 2 | scanner-local copy | 🔴 **DUPLICATE, identical** |
| SMT divergence | 2 | scanner-local copy | 🔴 **DUPLICATE** |
| Min-confluence threshold | 2 | both (raw + effective) | 🔴 **DUPLICATE, drifted** |
| Breaker block | 2 | both (distinct semantics) | 🟠 Name collision |
| Judas swing | 2 | both (distinct semantics) | 🟠 Name collision |
| AMD phase | 2 | shared only | 🟡 Dead local copy |
| Position sizing | 3 | `computePositionSize` | 🟡 One dead copy |
| SL/TP target selection | 1 | `calculateSLTP` | 🟢 Single owner |
| Game Plan generation | 1 | `generateInstrumentGamePlan` / `game-plan-refresh` | 🟢 Single algorithm and live producer |
| Max drawdown | 2 | both, mutually exclusive | 🟢 Correct delegation |
| Session detection | 2 | `sessions.ts` | 🟢 Correct delegation |
| FVG | 1 | `detectFVGs` | 🟢 Single owner |
| Order Block | 1 | `detectOrderBlocks` | 🟢 Single owner |
| Swing points | 1 | `detectSwingPoints` | 🟢 Single owner |
| Market structure | 1 | `analyzeMarketStructure` | 🟢 Single owner |
| Liquidity pools | 1 | `detectLiquidityPools` | 🟢 Single owner |
| Zone confirmation | 1 | `detectZoneConfirmation` | 🟢 Single owner |
| Post-placement direction reversal | 1 | `thesisValidator.ts:compareDirectionVerdicts` | 🟢 Single owner |
| Post-touch CHoCH/MSS trigger | 2 enforced checks | `detectZoneConfirmation` + `impulseConfirmationLock` | 🔴 DUPLICATE ENFORCEMENT |
| Zone selection | 1 foundation + 2 strategies | `impulseZoneEngine` | 🟢 Correct layering |
| Nested entry-zone eligibility/ranking | 1 authority mode | `ictEntryZoneAuthority.ts:selectICTEntryZone` | 🟢 Single owner |

---

## Runtime account and broker status truth

`paper-trading` owns the aggregate account-status response. Database read failures return
`ok: false`, `state: "unknown"`, and a non-success HTTP status; they never become an
implicit Paper account, zero balance, or empty position/history collection. Broker connection,
account, position, and history reads follow the same contract through `src/lib/remoteRead.ts`.
A confirmed empty array means `none`; a failed or fallback read means `unknown`.

`src/lib/executionMode.ts:readExecutionMode` is the frontend owner for interpreting the
mode. Status surfaces render Unknown explicitly. Risk-increasing order, position, balance, reset,
and configuration mutations fail closed until the current account mode and broker connection list
are available, and every active broker reports a ready connection plus readable account and
open-position state. Cached function fallbacks are not accepted as current truth for these
safety-sensitive reads. Known-position closes and emergency halt controls remain available because
they reduce exposure.

Live-to-Paper is a separate de-risking transition. It requires a readable current Live mode, a fresh
broker-connection list, and an exact empty `open_trades` array from every active broker. A fresh
connection list with no active brokers is also exact empty exposure. Broker readiness, broker account
details, and internal paper-position rows do not block this transition. Any failed or fallback
open-trades read, or any non-empty broker position list, blocks it.

This frontend preflight is defense in depth, not an atomic execution guarantee. Live order fanout
still has separate orchestrators in `paper-trading`, `bot-scanner`, and
`zone-confirmation-scanner`; a server-side all-connections preflight remains required before a
partial multi-account dispatch can be ruled out.

## Runtime mode ownership

Observe modes never promote themselves. Evidence collection, replay, and review
can inform an operator, but only the existing configuration or activation owner
changes effective runtime authority. `bot-config?action=effective` projects the
saved request, effective mode, account target, prerequisite/cap reason, and any
certified maximum so the UI does not infer runtime state from draft config.

| Control | Effective-mode owner | Existing setup behavior |
|---|---|---|
| Trade Decision | Saved Bot Config directly | Re-evaluated by final authorization |
| ICT Scanner Workflow | Saved mode, gated by effective Trade Decision enforcement | Re-evaluated by final authorization |
| Market Structure Authority | Saved mode, gated by effective Trade Decision enforcement | Re-evaluated by final authorization |
| Cross-TF Alignment | Saved Bot Config directly; activation evidence is advisory metadata | Frozen context remains the setup's evidence |
| Impulse Entry Lifecycle | Saved Bot Config directly | Effective mode is frozen when the setup is created |
| Nested POI Market Trigger | Saved paper/live-scoped mode plus Market Fill prerequisite | Effective route is frozen when the setup is created |
| Zone Setup Stop Policy | Saved paper/live-scoped mode | Effective mode and stop inputs are frozen when the setup arms |
| POI Confluence / zone-local ranking | Existing activation record caps the saved request | Saving Soft/Hard alone may remain effectively Observe |
| Gameplan Hierarchy / Thesis Conviction | Research evidence only | Never changes execution |

Do not add a new authority module to reconcile these controls. A contract drift
must be repaired in the listed owner or by deleting a duplicate. In particular,
the impulse lifecycle evidence certificate is not an enforcement prerequisite;
the lifecycle row's frozen mode owns atomic deeper-zone retargeting.

## Game Plan generation and consumption

`_shared/gamePlan.ts:generateInstrumentGamePlan` is the single algorithm owner.
`game-plan-refresh` is the only live orchestrator allowed to call it and persist
an active version. `bot-scanner` is a read-only consumer; missing, expired,
malformed, or wrong-scope plans must not delay or abort pair scanning. Backtest
may invoke the same shared algorithm directly for deterministic replay.

With `gpEnforcementMode: "off"`, Game Plan remains observable but cannot reorder
the scan universe, turn its directional-news analysis into a failed gate, alter
scoring or targets, or invalidate an otherwise current Direction Verdict because
of a Game Plan version mismatch. Direction Verdict and every independent safety
gate keep their configured enforcement. Hard and soft Game Plan behavior remains
unchanged.

## SL/TP target selection

`_shared/smcAnalysis.ts:calculateSLTP` owns configured stop and target selection,
and `evaluateStyleAwareStopPolicy` in the same module owns the style-aware
initial position stop. Legacy pre-armed setups resolve their execution stop
through `resolvePreArmedPositionStop`. Activated setups use the shared
style-aware evaluator at discovery and again at the confirmation fill, then pass
its fully resolved stop to `buildPreArmedPositionPlan` for validation without
widening it.

The selected target and its source are frozen on the pending order; confirmation
may recalculate the position stop around the live fill but must not chase or
regenerate the target. `bot-scanner` and `backtest-engine` delegate next-level
retargeting to the same owner. A `next_level` setup with no structural target
meeting the saved minimum R:R either rejects or uses the explicitly configured
R:R fallback; the fallback is never implicit.

`exit.zoneSetupStopPolicyMode` is the only activation control for the pre-armed
Zone Setup route: `observe`, `enforce_paper`, or `enforce_live`. The chosen
mode is frozen when the order arms. Live enforcement requires exact constraints
from every active broker connection and fails closed when they are unavailable.
The observation contract remains stored as `stopPolicyShadow` so historical
evidence stays comparable; its result only affects execution when the frozen
activation mode requires it. The backtest orchestrator does not simulate the
post-touch pending-order lifecycle, so this route-specific activation is not
silently applied to unrelated market-fill backtests.

## Full broker close

`_shared/reconcileBrokerState.ts:reconcileFullBrokerClose` is the only owner of
full broker-position closure. Paper auto exits, manual close, kill switch,
account reset, scanner SL/TP exits, reversal exits, and prop-firm emergency
close all call it before `finalizePaperPositionClose` or deletion.

The owner consumes the execution mode and exact broker-position IDs returned by
the service-only locked close-context RPC. Broker-backed positions use the
durable execution ledger and require an exact-ID broker readback proving the
position fully closed. Symbol, direction, and comment-tag fallbacks are not
valid close identity. Missing identity, partial closure, transport ambiguity,
ledger failure, or persistence failure leaves the internal position open and
returns reconciliation-required. Only a position locked as paper-only may
finalize without broker work. Partial-close and protective-order reconciliation
remain distinct operations in the same owner module.

## Impulse entry lifecycle zone identity

`frozenCrossTimeframeContext.ts` seeds the lifecycle active candidate from the exact
zone geometry the order can execute. The observe-only ICT entry-zone authority may
supply prequalified deeper candidates, but it cannot replace the executable initial
zone. `impulseEntryLifecycle.ts` rejects an explicitly requested initial candidate when
filtering removes it; it must never silently activate a different zone. When enforcement
cannot construct that identity, the frozen context records a named unavailable reason
and the order-creation boundary rejects only that setup. It must not throw across the
scanner loop. Backtest applies the same containment check and retains its prior state
when the executable zone is outside the canonical range.

## Nested POI market trigger

`_shared/ictEntryZoneAuthority.ts:selectICTEntryZone` is the single owner of
nested market-entry candidate eligibility and ranking through its explicit
`nested_poi` mode. It consumes evidence already produced by the existing Order Block,
FVG, breaker, historical S/R, and Fibonacci owners; it does not detect those concepts
again. `impulseZoneEngine.ts:buildNestedPoiEntryPlan` only adapts and freezes the
authority result into the persisted nested-entry contract.

Expanded candidate evidence is stored separately from `localConfluence` and collected
only while this feature is enabled, so `off` preserves legacy shadow ranking,
zone-local enforcement inputs, and detector cost. The authority requires candidates to
be direction-aligned and strictly inside the selected outer impulse zone. Active
breakers use the existing breaker semantics: a previous Order Block must have broken
and remain eligible for its retest.

The outer zone is context and arming geometry only. The selected inner range or level
is frozen in the setup strategy context and becomes the lifecycle's exact executable
candidate. Its source timeframe remains provenance; the setup separately freezes the
runtime-entry timeframe used to monitor completed-candle touches. There is no midpoint or
outer-zone fallback. The activation modes are
`off`, `observe`, `enforce_paper`, and `enforce_live`; `off` preserves the
legacy Market Fill behavior, while observation records the selection without changing
entry. Each setup freezes the effective route, not just the requested mode: a live
setup under `enforce_paper` remains observational even if the account later changes
target, while a paper-created executable setup fails closed if moved to live.
Under enforcement, a completed candle must touch the frozen inner trigger before
the existing final authorization, risk, spread, sizing, and broker checks may send a
market order at the current price. The enforced nested route replaces the CHoCH and
post-CHoCH retracement steps for that setup; it does not run as an additional gate.
`pendingZoneTouch.ts:closedCandleTouchesRange` is the single owner of exact
completed-candle overlap for outer-zone and nested-trigger touches. Live and backtest
both advance the same persisted impulse-entry lifecycle through that owner.

## Post-touch CHoCH/MSS trigger

`zone-confirmation-scanner` currently requires both `detectZoneConfirmation` and
the persisted `impulseConfirmationLock` lifecycle to pass. The former can use the
frozen refinement timeframe while the latter advances on confirmation-timeframe
bars, so either check can keep a setup hunting after the other passes. This is a
known ownership violation, not correct layering.

`pending_authorization_observation` records the four-way agreement matrix without
changing authorization. That evidence must choose the surviving owner before one
check is removed. The five-minute `bot-scanner` deep-scans pending orders only while they are
near their frozen zone or hunting confirmation, refreshing prerequisites such as
Direction Verdict without owning post-touch confirmation. Runtime lifecycle advancement, replay,
and backtest still delegate through `tradeLifecycleAuthority.ts`. The shared
`impulseConfirmationLock.ts` owner emits a closed-candle build diagnostic
(`insufficient_post_touch_bars`, `protected_pivot_missing`, or
`break_pivot_missing`) that the scanner persists for Zone Setup presentation;
it does not alter the lifecycle decision.

## Frozen setup direction at final authorization

`decisionContract.ts` remains the single owner of Direction Verdict semantics.
Immediate market entries require a current aligned verdict. A pending setup that has
already frozen its direction uses `retain_frozen_until_opposed`: an unavailable or
neutral current verdict keeps the setup waiting, while a fresh explicit opposite
long/short verdict terminates it. Missing evidence never authorizes entry. The same
policy is passed through `finalTradeAuthorization.ts`,
`singleOwnershipFillAuthorization.ts`, the zone-confirmation scanner, and backtest.

`thesisValidator.ts:compareDirectionVerdicts` owns the earlier post-placement
reversal check while a setup is still waiting. Its adapter consumes the frozen
setup verdict and the dedicated persisted current verdict; it does not run a
second detector. Completeness is evaluated against the setup's frozen style
roles, so Scalper and Day Trader do not require Weekly evidence while Swing
does. A blocked, partial, stale, wrong-style, or unavailable current verdict
cannot cancel a setup.

## Live broker target-count safety

`_shared/finalRuntimeGates.ts` owns the pre-mutation broker target-count checks used
by final trade authorization. Live execution fails closed when no active execution
connection is available. It also rejects more than one target connection with
`multiple_live_connections_require_per_connection_sizing` while the execution
routes still reuse one account-derived position size across brokers. Paper execution
and authorization stages that cannot send a broker order do not invoke this guard.

Both live scanners pass the same connection set that their downstream broker loop
will consume, and authorization runs before either internal position-finalization RPC.

## Instrument-aware P&L

`_shared/smcAnalysis.ts:calcPnl` is the single owner for realized, floating, and
prop-firm-equity P&L. It resolves supported broker symbol aliases through the shared
instrument specifications and uses the caller-provided quote conversion map when
available. Invalid direction, instrument, or numeric inputs return an explicit invalid
result. Display callers may render its zero values, but accounting mutations and
simulations must reject it rather than settling a position at zero P&L. Orchestrators
must delegate to this owner rather than keeping local contract-size or pip-size tables.

## Paper final-close persistence

Exit *detection* remains owned by `_shared/exitEvaluation.ts`. Once a caller has an
exit decision, `_shared/finalizePaperPositionClose.ts` is the single owner of final
persistence. Its database RPC locks the source position and commits history insertion,
account balance movement, and source-position deletion in one transaction. Callers may
only emit post-mortems, audit rows, notifications, and broker side effects after the RPC
returns `closed: true`. Partial take profit remains a non-final size reduction.

## 🔴 Must fix

### 1. Exit fill model — four implementations, no shared owner

The single worst duplication in the system, because it silently decouples backtest results
from paper results from live results.

| Path | File | Detection | Slippage | Catches wicks |
|---|---|---|---|---|
| Backtest | `backtest-engine/index.ts:1168` | `candle.low <= sl` | 0.5 pips + gap-through | **Yes** |
| Paper (5s poll) | `paper-trading/index.ts:909` | `current_price <= sl` | 0.5 pips + gap-through | **No** |
| Paper (5m scan) | `bot-scanner/index.ts:2158` | `current_price <= sl` | **none** — fills at exactly `sl` | **No** |
| Live | broker-side resting order | broker | real | **Yes** |

Consequences:

- Paper misses every stop-out caused by a wick that recovers inside the poll window.
  Backtest and live both take those losses. **Paper equity is optimistically biased against
  both the thing you tuned on and the thing you will run.**
- The two paper paths disagree with each other. The same position exits at a different
  price depending on which cron reaches it first.

The backtest implementation is the correct one — it handles gap-through, applies slippage,
and resolves the ambiguous same-candle SL+TP case by comparing distance from the open
(`backtest-engine/index.ts:1171`). That logic should become the shared owner.

**Action:** extract `evaluateExit(bar | price, position) -> ExitDecision` into `_shared/`.
All four paths call it. Poll-based callers pass a synthetic bar
(`{high: price, low: price, close: price}`) so the same code path runs everywhere.

### 2. Premium/Discount — two byte-identical copies, both live

- `_shared/smcAnalysis.ts:2044` — `export function calculatePremiumDiscount`
- `bot-scanner/index.ts:549` — `function calculatePremiumDiscount` (private copy)

The bodies are **currently identical**. The scanner calls its own copy three times
(lines 4410, 4422, 4434) for Daily/4H/1H HTF premium-discount.

This is a landmine rather than an active bug: the copies agree today. But the
*Priority 1 item* in `UNRESOLVED_SYSTEM_AUDIT_2026-08-03.md` — replacing the rolling swing
envelope with the frozen impulse dealing range — would have to be applied in both places,
and fixing only one produces a system where Gate 2 and HTF P/D disagree about what
"premium" means.

**Action:** delete the scanner-local copy, import the shared one.

### 3. SMT divergence — two copies, scanner uses the local one

- `_shared/smcAnalysis.ts:1794` — `export function detectSMTDivergence`
- `bot-scanner/index.ts:510` — private copy, banner comment says
  *"scanner-specific, uses local detectSwingPoints"*

Live call at `bot-scanner/index.ts:4297` resolves to the **local** copy. The shared export
is used by other consumers. Two implementations of SMT are live simultaneously in different
parts of the system.

**Action:** verify the "uses local detectSwingPoints" justification still holds
(`detectSwingPoints` has a single owner, so it probably does not), then delete the local copy.

### 4. Min-confluence threshold — two comparisons, drifted

- `bot-scanner/index.ts:7495` — `effectiveScore >= conflictAdjustedMinConfluence` ✅ correct
- `bot-scanner/index.ts:819` (Gate 9) — `analysis.score < config.minConfluence` ❌ stale

**Both operands differ.** Gate 9 tests the raw score against the base threshold, while
eligibility tests the adjusted score against the adjusted threshold. Since several
adjustments are positive (`verdictScoreAdj` up to `maxBonus`, killzone prime bonus,
impulse-zone credit), a setup can clear 7495 *because of* its credits and then be rejected
at 819 on the un-credited number.

Evidence of drift: the FOTSI comment at line 1008 points at "line ~3756" for where the
penalty is applied. That line no longer exists.

**Open question — needs the author's intent.** Either this is a bug, or Gate 9 is a
deliberate *raw quality floor* ("credits may not manufacture a signal from nothing"). If
the latter, it needs renaming and documenting, not deleting. Counting `rejected_setups`
rows where Gate 9 failed while `effectiveScore` cleared the bar would settle it with data.

---

## 🟠 Name collisions on deliberately-distinct concepts

These are **not** duplicate logic. They are two genuinely different concepts that were
given the same function name, which is how they get confused for duplicates (including by
me, earlier in this review).

### Breaker blocks

| Impl | Semantic | Consumer |
|---|---|---|
| `smcAnalysis.ts:1678` | `base_breaker_zone` — is price at an inverted OB? | `confluenceScoring` factor (1.0 pt context) |
| `breakerBlockDetection.ts:87` | `sweep_displacement_retest_breaker_setup` — entry trigger | `smcEnhancements`, own confidence + size multiplier |

Both are correct and both are wired to the right consumer. `breakerCandidateAuthority.ts`
names both semantics. `conceptAuthorityAudit.test.ts` asserts they remain distinct.

**Action:** rename, do not merge. `detectBreakerZones` vs `detectBreakerRetestSetups`.

### Judas swing

| Impl | Semantic |
|---|---|
| `smcAnalysis.ts` | session-based Judas |
| `ictJudasSwing.ts` | pre-MSS Judas (`mssIndex`, `sweepLookback`) |

Same situation. Rename, do not merge.

### Candidate ID

Two different things are called `candidateId`. They are currently **disjoint** — no code
path bridges them — which is precisely why the collision has gone unnoticed.

| Impl | Semantic | Consumer |
|---|---|---|
| `zoneCandidateIdentity.ts:30` `buildZoneCandidateId` | **Zone evidence ID** — deterministic over detector, symbol, timeframe, source-candle timestamps, direction, bounds. Identifies a *market object*: this FVG/OB. | `zoneTimeframeEvidence.ts` only |
| `bot-scanner.ts:5818` `crypto.randomUUID()`, persisted | **Setup lifecycle ID** — identifies *one trading opportunity's journey*. Stable by persistence, not derivation. | `staged_setups` → `pending_orders` → `paper_positions` |

`breakerCandidateAuthority.ts:38` has a third, deterministic ID including
`structureBreakIndex`. Breaker-specific, and not the lifecycle ID.

The lifecycle ID being a persisted UUID rather than a content hash is **correct**: a
derived key containing a bar index drifts as the candle window rolls, whereas a persisted
one cannot. Stability comes from *reusing the row*, so the test that matters is "repeated
detection updates the existing watchlist row" — not "the hash is constant". A duplicate
watchlist row would silently fork the identity and no hash comparison would catch it.

As of 2026-08-12 the lifecycle ID is largely unwired: 30 of 1,325 `pending_orders` rows
carry a `candidate_id`. `bot-scanner:8877` falls back to a fresh UUID, and the breaker
path at `:10780` always generates one. Wiring it is step 3 of
`docs/PENDING_ORDER_PREARMING_PLAN.md`.

**Action:** rename, do not merge. `buildZoneEvidenceId` vs `setupLifecycleId`. Merging
them would tie a trading opportunity's identity to a market object that can be
re-detected, re-shaped, or drift out of the window mid-journey.

---

## 🟡 Dead code

- **`bot-scanner/index.ts:455` `detectAMDPhase`** — defined, **never called**. The shared
  version (`smcAnalysis.ts:348`) accepts an `atMs?` parameter for backtest time injection;
  the dead local copy does not. Delete before someone wires it up and silently breaks
  backtest determinism.
- **`ictRiskManagement.ts:240` `calculatePositionSize`** — never imported. Only `assessRisk`
  is consumed from that module. Delete.

---

## 🟢 Already correct — do not touch

Worth recording, because the codebase is in better shape than the file count suggests.

**Single-owner concepts:** `detectFVGs`, `detectOrderBlocks`, `detectSwingPoints`,
`analyzeMarketStructure`, `detectLiquidityPools`, `detectZoneConfirmation`.

**Correct delegation pattern** — `bot-scanner/index.ts:449`:
```ts
function detectSession(_config?: any): SessionResult { return sharedDetectSession(); }
```
A thin local alias that delegates to the shared owner. This is the pattern the P/D and SMT
copies should follow. `gamePlan.ts:225 getCurrentSession()` does the same, with a documented
`Off-Hours → Asian` mapping.

**Position sizing** is properly layered: `computePositionSize` (`unifiedPositionSizing.ts`)
wraps `calculatePositionSize` (`smcAnalysis.ts`) and adds volatility scaling and prop-firm
compliance. It is the sole entry point for `bot-scanner` and `backtest-engine`. Rejections
remain zero-sized through final candidate adjustments and pending-order authorization;
`normalizeBrokerVolumeDown` owns broker-step normalization and can only reduce an accepted
size, never raise it to a broker minimum.

**Max drawdown** — `gateMaxDrawdown.ts` and `propFirmRisk.ts` are both live but on mutually
exclusive paths with an explicit delegation comment (Gate 8 hands off when
`propFirmActive`). Correct.

**Zone selection is correctly layered**, contrary to the "four competing zone engines"
characterisation in earlier reviews:

```
findUnifiedZone  (unifiedZoneEngine)  ─┐
findCascadeZone  (cascadeZoneEngine)  ─┴─► findBestEntryZoneMultiTF ─► findBestEntryZone
                                                              (impulseZoneEngine)
```

One detection foundation, two competing *selection strategies* over it, resolved by an
explicit priority waterfall at `bot-scanner/index.ts:6015`. `selectICTEntryZone` is
observation-only: its standard mode is called inside `buildCandidateAuthorityObservation`,
and its explicit `nested_poi` mode owns the nested route's eligibility and ranking before
`buildNestedPoiEntryPlan` freezes the result. This is defensible architecture, not
duplication.

---

## Enforcement — the missing ratchet

`supabase/tests/_shared/conceptAuthorityAudit.test.ts` currently contains:

```ts
Deno.test("authority audit: the two Breaker contracts remain explicitly distinct", ...)
```

That is a passing test whose job is to **guarantee the duplication survives**. The mechanism
is right; it points the wrong way.

Invert it into a single-owner audit — assert that each concept has exactly one
implementation, with an explicit allowlist for the deliberately-distinct pairs:

```ts
const SINGLE_OWNER = ["detectFVGs", "detectOrderBlocks", "detectSwingPoints",
                      "analyzeMarketStructure", "detectLiquidityPools",
                      "calculatePremiumDiscount", "detectSMTDivergence", "evaluateExit"];
const ALLOWED_PAIRS = { detectBreakerZones: 1, detectBreakerRetestSetups: 1 };
// fail if any SINGLE_OWNER name is defined in more than one file
```

Now duplication is a build failure rather than something a reviewer has to catch. That is
the only form of consolidation that survives the next agent.

## Prevention

There is **no agent instructions file** in this repo — no `CLAUDE.md`, `AGENTS.md`, or
`.cursorrules`. Branch prefixes show four different AI systems have contributed
(202 `manus/`, 69 `codex/`, plus Lovable scaffolding and Claude), none sharing context.

Every agent faces the same choice on arrival: understand 3,000 lines of existing detection
logic, or write a clean new function that definitely works. Writing new always wins locally.
The aggregate is this inventory.

Minimum viable rule:

> Before adding any detector, engine, gate, or scoring function, search for an existing one
> and modify it. Do not add a parallel implementation. If the existing one is wrong, fix or
> delete it — do not leave both. New `*Authority` / `*Canonical` / `*Unified` reconciliation
> modules require explicit approval.

---

## Coverage

**Read in full:** the three detectors, `runSafetyGates`, `directionVerdict`,
`breakerBlockDetection`, `breakerSemantics`, `breakerCandidateAuthority`,
`unifiedZoneEngine` core flow, entry/SL/TP/sizing paths in `bot-scanner`,
`paper-trading` exits, `backtest-engine` fill model.

**Read structurally:** `bot-scanner` (11,278 lines), `confluenceScoring`,
`impulseZoneEngine`, `exitEngine`, `smcEnhancements`, `zone-confirmation-scanner`.

**Not read:** `gamePlan` (48KB), `configMapper` (52KB), `reconcileBrokerState` (33KB),
`advisorCore`, the AI review functions. Concepts owned solely by those files are not
covered by this inventory.

**Unresolved and blocking:** whether MetaAPI's
`historical-market-data?limit=N` returns the in-progress candle. No trimming logic exists
anywhere in `candleSource.ts` or `bot-scanner`. If the forming bar is included, every
detector reads shifting values and this is a fifth live/backtest parity break. Requires one
live API response to settle.
