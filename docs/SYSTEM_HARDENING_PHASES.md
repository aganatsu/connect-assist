# System hardening roadmap

This file is the repository-level status tracker for the agreed eight-phase
implementation plan. A phase is only marked complete after its migration,
functions and UI have been deployed and verified.

| Phase | Purpose | Status |
|---|---|---|
| 1 | One execution authority | Complete and concurrency-verified |
| 2 | Bot Config contract | Complete |
| 3 | Unify Gameplan, Direction Verdict and thesis | Complete and production-verified |
| 4 | Watchlist and Zone Setup lifecycle | Implementation complete; deployment verification pending |
| 5 | Operations and scanner reliability | In progress — Phase 5A merged; Phase 5B in review |
| 6 | Rejected Setups and shadow evidence | Not started |
| 7 | Backtest/live parity | Not started |
| 8 | Strategy validation and controlled activation | Not started |

## Corrective Phase 2C / 3C — style-aware policy consistency

This workstream was added after the full critical-path audit found that the UI,
full scanner, fast confirmation scanner, manual Gameplan refresh, position
management and backtest engine do not all interpret the selected trading style
the same way. It must finish before Phase 6 begins.

| Slice | Purpose | Status |
|---|---|---|
| 1 | Shared resolved style-policy contract and durable observability | Implemented in `codex/style-policy-observability`; review and deployment pending |
| 2 | One configuration resolution path for every runtime surface | Not started |
| 3 | Remove duplicate UI presets and show the effective runtime policy | Not started |
| 4 | Make timeframe roles authoritative for every analysis module | Not started |
| 5 | Rewire Gameplan, Direction Verdict, thesis and conviction to those roles | Not started |
| 6 | Make Gameplan validity windows style-aware | Not started |
| 7 | Freeze the policy through Watchlist, pending, confirmation and fill | Not started |
| 8 | Use one style-frozen management engine in live and backtest paths | Not started |

Slice 1 is observe-only. It assigns two stable fingerprints: a base-policy hash
for comparing shared style/configuration across surfaces, and an exact policy
hash that includes pair-specific execution adjustments. It records the
effective style, timeframe roles, cadence, qualification thresholds, risk,
management, lifecycle values and override provenance on active Gameplans,
Direction Verdicts, Watchlist setups, pending orders and positions. Scan logs
and backtest results expose the same snapshot. It does not alter authorization,
position sizing, order placement or management behavior.

## Phase 3 implementation record

- Phase 3A moved active Gameplans into dedicated immutable versioned storage
  and made manual and automatic refreshes use the same data/configuration path.
- Phase 3B establishes the ordered decision hierarchy:
  Gameplan context → Direction Verdict authority → thesis validity → entry
  confirmation.
- Direction Verdict now has its own versioned source of truth instead of being
  recovered from general scan logs.
- Candidate observations, pending orders and positions retain the exact
  Gameplan version, Direction Verdict, thesis result and confirmation evidence
  used at their stage.
- Thesis validity is a hard fill-time safety decision. Thesis Conviction is
  explicitly observational and cannot authorize a trade.

Phase 3 was production-verified on 2026-07-29. A natural eight-pair scan
persisted eight active Direction Verdicts, and every verdict referenced the
matching active Gameplan ID and shared plan version. No Direction Verdict
authority or persistence errors were present in that scan cycle.

## Phase 4 implementation record

- Watchlist and Zone Setup candidates now use one auditable lifecycle:
  watching → qualified → pending → awaiting confirmation → filled, with
  explicit invalidated, expired, cancelled and blocked-after-qualification
  outcomes.
- Crossing the score gate records qualification only. A setup is not treated
  as successfully promoted until its pending order or position is created.
- Every setup carries a stable candidate ID plus its exact Gameplan, Direction
  Verdict, thesis, originating zone, confirmation rule and authorization
  evidence through pending order and position creation.
- Confirmation mode and its indicator threshold are frozen when the setup is
  created. Later Bot Config changes do not rewrite an in-flight setup.
- Database triggers preserve status changes in an owner-readable lifecycle
  event history and keep Watchlist state synchronized with downstream pending
  orders and positions.

Phase 4 becomes operationally complete after the migration is applied, both
scanners and the frontend are deployed, and a natural paper-mode setup proves
that one candidate ID and matching decision evidence appear from Watchlist
qualification through its final outcome.

## Phase 5 implementation record

- Phase 5A introduces a durable per-user, per-bot runtime timeline before
  background scanner work begins.
- Full scans record invocation, scan start, live pair progress, pair-processing
  completion and final completion. Management and confirmation cycles record
  their own start, heartbeat and completion evidence.
- Scheduled Tasks reads this runtime evidence instead of treating manual
  `run_now` updates as proof that cron executed.
- Full-scan overlap protection moves from the mutable `paper_accounts` timestamp
  to an atomic user + bot + scope lease. Manual scans cannot clear another
  invocation's valid lease.

Phase 5A becomes operationally complete after its migration is applied, the
three Edge Functions and frontend are deployed, and natural cron cycles show
advancing heartbeats and completion timestamps.

- Phase 5B adds a one-minute database health evaluator with an initial grace
  window, durable deduplicated alerts and automatic recovery.
- It detects missing heartbeats, incomplete runs, MetaAPI certificate and
  connection failures, total candle-source exhaustion, stale confirmation
  orders, repeated scheduler authorization failures and required migration
  drift.
- Scheduled Tasks displays the active alerts and their repeat count. Alerts
  resolve automatically when the underlying condition recovers.
