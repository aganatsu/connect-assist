# ICT Scanner Consolidation

Status: implementation in stacked pull requests

## Objective

Consolidate the existing end-to-end lifecycle behind one explicit scanner state and one owner per decision. This project does not add another strategy or scoring system.

## Target State

`context -> discovery -> watching -> at_poi -> awaiting_liquidity -> awaiting_confirmation -> awaiting_retracement -> authorized -> entered -> managing -> closed`

Terminal states: `blocked`, `invalidated`, `expired`.

## Authority Ownership

- Direction: Direction Verdict.
- Impulse and POI: Unified Zone / impulse-owned lifecycle.
- Location: canonical impulse range.
- Liquidity activation: frozen setup liquidity policy and zone-local BSL/SSL evaluator.
- Entry timing: candidate-owned Confirmation Contract.
- Validity: frozen thesis and impulse lifecycle.
- Safety: Final Trade Authorization.
- Execution: broker execution ledger / atomic paper fill.
- Legacy scores, tiers and duplicate ICT gates: diagnostics under Single Ownership.

## Stacked PR Plan

1. Canonical scanner-state projection and authority trace, observation only.
2. Direction fail-closed comparison and evidence capture.
3. Unified confirmation-policy contract preserving current predicates.
4. Breaker candidate normalization and legacy-route comparison.
5. Explicit frozen liquidity policy.
6. Diagnostic authority cleanup and plain primary explanations.
7. Replay comparison and controlled Single Ownership enforcement integration.
8. Frontend state visibility and operational documentation.

## Safety Rules

- Early PRs do not alter authorization.
- Behavior changes are mode-gated and default to observation.
- Missing evidence fails back to existing behavior until controlled enforcement.
- Operational safety is never downgraded.
- Pending fills rerun current thesis, location, confirmation and safety checks.
- Each PR records its parent dependency and deployment requirements.

## Deployment Ledger

1. PR #229 - canonical state and authority trace. Deploy bot-scanner and zone-confirmation-scanner.
2. PR #230 - direction availability comparison, observation default. Deploy bot-scanner.
3. PR #231 - unified frozen confirmation policy, evidence only. Deploy bot-scanner.
4. PR #232 - breaker semantic identity and impulse-ownership comparison. Deploy bot-scanner.
5. PR #233 - explicit frozen liquidity activation policy. Deploy bot-scanner and zone-confirmation-scanner.
6. PR #234 - primary decision explanation and diagnostic isolation. Deploy both scanners.
7. PR #235 - controlled canonical enforcement and comparison. Deploy both scanners. Defaults to Observe.
8. Workflow controls and state visibility. Deploy bot-config, bot-scanner, and frontend.

Do not merge stacked PRs out of order.


## Review And Merge Order

Review and merge the stack in numeric order: #229, #230, #231, #232, #233, #234, #235, then the final UI PR. Each PR is based on the previous branch.

## Effective Enforcement

The final workflow remains Observe for existing accounts. To enforce after review:

1. Set Trade Decision Mode to Enforce.
2. Set ICT Scanner Workflow to Enforce.
3. Save Bot Config.

If Trade Decision Mode is not enforcing, ICT Scanner Workflow automatically remains observation-only. Rollback is immediate: set ICT Scanner Workflow to Observe.

## Final Deployment

After all PRs are merged in order:

- Apply no database migrations; this stack adds none.
- Deploy `bot-config`.
- Deploy `bot-scanner`.
- Deploy `zone-confirmation-scanner`.
- Deploy the frontend.
- Run a manual paper scan and confirm the stage progresses through Context, Discovery, Watching, At POI, Awaiting Liquidity/Confirmation, and Authorized as applicable.


## Shadow Evidence Dataset

Rejected Setups -> Shadow Evidence includes an ICT Scanner Workflow Comparison. It reads the latest 100 completed and rejected records from existing immutable evidence, preserves Allow/Watch/Block semantics, reports outcome impact and stage coverage, and downloads the complete comparison as JSON. Historical rows created before scanner-state deployment remain Unavailable rather than being guessed.
