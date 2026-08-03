# Single-Ownership Scanner Phase 1

Implemented 2026-08-03. Adds a pure observation contract that evaluates
Direction Verdict, Zone Story, canonical location, confirmation, thesis, and
operational safety without reading legacy scores or Tier results as authority.

Legacy raw/effective scores, thresholds, counts, and Tier gate state remain in
the result as diagnostics. Live scanner, pending/rejected/trade evidence, and
backtest snapshots carry the observation.

No scanner eligibility boundary, score, Tier mutation, gate, order, or
authorization behavior changes in this phase.
