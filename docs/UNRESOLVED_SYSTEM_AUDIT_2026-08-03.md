> Historical audit notice: this document was written against commit `3fa00a4`.
> Current dispositions and completed later work are maintained in
> [SYSTEM_AUTHORITY_STATUS_2026-08-03.md](./SYSTEM_AUTHORITY_STATUS_2026-08-03.md).
> Priority 1 and Priority 11 are complete and must not be reimplemented from
> this historical plan.

# Unresolved System Audit

Date: 2026-08-03  
Repository: `aganatsu/connect-assist`  
Audited branch: `codex/watchlist-lifecycle-recovery`  
Audited commit: `3fa00a4` (`Recover watchlist lifecycle and sweep authority`)

## Purpose

This is an implementation handoff for the remaining issues discussed during
the system-hardening work. It separates:

1. confirmed completed work;
2. partially implemented or observation-only work;
3. behavior that remains inconsistent or unfinished;
4. stale tests and documentation that must be repaired.

Do not treat every item below as permission to change trading behavior at once.
Behavioral changes should be isolated in focused pull requests, tested against
historical winners and losers, and activated through the existing evidence and
authority framework where applicable.

## Executive verdict

The core execution, configuration, Gameplan/Direction Verdict, style-policy,
Cross-Timeframe wiring, Watchlist persistence, scanner observability and
security foundations are materially improved.

The system is not fully unified yet. The most important unresolved behavior is
the Premium/Discount gate: it still evaluates a recent entry-timeframe swing
envelope rather than the dealing range of the selected, frozen impulse. This
can reject an otherwise valid impulse-zone setup using unrelated range
geometry.

Other significant unfinished areas are Thesis Conviction enforcement,
executable Gameplan scenarios, canonical concept identity, confirmation
unification, controlled activation of observation-only features, end-to-end
Watchlist runtime proof, unavailable Bot Config controls and broader
live/backtest parity.

## Priority 1: Canonical impulse-bound Premium/Discount authority

### Current behavior

The live safety gate reads:

```ts
const pdZone = analysis.pd.currentZone;
const pdPct = analysis.pd.zonePercent ?? 50;
```

Location:

- `supabase/functions/bot-scanner/index.ts`, Gate 2, around lines 595-613.

`analysis.pd` is produced by `runConfluenceAnalysis()` from the candles supplied
as its primary/entry-timeframe candle set:

- `supabase/functions/_shared/confluenceScoring.ts`, around line 298.

The Premium/Discount calculation uses the maximum of the last five detected
swing highs and minimum of the last five detected swing lows:

- `supabase/functions/bot-scanner/index.ts`, around lines 492-508.
- A duplicate/shared implementation also exists in
  `supabase/functions/_shared/smcAnalysis.ts`.

For a Scalper configuration, the primary candles are normally the entry
timeframe. The resulting Gate 2 range is therefore not necessarily:

- the selected impulse high and low;
- the selected Cross-Timeframe parent impulse;
- the frozen zone origin;
- the active Gameplan's intended dealing range.

### Confirmed defect

The rejection:

> Selling in discount zone rejected — price ... at 31.4% of range

does not prove that price was in discount relative to the selected impulse. It
only proves that it was in discount relative to the separate recent-swing
envelope used by `analysis.pd`.

The message also says a short needs premium above 55%, while the code only
blocks a short when the classification is `discount` below 45%. Equilibrium
between 45% and 55% passes. Message and behavior therefore disagree.

### Required solution

Create one canonical Dealing Range Authority contract. It should:

1. Prefer the selected and frozen impulse's low/high anchors.
2. Preserve the authoritative impulse timeframe and candidate/evidence ID.
3. Calculate percentage, premium, equilibrium, discount and OTE from those
   anchors.
4. Travel in `frozen_strategy_context` through Watchlist, pending order,
   confirmation, fill and position.
5. Be consumed by live scanning and backtesting through the same shared
   function.
6. Fail closed or explicitly fall back with a recorded reason when no
   authoritative impulse range exists.
7. Distinguish the canonical impulse range from informational Daily/4H/1H
   Premium/Discount context.
8. Record the exact range source in rejection and authorization evidence.

Suggested evidence shape:

