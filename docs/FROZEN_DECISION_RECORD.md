# Frozen decision record — scope

Scoping only. No behaviour changes proposed here beyond writing a record that
is currently never written.

## The problem, stated once

The system overwrites what it decided with what happened. Four consequences,
all hit on 2026-09-15 while trying to explain 65 Era C trades:

| Question | Why it could not be answered |
|---|---|
| Was that 8.4-pip stop a bypassed floor, or a 25-pip stop that moved? | `stop_loss` is the stop **at close**. The entry stop is gone. |
| Why did identical setups risk $270 and then $540? | `balance` mutates with no ledger. Risk-at-time-of-trade is unreconstructable. |
| Which config produced this trade? | `bot_config_change_log` stores whole snapshots, not "what applied to trade X". |
| Did low-displacement legs underperform? | Measured from today, but nothing tied it to the trade until `leg_displacement` was added. |

Each was patched separately. The pattern is one thing: **no immutable record of
the decision at the moment it was made.**

## What already exists, unwired

The schema contains a complete design for this, with no writers.

```
pending_orders, paper_positions, staged_setups
  frozen_strategy_context   jsonb
  frozen_strategy_hash      text
  + 34 generated columns extracting from it
  + CHECK (frozen_strategy_hash = md5(frozen_strategy_context::text))  NOT VALID

paper_trade_history
  streamlined_decision_origin     jsonb
  streamlined_decision_latest     jsonb
  streamlined_decision_frozen_at  timestamptz
```

Verified 2026-09-15: `grep` for writers of `frozen_strategy_context` and
`streamlined_decision_origin` across `supabase/functions` returns **nothing**.
The columns, the constraints and the generated columns all survived the
September revert; the code that populated them did not.

This is why the 33 generated columns fixed during the migration can never
produce a value, and why the three `*_frozen_strategy_hash_matches` constraints
pass trivially — `NULL` satisfies `context IS NULL OR hash = md5(context)`.

## What the generated columns actually want

All 34 read one subtree:

```
frozen_strategy_context -> crossTimeframeContext -> { contractVersion,
  timeframeEvidenceId, relationship.classification, authority.{effectiveMode,
  allowed}, canonicalDealingRange.range.{contractVersion, impulseId,
  timeframe}, impulseEntryLifecycle }
```

That is the cross-timeframe authority feature, which is **not running**. Nothing
computes it.

**Do not populate `crossTimeframeContext` to light those columns up.** Writing
plausible-looking values for a feature that does not exist recreates the exact
failure this document is about: a field that reads as meaningful and is not.
Leave the subtree absent and the columns NULL — honest, and every related CHECK
passes trivially because each is guarded on `IS NULL`.

The rest of `frozen_strategy_context` is free-form jsonb. That is where the
decision record goes.

## Proposed contents

Only facts known at the moment of the decision, and only facts that were
unanswerable today. Resist adding "might be useful" fields — an oversized
context is a migration cost on every future change.

```jsonc
{
  "contractVersion": "frozen-decision.v1",
  "frozenAt": "2026-09-15T14:03:00Z",

  "risk": {
    "balanceAtEntry": 54231.18,     // what sizing actually used
    "riskPercent": 1.0,             // after STYLE_OVERRIDES, not the raw config
    "riskDollars": 542.31,          // the two answers above, multiplied
    "sizeLots": 4.13
  },

  "stop": {
    "priceAtEntry": 1.16372,        // BEFORE any trail or break-even
    "distancePips": 8.4,
    "floorPips": 20,                // MIN_SL_PIPS[pair] or minStopPips override
    "floorApplied": false,          // did the floor move the stop?
    "source": "structure"           // structure | floor | atr | impulse-origin
  },

  "config": {
    "hash": "…",                    // identifies the exact config
    "tradingStyle": "swing_trader"
  },

  "leg": { /* displacement + candleQuality, as already measured */ }
}
```

`stop.floorApplied` and `stop.floorPips` together answer today's question
directly, without needing to infer anything from the realised loss.

## The hash trap

```sql
CHECK (frozen_strategy_hash = md5(frozen_strategy_context::text))
```

`frozen_strategy_context::text` is **Postgres's** normalised rendering of the
jsonb — its own key ordering and whitespace. An md5 computed client-side over
the JSON the function sent will not match, and the insert will be rejected.

Note also that `strategy_activation_json_hash()` already exists and uses
**sha256**, not md5, so it is not the hasher for this column.

Do not hash in TypeScript. Add a `BEFORE INSERT OR UPDATE` trigger:

```sql
NEW.frozen_strategy_hash := md5(NEW.frozen_strategy_context::text);
```

The constraint then cannot be violated, and no caller has to know the rule.

## Write sites

Confirmed by grep, 2026-09-15:

| Table | Site |
|---|---|
| `pending_orders` | `bot-scanner:7217` |
| `paper_positions` | `bot-scanner:3742`, `bot-scanner:7457`, `paper-trading:1469`, `zone-confirmation-scanner:517` |
| `paper_trade_history` | `bot-scanner:2838`, `bot-scanner:7376`, `paper-trading:1217`, `:1256`, `:1596` |

Four position-creation routes. A record written by three of them is worse than
none, because the gap will read as "these trades had no frozen context" rather
than "this route was missed" — which is how the confirmation-hunt data became
unreadable.

On close, copy the position's context into
`paper_trade_history.streamlined_decision_origin` and stamp
`streamlined_decision_frozen_at`. `_latest` holds the state at close, so the
pair shows what changed during the trade's life.

## Order of work

1. Trigger for the hash, on all three tables. Nothing depends on it yet, so it
   cannot break anything.
2. Assemble the context at the single widest route (`bot-scanner:7457`) and
   write it. Verify the hash constraint accepts it and the generated columns
   stay NULL.
3. The other three position routes.
4. Carry to `paper_trade_history` on close.
5. A test asserting every `paper_positions` insert site sets the column —
   file-level, in the style of the existing scanner tests, so a fifth route
   added later fails the build.

## Deliberately not in scope

- Populating `crossTimeframeContext`. The feature does not exist.
- Backfilling history. The data is gone; a reconstructed value that looks
  measured is worse than a NULL.
- Validating the constraints (`NOT VALID` stays). Existing rows have NULL
  contexts and should not be retro-checked.
- Any change to how stops, sizing or gates behave. This records what happens;
  it does not alter it.
