# Impulse-Owned Entry Lifecycle

## Objective

Make the impulse thesis the stable authority while allowing one failed OB,
FVG, Breaker or composite entry zone to advance to a deeper prequalified zone
inside that same impulse.

`HTF bias -> frozen impulse -> ordered entry zones -> liquidity -> confirmation -> entry -> management -> exit`

## Non-Negotiable Rules

- A failed entry zone does not automatically invalidate its impulse.
- Only candidates prequalified inside the frozen canonical impulse may advance.
- Advancement is deeper-only; failed or shallower candidates cannot revive.
- Only one candidate is active at a time.
- Each candidate owns a new confirmation contract. Confirmation cannot transfer.
- A close beyond the impulse protected level ends the complete thesis.
- Timeframe Evidence proves lineage but never authorizes an entry by itself.

## Phase Status

### Phase 1: Contract and persistence - implemented

- [x] Pure versioned lifecycle state machine.
- [x] Separate candidate failure and impulse invalidation.
- [x] Deterministic deeper-only candidate ordering.
- [x] Fresh confirmation generation per active candidate.
- [x] Optimistic revision checks and immutable transition history.
- [x] Watchlist, pending-order and position attachment schema.

### Phase 2: Observation wiring - implemented

- [x] Build from canonical range and ICT entry-zone candidates.
- [x] Freeze the selected confirmation method and timeframe roles.
- [x] Observe candidate/impulse closes in the one-minute confirmation monitor.
- [x] Default existing and new accounts to Observe.
- [x] Display the active zone, deeper queue and impulse protection in Watchlist.

### Phase 3: Controlled confirmation locking - pending

- [ ] Persist the protected pivot and exact CHoCH/MSS break level.
- [ ] Permit controlled trigger revisions only before displacement locks it.
- [ ] Record the first qualifying confirmation as an immutable event.
- [ ] Show trigger level and revision history in Zone Setup details.

### Phase 4: Replay and parity - pending

- [ ] Continue observing deeper candidates after legacy pending cancellation.
- [ ] Replay closed and rejected setups using exact candle snapshots.
- [ ] Add backtest parity for advancement, expiry and impulse invalidation.
- [ ] Report winner retention, rescued deeper entries and added losses.

### Phase 5: Enforcement - blocked on evidence

- [ ] Require a reviewed evidence certificate.
- [ ] Expose Enforce only after certification.
- [ ] Replace legacy refined-zone cancellation with atomic deeper advancement.
- [ ] Reauthorize thesis, risk and broker state at the eventual fill.

## Current Runtime Effect

The lifecycle is `Off` or `Observe` only. It records and explains candidate
transitions but does not change an entry, cancellation or broker action. This is
intentional until replay and forward evidence demonstrate that deeper-zone
advancement improves outcomes.

## Resume Prompt

Continue from `docs/IMPULSE_OWNED_ENTRY_LIFECYCLE_PHASES.md`. Verify the branch,
migration and CI. Complete Phase 3 without enabling enforcement or allowing a
confirmation event from one candidate to authorize another candidate.