```ts
interface DealingRangeAuthority {
  contractVersion: "dealing-range.v1";
  candidateId: string;
  evidenceId: string | null;
  source: "selected_impulse" | "cross_tf_parent" | "explicit_fallback";
  timeframe: string;
  direction: "bullish" | "bearish";
  low: number;
  high: number;
  currentPrice: number;
  rangePercent: number;
  classification: "discount" | "equilibrium" | "premium";
  ote: {
    inside: boolean;
    lowerPercent: number;
    upperPercent: number;
  };
  fallbackReason: string | null;
}
```

### Acceptance criteria

- The Gate 2 decision cites the same impulse ID/timeframe/low/high as the
  selected zone authority.
- Changing unrelated entry-timeframe swings cannot change the range decision
  for an already frozen setup.
- Live and backtest produce identical range evidence for identical candles and
  frozen impulse context.
- Long/short threshold messages exactly match the implemented conditions.
- Tests cover bullish and bearish impulses, equilibrium, OTE, missing-range
  fallback and a lower-timeframe range that conflicts with its authoritative
  higher-timeframe impulse.

## Priority 2: Thesis Conviction active/shadow semantics

### Current behavior

Bot Config maps:

```ts
thesisConvictionMode: "shadow" | "active"
```

However, the scanner implementation is still explicitly described as:

```ts
// Thesis Conviction Tracker (shadow mode: log only, no trade impact)
```

Location:

- `supabase/functions/bot-scanner/index.ts`, around line 6515.

The tracker calculates and persists conviction evidence, but its result does
not currently affect the effective score or final authorization.

### Required decision

Choose one of these contracts:

1. Remove/hide the `active` option until enforcement exists; or
2. Implement controlled activation using the existing strategy activation
   registry and evidence certificates.

Do not allow a UI option called `active` to imply behavior that remains
observation-only.

### Acceptance criteria

- UI, persisted config, runtime mode and evidence display use the same words.
- Shadow mode cannot affect scoring or authorization.
- Any active mode states precisely whether it is log-only, soft adjustment or
  hard block, and is capped by runtime scope.
- Live activation requires the existing evidence and approval safeguards.

## Priority 3: Gameplan scenarios remain narrative-only

### Current behavior

`setupLifecycle.ts` freezes scenario candidates with:

```ts
enforcement: "observe_only",
selectedScenarioIndex: null,
```

It explicitly records that no narrative scenario authorizes execution.

Location:

- `supabase/functions/_shared/setupLifecycle.ts`, around lines 282-292.

### Consequence

The UI may show convincing `IF -> THEN -> TARGET -> INVALIDATION` scenarios,
but the entry engine does not prove that a specific scenario was satisfied.
Scenarios currently explain the Gameplan; they are not executable setup
contracts.

### Required implementation

Before making scenarios authoritative:

1. Convert narrative fields into structured predicates.
2. Bind every predicate to canonical market evidence.
3. Select at most one same-direction scenario for a candidate.
4. Persist satisfied, pending and invalidated predicate evidence.
5. Run the evaluator in observation-only mode.
6. Compare outcomes before enabling any effect.

### Acceptance criteria

- A scenario is never selected from prose matching.
- Every selected scenario shows the exact satisfied conditions and evidence
  IDs.
- Scenario invalidation cannot conflict with the frozen zone or dealing-range
  invalidation.
- Missing scenario evidence cannot silently authorize a trade.

## Priority 4: Complete canonical concept authority

### Current state

The repository contains a useful concept-evidence foundation, but the
acceptance criteria in `docs/CONCEPT_AUTHORITY_AUDIT.md` are not fully met.

Known remaining issues:

1. The scanner and backtest mutate Tier factor presence and score after
   confluence scoring using `IMPULSE-ZONE CREDIT`.
2. The base Breaker detector and SMC Enhancement Breaker entry model are
   intentionally distinct but remain close enough in naming to confuse
   consumers.
3. Two Judas concepts remain: a session/midnight manipulation heuristic and a
   pre-MSS liquidity-sweep sequence.
4. Displacement has several contextual meanings without one explicit
   role-based qualification contract.
5. Frontend confluence summaries can describe broad concept existence where
   execution required a narrower qualification.
6. The exact same FVG/OB/swing/BOS/liquidity/displacement entity does not yet
   carry one stable ID across every Tier, Gameplan, zone, UI, live and backtest
   consumer.

### Required implementation order

