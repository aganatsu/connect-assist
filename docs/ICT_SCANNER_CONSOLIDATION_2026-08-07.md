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
4. Breaker semantic identity and impulse-ownership comparison. Deploy bot-scanner.

Do not merge stacked PRs out of order.
