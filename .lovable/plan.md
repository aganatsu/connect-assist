# Fix: live trades invisible after the July 10 revert

## What is actually wrong (confirmed)

You currently have 8 positions in the database, opened today between 12:05 and 15:35 (EUR/USD x2, GBP/JPY x4, BTC/USD x2). Seven of them were mirrored to your FTMO connection, so they are real trades on MT5.

All 8 are stored with status `pending`, not `open`.

Reason: the database still carries the newer (late-August) automation, but the code was reverted to July 10.

- A database rule (`initialize_live_broker_position`) runs on every new position. When the account is in **live** mode, it forces the row to `pending` and waits for a second "broker confirmed" step to flip it to `open`.
- That second step lived in the August code. The July 10 code has zero references to it (verified: no match anywhere in `supabase/functions`).
- Result: every live trade is created and mirrored to the broker, then sits in `pending` forever. The dashboard only reads `position_status = 'open'`, so nothing appears in open positions. They never close either, so they never reach history.

Your account is in `live` execution mode, which is why this only started biting now. Paper-mode rows are unaffected.

## The fix

1. **Remove the orphaned handshake rule from the database.** Restore the July 10 behaviour: a new position is created as `open` regardless of paper/live mode, and the broker mirroring result is recorded on the row as before. Keep the informational columns (`broker_execution_state`, etc.) so nothing else breaks.
2. **Repair the 8 stuck rows.** Flip them to `open` so they show up in the dashboard and become manageable (SL/TP editing, trailing, close). Before flipping, reconcile each against MetaAPI: any row whose broker position no longer exists (already closed on the broker side) gets closed out in the app with the broker's exit instead of being reopened. The BTC/USD row with an empty mirror list is a bot-only position — it will be reopened as an unmirrored position and flagged.
3. **Audit the rest of the reverted surface.** Sweep the other database rules and columns that the August build added on `paper_positions`, `pending_orders` and `staged_setups`, and check each one against what the July 10 code actually calls. Anything that expects a step the current code no longer performs gets the same treatment (removed or made a no-op). This is where the "stuck / silent" class of bugs comes from, so it is worth doing in one pass rather than one bug at a time.

## Technical notes

- Migration: drop trigger `initialize_live_broker_position` on `public.paper_positions` (and the now-unused companion function), so the code-supplied `position_status: "open"` is honoured.
- Reconciliation: run through `broker-execute` / MetaAPI position lookup per `mirrored_connection_ids` entry, then a targeted data update on the 8 `paper_positions` rows.
- Triggers to review in step 3: `zz_sync_staged_setup_from_live_position_state`, `sync_staged_setup_from_position`, `guard_prezone_observation_execution`, `freeze_setup_strategy_context`, plus the equivalents on `pending_orders` and `staged_setups`. Findings get reported before anything is removed.
- No trading logic is changed; entries, exits and scoring stay exactly as they are on July 10.
