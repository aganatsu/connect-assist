# Task: Phase 2 — propFirmGate fail-closed
## Branch: manus/propfirm-fail-closed
## Behavior changes

**YES — this changes live behavior for accounts with active prop firm configs:**

1. **Config query error (DB unreachable):** Previously passed trades through silently. Now blocks all new trades until the DB is reachable and config can be loaded. Affects any account during a Supabase outage or network partition.

2. **Broker equity unavailable (MetaAPI down):** Previously passed trades through with a warning log. Now blocks all new trades until equity data is available. Affects live accounts (or paper accounts with broker connections) during MetaAPI outages or slow responses.

3. **Equity sanity check (< 50% of initial_balance):** Previously passed trades through assuming "data error." Now blocks all new trades until a human verifies whether the data is wrong or the account genuinely lost 50%+. Affects accounts where equity data is stale, corrupted, or where a real catastrophic loss occurred.

**Critical safety note:** None of the three paths trigger `shouldCloseAll`. The gate blocks NEW trades but does NOT emergency-close existing positions — because if the data is uncertain, closing positions could lock in phantom losses on bad data. This is the conservative choice: stop digging deeper, but don't fill in the hole with concrete until you know it's actually a hole.

## Files modified

| File | Change |
|------|--------|
| `_shared/propFirmGate.ts` | Three `allowed: true` returns changed to `allowed: false` with `maxPositionSizeMultiplier: 0`. Comments updated to explain fail-closed reasoning. |
| `_shared/propFirmGate.test.ts` | 2 existing tests updated (assertions changed from `allowed: true` to `allowed: false`). 3 new tests added. |

## Tests added

1. `propFirmGate: config query error BLOCKS trades (fail-closed)` — verifies DB error → allowed=false, multiplier=0, no emergency close
2. `propFirmGate: no active config returns enabled=false, allowed=true (correct)` — verifies the "no config" path is NOT affected (this is correct pass-through, not a fail-open bug)
3. `propFirmGate: hasBrokerConnection without equity BLOCKS (fail-closed)` — verifies the `hasBrokerConnection` flag (not just `isLiveAccount`) also triggers fail-closed

## Tests run

```
propFirmGate.test.ts: 10 passed | 0 failed
Full suite: 2097 passed | 64 failed (all 64 failures are pre-existing on main, unrelated to this change)
```

## Regression check

- Ran full suite on main (without our changes): same 64 failures exist → confirmed pre-existing
- Our branch adds 3 new passing tests and changes 0 previously-passing tests to failing
- The `allowed: true` → `allowed: false` change in 2 existing tests is intentional (the tests now verify the NEW correct behavior)
- The "no active config" path (line 80-82) is explicitly tested to confirm it still returns `allowed: true` — this is the one case where pass-through is correct (no prop firm = no restriction)

## Open questions

1. **Monitoring:** When this goes live, accounts with flaky MetaAPI connections will see trades blocked during connectivity blips. This is correct behavior (better to miss a trade than blow a prop firm account), but it may generate support questions. Consider adding a dashboard indicator showing "prop firm gate: equity unavailable — trades paused" so users understand why their bot isn't taking trades.

2. **Auto-recovery:** Currently the gate will unblock automatically on the next scan cycle where equity IS available. There's no manual "unlock" needed. But if MetaAPI is down for hours, the bot is effectively paused for the entire duration. This is the intended behavior for a prop firm account (missing trades is better than unmonitored risk), but worth confirming this matches user expectations.

## Suggested PR title and description

**Title:** `[propfirm-fail-closed] Block trades when prop firm compliance cannot be verified`

**Description:**
Converts three fail-open paths in `propFirmGate.ts` to fail-closed:

- DB query error → block (was: pass silently)
- Broker equity unavailable → block (was: pass with warning)
- Equity < 50% of initial balance → block (was: pass assuming data error)

All three block new trades (`allowed: false`, `maxPositionSizeMultiplier: 0`) but do NOT trigger emergency close (`shouldCloseAll: false`) — uncertain data should prevent new risk, not force position liquidation on potentially bad numbers.

**BEHAVIOR CHANGE:** Live accounts with active prop firm configs will now have trades blocked during MetaAPI outages, DB connectivity issues, or suspicious equity readings. This is intentional — a prop firm account that can't verify compliance should not be taking new risk.
