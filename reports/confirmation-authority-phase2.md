# Confirmation Authority Phase 2

Implemented 2026-08-03. Router-level authority now distinguishes structural,
indicator-only, and combined confirmation decisions. Immutable fast-scanner
attempt rows retain successful, unsuccessful, and partially satisfied results
inside the existing `zone_timeframe_evidence` store.

Both automated pending-fill routes attach the routed result to successful fill
evidence. The ordinary scanner does not yet create an attempt row for failures;
that parity gap remains explicit for the next phase.

This phase is observation-only and changes no confirmation or fill decision.
