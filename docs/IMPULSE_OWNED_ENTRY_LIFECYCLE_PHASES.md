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
- [x] Display lifecycle transitions in Rejected Setups -> Shadow Evidence.
- [x] Show the saved and effective runtime modes separately in Bot Config.

### Phase 3: Controlled confirmation locking - implemented

- [x] Persist the protected pivot and exact CHoCH/MSS break level.
- [x] Permit controlled trigger revisions only before displacement locks it.
- [x] Record the first qualifying confirmation as an immutable event.
- [x] Show trigger level and revision history in Zone Setup details.

### Phase 4: Replay and parity - implemented

- [x] Continue observing deeper candidates after legacy pending cancellation.
- [x] Replay closed and rejected setups using exact candle snapshots.
- [x] Add backtest parity for advancement, expiry and impulse invalidation.
- [x] Report winner retention, rescued deeper entries and added losses.

### Phase 5: Reviewed evidence and deliberate enforcement - implemented

- [x] Publish a current, sample-ready evidence certificate for owner review.
- [x] Keep evidence review advisory and expose the actual saved/effective mode in Bot Config.
- [x] Replace legacy refined-zone cancellation with atomic deeper advancement.
- [x] Require the frozen confirmation contract before eventual fill.
- [x] Preserve final thesis, risk, duplicate-position and broker authorization at fill.

## Current Runtime Effect

The lifecycle defaults to `Observe`. Saving `Enforce` in Bot Config makes it the
effective mode for newly created setups. Each setup freezes that effective mode,
so a later Bot Config change does not silently upgrade or downgrade an existing
pending order.

Replay still publishes a hashed evidence certificate, and the account owner can
mark eligible evidence reviewed in Rejected Setups -> Shadow Evidence. That
certificate is advisory: it supports the decision to change Bot Config but is
not a second hidden runtime switch.

In Enforce, a failed candidate can atomically retarget the same pending thesis
to the next prequalified deeper candidate. The impulse remains frozen, the new
candidate receives its own confirmation contract, and final thesis, risk,
position and broker checks still run before any fill.

## Resume Prompt

Continue from `docs/IMPULSE_OWNED_ENTRY_LIFECYCLE_PHASES.md`. Apply the current
migrations, deploy the changed Edge Functions, verify saved/effective mode in
Bot Config, and keep reviewing Replay 100 evidence before deliberately changing
the runtime mode.
