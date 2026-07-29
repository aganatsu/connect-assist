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
| 1 | Shared resolved style-policy contract and durable observability | Complete and production-verified |
| 2 | One configuration resolution path for every runtime surface | Complete and production-verified |
| 3 | Remove duplicate UI presets and show the effective runtime policy | Complete and production-verified |
| 4 | Make timeframe roles authoritative for every analysis module | Implemented; review and deployment pending |
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

Slice 1 was production-verified on 2026-07-29. Automatic Gameplan version
`1375a448` and all eight matching Direction Verdicts persisted
`style-policy.v1.1`, the same non-null base-policy hash, the selected `scalper`
style and matching Gameplan-version references.

Slice 2 introduces one canonical resolution order for server-side runtime
surfaces: stored/request configuration → canonical field mapping → selected
trading-style profile. The automatic scanner resolves before its interval gate
and position-management cycle; the fast confirmation scanner, manual Gameplan
refresh and backtest engine use that same resolver. Surface-specific backtest
constraints remain explicit post-resolution overrides.

Slice 2 was production-verified on 2026-07-29 from main merge `014dc901`.
Natural scanner and confirmation cycles loaded the shared resolver, resolved
the selected `scalper` style to a five-minute cadence and completed without
configuration-resolution, import or runtime errors.

Slice 3 removes the frontend's executable conservative/moderate/aggressive
style presets. Selecting Scalper, Day Trader or Swing Trader now changes only
the requested style and preserves every explicit Bot Config override. The
backend resolver remains the sole owner of executable profile values. Bot
Config and the scan header display the persisted effective policy—including
cadence, timeframes, confluence gate, target ratio, risk, management behavior,
contract version and base-policy hash—rather than recreating those values in
the browser. User-saved custom full-config presets remain available.

Slice 3 was production-verified on 2026-07-29 from main merge `f11e4d3`.
The live Bot Config displayed `style-policy.v1.1`, base hash
`a538f6b1f46d`, Scalper, five-minute cadence, 5m/1H runtime timeframes, a
20% effective gate, 2:1 target, 0.5% risk, trailing management and four
preserved overrides. An unsaved Day Trader selection changed only the pending
selection and left the effective live policy unchanged.

Slice 4 introduces one policy-derived timeframe authority for structural
analysis. Direction and unified-zone engines in both the automatic scanner and
backtest now bind candles by the immutable bias → structure → setup roles
instead of maintaining separate style switches. Direction labels and zone
labels are generated from the same role contract. The backtest now fetches
actual 15-minute structure candles for Scalper instead of substituting 1-hour
candles, closing a material live/backtest parity gap. The separate
confirmation and refinement roles remain explicit for the next decision-layer
slice; they are not silently repurposed as structural inputs.

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
