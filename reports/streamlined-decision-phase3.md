# Streamlined Decision Phase 3 - Lifecycle Freeze

Implemented 2026-08-03 in PR #170; Node build and Deno suite CI-verified. The observation origin is persisted on Watchlist,
pending, rejected, position, and closed-trade records. A database trigger makes
the first origin immutable. The latest stage, price, thesis, safety, and
proposed decision remain refreshable. No authorization behavior changes in
off or observe mode.

Verification: lifecycle unit tests, migration wiring test, Node build, and Deno
suite passed in CI. Deployment remains pending until merge.