Follow the order already documented in
`docs/CONCEPT_AUTHORITY_AUDIT.md`:

1. Persist stable evidence IDs, detector versions, geometry and qualification
   role.
2. Add parity fixtures for every core concept.
3. Rename semantically distinct Breaker and Judas variants.
4. Replace post-scoring Impulse-to-Tier mutations with one canonical
   qualification policy.
5. Make the UI consume persisted qualification evidence.
6. Compare full live/backtest qualification chains.
7. Remove compatibility mutations only after parity is proven.

### Acceptance criteria

- Every trade and rejection identifies the exact concept evidence used.
- The same detected entity has the same ID across all consumers.
- Disagreement is recorded as a role-specific qualification difference, not
  conflicting existence booleans.
- UI labels do not recompute broader claims.

## Priority 5: Confirmation authority is only partially unified

### Current behavior

`zoneConfirmation.ts` first delegates to the shared
`confirmationHierarchy.ts`.

If that hierarchy does not return an entry-ready result, it runs the legacy
Tier confirmation path:

- close-based CHoCH;
- wick plus support;
- reversal patterns;
- other fallback semantics.

Locations:

- `supabase/functions/_shared/zoneConfirmation.ts`, around lines 272-291.
- Legacy fallback begins around lines 294-300.

### Consequence

There is not yet one universal definition of:

- sweep detected;
- sweep rejected;
- confirmation ready;
- entry confirmed.

A setup can still become ready through a fallback definition not represented
by the primary hierarchy.

### Required implementation

Move all accepted confirmation patterns under one versioned hierarchy with
explicit levels. If wick/reversal confirmation remains valid, represent it as
a named hierarchy level rather than a hidden fallback.

### Acceptance criteria

- Every confirmation signal has one contract version, level, evidence list
  and reason code.
- Watchlist UI, confirmation scanner and final authorization display the same
  result.
- No legacy path can authorize without producing the canonical confirmation
  contract.

## Priority 6: Observation-only and shadow features are not necessarily active

The following frameworks are implemented but may remain non-enforcing when
activation is missing, stale, insufficient or scoped only to observation:

- Zone-Local Confluence;
- Cross-Timeframe Authority;
- Gameplan hierarchy proposal;
- Thesis Conviction proposal;
- narrative scenario candidates.

The safe fallback is Observe. Choosing Soft or Hard in Bot Config is a request,
not proof that runtime enforcement is active.

The last production report supplied during this work showed:

- Cross-Timeframe requested `observe`, effective `observe`;
- Zone-Local requested `observe`, activation missing, runtime not enforced.

That production state was not queried again during this audit, so it must be
reverified before claiming either feature currently affects trades.

### Acceptance criteria before promotion

- Minimum forward sample is met.
- Winner retention and loser avoidance are reported separately.
- Expectancy and drawdown improve out of sample.
- Paper activation is tested before live canary.
- Current effective mode and scope are visible in Bot Config and evidence UI.
- Emergency rollback is verified.

## Priority 7: Watchlist lifecycle lacks one complete natural proof

### Implemented

The repository contains:

- lifecycle evidence columns and history;
- canonical phase derivation;
- structural invalidation reasons;
- sweep authority evidence;
- Watchlist UI explanations;
- tests for phase derivation and persistence.

Focused Watchlist tests pass.

### Still unproven

One natural candidate has not yet been demonstrated carrying the same
candidate ID and frozen evidence through the complete chain:

```text
ZONE DISCOVERED
-> APPROACHING
-> AT ZONE
-> INTERNAL LIQUIDITY FORMING
-> LIQUIDITY SWEPT
-> SWEEP REJECTED
-> CONFIRMATION READY
-> ENTRY AUTHORIZED
-> POSITION MANAGING
```

Recent observation proved individual phases and terminal expiration, but not
the entire sequence for one candidate.

Also clarify the UI distinction:

- `CONFIRMATION READY` means the local confirmation requirement is satisfied;
- it does not necessarily mean the complete trade is ready, because score,
  Tier, Gameplan, direction, risk and runtime gates can still block it.

### Acceptance criteria

- One paper candidate completes the entire lifecycle with no manual data
  mutation.
- Candidate ID, frozen strategy hash, Gameplan version, Direction Verdict
  version, zone ID, range authority and confirmation evidence remain stable.
