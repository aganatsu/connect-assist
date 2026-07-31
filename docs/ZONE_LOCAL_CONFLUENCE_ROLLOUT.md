# Zone-Local Confluence Rollout

Purpose: prevent a distant Fib, support/resistance level, order block, FVG,
breaker, or liquidity pool from being counted as confluence for a small zone.
Evidence supports a candidate zone only when it is inside, overlaps, or is
within the explicit local buffer for that exact zone.

This rollout deliberately separates measurement, validation, and activation.
Collecting evidence or choosing a mode in Bot Config cannot silently change
execution.

## Phase status

| Phase | Outcome | Review state |
| --- | --- | --- |
| 1. Canonical evidence identity | Gives each market-concept observation stable geometry, provenance, timeframe, and identity. | PR #131 open |
| 2. Zone-local qualification | Measures inside, overlap, partial overlap, local buffer, and outside for every candidate zone. | Branch pushed; waits for Phase 1 |
| 3. Candidate ranking and deduplication | Compares every zone using one credit per evidence family and one credit per geometric entity. Legacy selection remains unchanged. | Branch pushed; waits for Phase 2 |
| 4. Outcome validation | Stores only rank disagreements and tracks MFE, MAE, win/loss outcomes, style, and pair. | Branch pushed; waits for Phase 3 |
| 5. Controlled enforcement | Adds Observe, Soft, and Hard decisions shared by live scanning and backtesting. Evidence authority and runtime scope cap the effective mode. | Branch pushed; waits for Phase 4 |
| 6. UI explanations and parity guards | Shows local distance/overlap, legacy-vs-local rank, effective mode, and historical validation without presenting legacy proximity as fact. | Implemented on `codex/zone-local-ui-explanations` |

## Safety contract

- The default and fallback effective mode is **Observe**.
- A missing, disabled, stale, or insufficient activation record fails closed to
  Observe.
- Selecting Soft or Hard in Bot Config is a request, not activation.
- Paper authority cannot affect live execution.
- Soft authority cannot authorize Hard enforcement.
- Historical readiness never activates runtime behavior by itself.
- The exact local evidence, rank, and effective decision are frozen with a
  staged setup and remain auditable downstream.

## UI truth contract

The Zone Story must label old detector output as **Legacy**. Canonical local
evidence is shown separately:

- **Inside / full overlap** — full local credit.
- **Partial overlap / within buffer** — partial local credit.
- **Outside** — zero local credit, with distance displayed.
- **Context only** — informative but zero local zone credit.

Rejected Setups displays style-and-pair outcome evidence for scans where the
legacy winner and local-evidence winner disagreed. “Ready” means the minimum
sample exists for human review; it does not mean the strategy is active.

## Merge order

Merge and deploy one phase at a time. After each parent is on `main`, rebase
the next branch onto current `main`, open a focused PR, and repeat. Do not
merge a later stacked branch directly into `main`.
