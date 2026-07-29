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
| 5 | Operations and scanner reliability | Not started |
| 6 | Rejected Setups and shadow evidence | Not started |
| 7 | Backtest/live parity | Not started |
| 8 | Strategy validation and controlled activation | Not started |

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