- Every terminal reason corresponds to actual price/order state.
- An SL boundary cannot be described as a filled-trade SL before entry; it
  must be labeled structural pre-entry invalidation.

## Priority 8: Bot Config controls still unavailable

The UI correctly marks several controls unavailable rather than silently
saving them. They remain unfinished:

### Scan and concept controls

- HTF Bias Timeframe: style controlled.
- Session Analysis: always active and not independently configurable.
- Trend Direction: reserved.
- Gameplan Auto Key Levels.
- Gameplan Session Bias.
- Gameplan PD Levels.
- ICT HTF Min Bias Strength.
- Judas Min Sweep.
- ICT FVG Min Body Ratio.
- Kill-Zone buffer.
- Consolidation threshold.

Primary location:

- `src/components/config/ScanTab.tsx`.

### Exit controls

- Max SL.
- Min SL.
- End-of-Session Close.
- Some TP selection options.

Primary location:

- `src/components/config/ExitTab.tsx`.

### Required approach

For each unavailable control, choose one:

1. implement it through the canonical config/runtime/frozen-evidence path;
2. remove it from the UI;
3. retain it as read-only and identify the actual owning policy.

Do not simply enable the input unless the scanner, backtest, frozen context and
management engine all consume it consistently.

## Priority 9: Live/backtest parity remains incomplete

### Completed foundation

- Shared Golden Replay input/decision contracts exist.
- Live and backtest use shared sizing helpers for the controlled fixture.
- A deterministic fixture exists.
- Cross-Timeframe authority parity wiring tests pass.

### Remaining gaps

- `runSMCEnhancements()` is used by the live scanner but the primary backtest
  engine does not run the equivalent full enhancement path.
- Optional/live operational context cannot always be reconstructed
  historically.
- One deterministic EUR/USD fixture does not prove parity across every style,
  asset class, entry route and feature combination.

### Required expansion

Add fixtures for:

- Scalper, Day Trader and Swing Trader.
- Forex, gold, JPY pair and cryptocurrency.
- Market, pending/confirmation, unified, cascade, standalone and Breaker
  routes.
- Sweep-required and sweep-disabled configurations.
- Premium/Discount conflicts between entry and authoritative impulse ranges.
- SMC Enhancements enabled and disabled.
- Zone-Local and Cross-Timeframe Observe/Soft/Hard effective modes.

## Priority 10: Stop-loss, sizing, session and risk authority consolidation

The earlier redundancy audit identified remaining policy overlap:

- Impulse-zone SL only replaces an existing SL when wider.
- Unified and cascade paths apply different cap/override rules.
- Position sizing applies base sizing plus prop-firm, correlation and
  signal-source adjustments.
- Opening Range, legacy session filters, ICT Kill Zones and session affinity
  are not represented by one universal trading-window contract.
- Standard risk, prop-firm risk and ICT risk protections overlap.

Shared helpers reduce implementation drift, but the policy order and ownership
should be made explicit and frozen as evidence.

## Priority 11: Test-contract maintenance

Focused audit run:

```text
48 passed
4 failed
```

The four failures were traced as follows.

### A. Two stale Bot Config assertions

`botConfigAuthority.test.ts` still expects the scanner to import
`runtimeConfigResolver.ts` directly and to call
`resolveEffectiveRuntimeConfig()` in `loadConfig()`.

The current scanner correctly uses `runtimeConfigStore.ts`, which delegates to
the canonical resolver while also supplying fail-closed database loading and
provenance.

Newer focused configuration tests passed:

```text
runtimeConfigStore.test.ts                 5 passed
runtimeConfigIntegrityWiring.test.ts       4 passed
runtimeConfigResolver.test.ts              4 passed
stylePolicyWiring.test.ts                  4 passed
watchlistLifecycleEvidence.test.ts         4 passed
Total                                     21 passed
```

Required fix: update or remove the obsolete direct-import assertions. Keep an
assertion that the scanner uses `loadEffectiveRuntimeConfig()` from the
canonical store.

### B. Stale Rejected Setups heading assertion

`zoneLocalUiParityWiring.test.ts` expects:

```text
Zone-Local Candidate Validation
```

The actual UI now uses:

```text
Zone Candidate & Cross-TF Validation
```

The evidence query and UI remain present. Update the contract test to assert
the current title and substantive evidence fields rather than relying only on
an old heading.

