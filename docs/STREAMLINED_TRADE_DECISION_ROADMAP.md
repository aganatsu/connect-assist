# Streamlined Trade Decision Roadmap

Status: approved proposal; implementation not started
Last verified: 2026-08-03

This is the canonical tracker for the streamlined decision work. Update it
whenever a phase PR is opened, merged, deployed, verified, blocked, or
superseded. Completed phases also receive an immutable report in reports/.

## Purpose

The bot has strong market detectors and reliable authority, lifecycle, and
execution contracts. The remaining problem is how their evidence is combined
and explained:

- factor weights, tiers, percentages, confidence values, adjustments, conflict
  counters, and gates overlap;
- the same market fact can influence multiple decision layers;
- raw, effective, Watchlist, and displayed scores can differ;
- users cannot easily see which result authorized or blocked a trade.

The new model starts read-only, proves itself with historical and forward
evidence, and only then becomes eligible for controlled enforcement.

## Protected Capabilities

These capabilities are assets and must be preserved:

- Zone Story and its higher-to-lower-timeframe narrative
- impulse and parent/child impulse authority
- order blocks and fair value gaps
- canonical dealing range and premium/discount location
- liquidity, sweeps, displacement, MSS, BOS, and CHoCH
- Unified, Cascade, and standalone zone paths
- Direction Verdict and style-aware timeframe authority
- Game Plan context
- Watchlist, pending-order, and position evidence freeze
- thesis validation and thesis-conviction history
- final trade authorization and all operational/risk protections
- golden replay and live/backtest parity evidence

The streamlined evaluator organizes this evidence and ensures each fact has one
decision role. It does not remove effective detectors.

## Verified Baseline

These statements were checked against the codebase on 2026-08-03.

### Existing authorities to reuse

- directionVerdict.ts is the directional authority.
- decisionContract.ts orders Game Plan, Direction Verdict, thesis validity,
  and entry confirmation.
- finalTradeAuthorization.ts is the route-independent execution authority.
- crossTimeframeEntryAuthority.ts governs cross-timeframe entry policy.
- frozen Watchlist, pending, position, style-policy, canonical-range, and
  cross-timeframe evidence already exist.
- golden replay contracts already capture comparable live/backtest decisions.

### Remaining complexity

- confluenceScoring.ts describes a 22-factor engine, but its current factor
  inventory is larger and still evolving.
- It produces weighted factors, Tier 1/2/3 counts, a normalized percentage,
  opposing-factor counts, and embedded gate results.
- The scanner builds an effective score from base confluence plus FOTSI,
  impulse-zone, zone-local, cross-timeframe, ICT, and Direction Verdict
  adjustments.
- Structure, regime, Game Plan, FOTSI, premium/discount, and liquidity can
  influence more than one layer.
- The safety-gate confluence check reads the raw score while candidate
  eligibility can use the effective score.
- Watchlist eligibility can use effective score while stored current_score
  values use raw score.
- Thesis Conviction calculates an adjustment and records it, but that
  adjustment is not in the current effective-score formula.
- The frontend presents factors by both groups and tiers.

### Historical evidence already available

- paper_trade_history: completed decisions and outcomes
- rejected_setups: blocked opportunities and counterfactual outcomes
- scan_logs: factors, gates, Zone Story, score, and decision details
- staged_setups: Watchlist lifecycle and promotion evidence
- strategy_evidence_certificates: certified shadow comparisons
- golden replay snapshots: normalized live/backtest decision evidence

Replay must be point-in-time. Missing newer evidence is marked unavailable and
must never be guessed from current state or future candles.

## Target Decision Model

One versioned summary has four independent outputs.

### 1. Direction

Question: Which direction, if any, is authorized?

Output: long, short, or neutral, with one confidence band and provenance.

Owner: Direction Verdict. HTF structure, regime, Game Plan, and currency
strength belong here and must not also inflate setup quality.

### 2. Setup Quality

Question: How good is this entry in the authorized direction?

