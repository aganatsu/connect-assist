# System Authority Status

Verified: 2026-08-03 against `main` after PR #173

This is the authoritative reconciliation of
`UNRESOLVED_SYSTEM_AUDIT_2026-08-03.md`. The audit was produced from older
commit `3fa00a4`; its findings remain useful, but its implementation statuses
must not be read as current without this table.

## Status vocabulary

- **Complete**: merged, CI-verified, deployed, and runtime evidence reviewed.
- **Implemented**: merged and CI-verified; runtime proof may still be pending.
- **Partial**: a shared foundation exists, but an acceptance criterion remains.
- **Unresolved**: the current code still exhibits the audited behavior.
- **Superseded**: later work replaced the audited implementation plan.

## Reconciled priorities

| Priority | Current status | Verified current evidence | Next action |
|---|---|---|---|
| 1. Canonical impulse-bound P/D | Complete; audit plan superseded | PRs #159-#166 implement the contract, lifecycle freeze, parity observation, explicit modes, explanations, comparison UI, and countdown fix. The migration and affected functions were deployed and the comparison is collecting evidence. | Continue evidence collection. Do not rebuild the authority. |
| 2. Thesis Conviction semantics | Unresolved | Config still accepts `shadow` and `active`; scanner comments and persistence remain observation-oriented, while backtest applies a non-shadow adjustment. UI/runtime semantics are therefore not one contract. | Define one versioned shadow/soft/block contract; remove or hide misleading activation until certified. |
| 3. Executable Gameplan scenarios | Unresolved by design | `setupLifecycle.ts`, scanner, and backtest still persist `enforcement: "observe_only"` with no selected scenario. | Create structured predicates and an observation evaluator before any authority change. |
| 4. Canonical concept identity | Partial | Shared detectors exist, but stable cross-consumer `fvgId`, `obId`, structure-event IDs, and qualification records are absent. Scanner and backtest still apply `IMPULSE-ZONE CREDIT` mutations after confluence scoring. | Introduce identity/provenance without changing qualification behavior, then replay before removing mutations. |
| 5. Confirmation authority | Phase 1 observation implemented; behavior still unresolved | `zoneConfirmation.ts` delegates to `confirmationHierarchy.ts`, then can authorize through legacy close/wick/reversal fallbacks when the hierarchy is not entry-ready. | Verify `confirmation-authority.v1`, persist rejected/watch-only observations, replay outcomes, then move accepted patterns into named levels without changing predicates. |
| 6. Controlled activation | Partial | Zone-local, cross-timeframe, canonical range, and streamlined-decision controls have evidence-gated authority. Thesis and narrative scenarios do not. Requested mode still does not prove effective mode. | Add a single effective-mode/status projection; promote features only through existing certificates. |
| 7. Natural Watchlist proof | Partial | Storage, immutable origin evidence, lifecycle phases, sweep evidence, and UI exist. No recorded natural candidate proves every phase through an opened position. | Capture one unmodified paper lifecycle with stable candidate and evidence IDs. This is operational proof, not a code rewrite. |
| 8. Unavailable Bot Config controls | Unresolved | Scan and Exit tabs still intentionally mark the audited HTF, session, concept, SL, TP, and end-of-session controls unavailable. | Resolve controls in bounded ownership groups: implement end to end, make read-only with owner, or remove. |
| 9. Live/backtest parity breadth | Partial | Golden Replay, shared sizing, canonical range, cross-timeframe, and streamlined observations exist. Main backtest still does not run `runSMCEnhancements`; route/style/asset coverage remains narrow. | Add parity fixtures before attempting behavioral consolidation. |
| 10. SL, sizing, session, risk policy order | Partial | Base sizing and final candidate adjustments are shared, but breaker sizing and some route-specific overrides remain separate. Session/kill-zone and risk layers remain multiple authorities without one frozen order contract. | Document current precedence, add decision traces, then consolidate one policy family per PR. |
| 11. Test-contract maintenance | Complete | The stale config and zone heading assertions were repaired. Golden Replay fingerprints were reviewed/rebaselined as runtime fields changed. PRs #170-#172 passed Node test/build and the full Deno suite. | Keep semantic assertions and locked fingerprints reviewed in the same PR as projection changes. |
| 12. Documentation drift | In progress | The older hardening and rollout documents still contain historical statuses. This document establishes one current table and the old audit now links here. | Update older roadmaps only when their owning work changes; link to this table for current unresolved status. |

## Protected foundations

Do not rebuild or bypass these while resolving the remaining priorities:

1. atomic pending-fill and market-entry authority;
2. final runtime authorization and operational/risk gates;
3. canonical runtime config and frozen style policy;
4. active Gameplan and Direction Verdict version matching;
5. canonical dealing-range and cross-timeframe frozen authority;
6. Watchlist, pending, position, and streamlined origin evidence;
7. Zone Story, impulse, OB/FVG, liquidity, sweep, displacement, and structure
   detectors;
8. Golden Replay and evidence-certificate controls.

## Approved implementation order

1. Confirmation contract inventory and observation adapter.
2. Stable concept identities and qualification provenance.
3. Thesis Conviction semantics and controlled activation.
4. Structured Gameplan scenario observation.
5. Expanded live/backtest fixtures, including SMC Enhancements.
6. Unavailable Bot Config controls in bounded ownership groups.
7. SL, sizing, session, and risk precedence contracts.

Every behavior-changing step requires its own PR, historical and forward
evidence, paper scope first, explicit rollback, and separate approval for live
enforcement.

## Deployment record

- PR #170: streamlined decision phases 3-8, CI verified.
- PR #171: retry-safe certificate policy migration.
- Migration `20260803130000_add_streamlined_decision_lifecycle.sql`: applied.
- Certificate table, freeze trigger, and SELECT policy: verified in Supabase.
- Required Edge Functions: redeployed in repository deployment commit
  `9962cee`; owner confirmed deployed functions.
- Current comparison evidence is observation-only and still below enforcement
  sample requirements.