### C. Golden Replay locked fingerprint needs review/rebaseline

The live and backtest projections still produce the same fingerprint:

```text
golden-replay-input.v1:2d03f03528ffff0afef1ccc6c55717a65a756eaff62215212f698c8bbebc60fb
```

The fixture still expects the older value:

```text
golden-replay-input.v1:72342b915f418c19ada025b9ce705f37fe08636028747e12492c6330018c8c34
```

The fingerprint changed because the canonical runtime configuration projection
now includes additional reviewed policy fields. Live and backtest remained
equal in the diagnostic run.

Required fix:

1. inspect and approve the projected field changes;
2. confirm they are decision-facing and intended;
3. update the locked fingerprint only after that review;
4. update the roadmap's recorded fingerprint in the same PR.

Do not blindly replace the hash without reviewing the canonical projection.

## Priority 12: Documentation drift

The roadmap is no longer a reliable current-status source.

Examples:

- `docs/ZONE_LOCAL_CONFLUENCE_ROLLOUT.md` still lists PR #131 as open.
- `docs/SYSTEM_HARDENING_PHASES.md` describes several later-deployed slices as
  pending or in review.
- The stored Golden Replay fingerprint is stale.

### Required fix

Create one authoritative status table containing:

- implementation state;
- merged PR/commit;
- migration state;
- function deployment state;
- frontend publication state;
- natural runtime proof;
- effective enforcement mode;
- remaining acceptance criteria.

Other reports should link to that table rather than each maintaining a
different status.

## Confirmed completed foundations

The following should not be rebuilt from scratch:

1. Atomic pending-fill and market-entry execution authority.
2. Durable broker execution ledger and duplicate-entry protection.
3. Final authorization shared by automated entry routes.
4. Canonical runtime-config mapping, loading, fail-closed errors and frozen
   provenance.
5. Liquidity-sweep requirement reaching effective config and frozen evidence.
6. Versioned active Gameplans and Direction Verdicts with matching plan
   versions.
7. Style-aware timeframe roles and frozen style policy.
8. Cross-Timeframe authority wiring across automated entry routes.
9. Watchlist lifecycle storage, phase derivation and UI evidence.
10. Scanner runtime heartbeat and operational-alert wiring.
11. Weekend cryptocurrency Gameplan generation.
12. Edge-function caller authentication and Telegram ownership protections.

These foundations may need extension, tests or production proof, but replacing
them would add unnecessary risk.

## Recommended pull-request sequence

### PR 1: Audit hygiene only

- Repair the four stale tests.
- Synchronize roadmap/status documents.
- No trading behavior change.

### PR 2: Canonical dealing-range evidence, observation-only

- Add shared range contract.
- Bind it to selected impulse/Cross-Timeframe evidence.
- Persist it through lifecycle stages.
- Display old versus proposed Gate 2 decisions.
- No blocking change.

### PR 3: Dealing-range controlled enforcement

- Use forward and historical evidence.
- Add Observe/Soft/Hard request mode capped by activation authority.
- Paper first; live only after review.

### PR 4: Confirmation contract consolidation

- Move legacy tiers into named canonical hierarchy levels.
- Eliminate hidden authorization fallbacks.

### PR 5: Concept identity and qualification completion

- Stable IDs across all consumers.
- Rename Breaker/Judas variants.
- Replace Impulse-to-Tier post-score mutation.

### PR 6: Thesis Conviction and scenario truthfulness

- Remove misleading active semantics or wire them through controlled
  activation.
- Keep structured scenarios observation-only until evidence exists.

### PR 7: Broader live/backtest parity

- Add the missing styles, assets, routes and SMC Enhancement fixtures.

### PR 8: Remaining Bot Config controls

- Implement or remove unavailable fields one bounded group at a time.

## Safety requirements for the fixing agent

- Create a PR for every focused change; do not push behavior changes directly
  to `main`.
- Preserve unrelated working-tree changes.
- Do not alter live/paper mode, positions, trades or activation records while
  implementing code.
- Do not promote observation-only features automatically.
- Keep migrations idempotent.
- Add live and backtest tests for every shared behavioral change.
- Require a natural paper-mode proof before declaring lifecycle or enforcement
  work operationally complete.
- Always distinguish code implemented, migration applied, functions deployed,
  frontend published and runtime behavior verified.