Output: one 0-100 score from four 0-25 pillars.

| Pillar | Evidence examples |
|---|---|
| Structure | Valid impulse, BOS/CHoCH, displacement |
| Location | Zone Story, canonical range, OB/FVG, liquidity, Fib |
| Confirmation | Sweep, MSS, rejection, zone response |
| Timing | Session quality, kill zone, market conditions |

Each evidence item has one owning pillar. Required confirmation remains an
explicit requirement instead of being hidden inside a tier count.

### 3. Thesis Health

Question: Is the frozen setup idea still valid?

Output: healthy, weakening, or invalid.

This controls lifecycle: keep watching, continue cautiously, or cancel. It does
not silently alter setup quality.

### 4. Safety Authorization

Question: Is the account and market currently safe to execute?

Output: passed or blocked, with normalized reasons.

Only operational and risk checks belong here: bot state, kill switch, exposure,
portfolio heat, daily loss, drawdown, news, spread, stale prices, duplicates,
broker/prop-firm state, and minimum risk/reward.

### Final rule

A trade is authorized only when:

1. direction is long or short;
2. setup quality meets the style threshold;
3. required confirmation is present;
4. thesis health is not invalid; and
5. every safety check passes.

## Phase Tracker

| Phase | Deliverable | Behavior | Status |
|---|---|---|---|
| 0 | Verified baseline and durable roadmap | Documentation only | Complete |
| 1 | Pure TradeDecisionSummary contract | Observation only | Not started |
| 2 | Canonical evidence-to-pillar mapping | Observation only | Not started |
| 3 | Freeze and persist summary through lifecycle | Observation only | Not started |
| 4 | Historical replay and comparison engine | Observation only | Not started |
| 5 | Rejected Setups comparison UI | Observation only | Not started |
| 6 | Scanner, Watchlist, pending, fill, and backtest parity | Observation only | Not started |
| 7 | Evidence review and retirement proposal | Documentation only | Not started |
| 8 | Controlled enforcement | Opt-in, evidence-gated | Not approved |

## Phase 1 - Decision Summary Contract

Create a pure, deterministic, versioned TradeDecisionSummary.

Required output:

- contract version, evaluation time, and candidate identity
- frozen style and timeframe authority references
- Direction result, confidence band, reasons, and provenance
- four pillar scores and nonduplicated evidence references
- Thesis Health state and history reference
- Safety Authorization and normalized gate codes
- proposed decision: allow, watch, block, or unavailable
- completeness and unavailable-evidence list

Constraints:

- no database or network access in the evaluator;
- no order, position, score, threshold, or lifecycle behavior changes;
- identical evidence produces identical output;
- no future/current evidence fallback during replay.

## Phase 2 - Evidence Mapping

Create an explicit registry assigning every active detector output to one role.

Deliverables:

- inventory of factors, tier promotions, adjustments, and gates;
- evidence ownership table;
- duplicate-influence report;
- tests covering Zone Story, impulse, OB/FVG, canonical range, liquidity,
  sweep, displacement, confirmation, timing, and direction context;
- rules for missing and contradictory evidence.

Zone Story remains a primary Location explanation. It does not become a
separate score or second authority.

## Phase 3 - Lifecycle Freeze

Persist the observation summary with scan candidates, Watchlist setups, pending
orders, rejected setups, positions, and closed trades.

Origin evidence stays frozen. Current price, Thesis Health, and Safety
Authorization may be reevaluated without replacing the original setup story.

## Phase 4 - Historical Replay

Replay closed and rejected setups through the proposed evaluator.

For every sample, record:

- current decision;
- proposed decision;
- actual or counterfactual outcome;
- evidence completeness;
- exact disagreement reasons.

Report:

- winners preserved and newly blocked;
- losing entries rejected and newly allowed;
- expectancy, profit factor, and maximum drawdown;
- results by pair, style, session, and setup type;
- unavailable evidence and sample-size confidence.

Start with 100 records, then expand toward 300-500 comparable records. Replay
evidence alone cannot activate live enforcement.

