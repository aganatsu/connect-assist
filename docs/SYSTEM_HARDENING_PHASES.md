# System hardening roadmap

This file is the repository-level status tracker for the agreed eight-phase
implementation plan. A phase is only marked complete after its migration,
functions and UI have been deployed and verified.

| Phase | Purpose | Status |
|---|---|---|
| 1 | One execution authority | Complete and concurrency-verified |
| 2 | Bot Config contract | Complete |
| 3 | Unify Gameplan, Direction Verdict and thesis | Implementation complete; deployment verification pending |
| 4 | Watchlist and Zone Setup lifecycle | Not started |
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

Phase 3 becomes operationally complete after the Phase 3B migration is applied,
the two scanners and frontend are deployed in order, and a natural scan proves
that the UI, pending-order row and resulting trade use matching version IDs.
