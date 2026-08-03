# Single-Ownership Scanner Phase 2

Date: 2026-08-03

## Scope

Phase 2 exposes the observed single-ownership decision beside the legacy scanner
decision in Rejected Setups. It does not change scanner authorization.

## Implemented

- A pure comparison builder reads the versioned `singleOwnershipDecision` stored
  in closed-trade and rejected-setup evidence.
- The authenticated bot-config function returns the most recent combined sample
  of 100 records.
- Rejected Setups shows coverage, disagreements, winners preserved, poor entries
  rejected, and the first ten disagreements.
- Missing or incomplete observations are explicitly unavailable and are not
  counted as agreements or disagreements.

## Decision Boundary

The legacy scanner remains authoritative in this phase. Zone Story, Direction
Verdict, canonical location, confirmation, thesis and operational safety are
only compared against that legacy result.

## Next Phase

Add a default-observe, paper-only enforcement mode. Live execution must remain
on observation, and operational safety must remain fail-closed.