## Phase 5 - Comparison UI

Location:

Rejected Setups -> Shadow Evidence -> Streamlined Decision Comparison

Show coverage, aggregate decisions, outcomes, individual disagreements,
expandable pillar details, Zone Story, authority provenance, and unavailable
evidence. Bot Config keeps controls only, not the historical dataset.

## Phase 6 - Path Parity

Run the same evaluator in observation mode for:

- scanner;
- Watchlist promotion;
- zone confirmation;
- immediate entry;
- pending fill;
- breaker entry;
- manual scan;
- backtest; and
- retrospective replay.

Identical frozen evidence must produce identical summaries. Surface adapters
may gather evidence but cannot own separate scoring models.

## Phase 7 - Evidence Review

Do not remove legacy behavior automatically. Produce an evidence-backed
retirement proposal for:

- duplicated factors and direction adjustments;
- Tier 1/2/3 logic that pillars can replace;
- raw/effective score inconsistencies;
- soft adjustments that should become evidence or explicit requirements;
- market-evidence gates that duplicate pillars;
- safety gates that must remain unchanged.

Every removal needs historical comparison, forward shadow evidence, and a
rollback plan.

## Phase 8 - Controlled Enforcement

Requires separate approval.

Proposed modes:

- off: current system only;
- observe: current system executes and the new summary records;
- enforce: the new summary participates in authorization.

Start in paper trading with limited style/scope. Enforcement must be
evidence-certified and reversible. Legacy scoring is not deleted until stable.

## Acceptance Rules

Every implementation PR must:

- include a complete description;
- declare observation-only or behavior-changing status;
- include focused unit and wiring tests;
- pass Node tests, production build, and Deno tests;
- preserve protected market evidence and final safety authorization;
- use normalized reason codes instead of display-string matching;
- mark missing evidence unavailable;
- update this tracker and add a report under reports/;
- avoid enforcement without explicit approval.

## Completed Related Work

- PR #159: canonical dealing-range contract
- PR #161: frozen canonical range through lifecycle
- PR #162: canonical range parity observations
- PR #163: configuration modes and historical comparison
- PR #164: Node and Deno CI toolchain
- PR #165: comparison evidence moved to Rejected Setups
- PR #166: live news-event countdown

Cross-timeframe impulse phases 1-8 are in reports/phase1-* through
reports/phase8-*. Existing hardening status remains in
docs/SYSTEM_HARDENING_PHASES.md.

## Current Next Action

Implement Phase 1 only:

1. define the versioned pure contract;
2. map existing evidence into its input without changing execution;
3. add deterministic tests;
4. attach the observation to scan detail only;
5. update this tracker and create reports/streamlined-decision-phase1.md;
6. open a described PR and run full CI.

Do not enforce, delete tiers, or change thresholds in Phase 1.

## Restart Prompt

Copy and paste this into a future Codex session:

> Continue the streamlined trade-decision work in this repository. First read
> docs/STREAMLINED_TRADE_DECISION_ROADMAP.md, then verify the current branch,
> git status, merged PRs, existing phase reports, and relevant code before
> making changes. Treat the roadmap as the canonical tracker, but verify every
> claim against current code because later work may have changed the system.
> Preserve Zone Story, impulse, OB/FVG, canonical dealing range, liquidity,
> confirmation, frozen lifecycle authority, and final safety authorization.
> Continue only the Current Next Action unless I approve a later phase. Update
> the roadmap and add a phase report when work is completed. Every PR needs a
> full description and must pass Node, build, and Deno CI. Explain the work in
> beginner-friendly language before enforcement or destructive retirement.

## Maintenance Protocol

At the end of each phase:

1. update phase status;
2. record PR, merge commit, deployment, and verification status;
3. summarize behavior changes and non-changes;
4. record tests, evidence coverage, and unresolved risks;
5. update Current Next Action;
6. add the matching immutable report in reports/.

This file is the live tracker. Phase reports are the permanent completion
record.
