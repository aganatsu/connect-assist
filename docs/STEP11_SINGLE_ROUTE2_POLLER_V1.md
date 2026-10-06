# Step 11 — one Route 2 poller (pre-deploy report)

**Status:** built and tested (PR, not merged). The account stays **paused and entries-locked**.

**Activation:** `simplification.secondPollerEnabled = false`, then unschedule the `zone-confirmation-scanner-every-minute` cron job. The code defaults to `true`, so merging alone changes nothing. No code is deleted (REMOVE LATER).

## Why

Two functions ran the Route 2 lifecycle on the same orders:

| | bot-scanner hunt | zone-confirmation-scanner (second poller) |
|---|---|---|
| Orders handled | pending + armed | armed only |
| Arm on touch | yes | — |
| Expiry | yes | **no** |
| SL invalidation / thesis checks | yes | **no** |
| Impulse broken / zone-exit reset | yes | yes |
| Position caps | 7 open / 3 per symbol, same-direction guard | **3 open / 2 per symbol, no same-direction guard** |
| Refined-zone-failure cancel | — | yes (only here) |
| Reads `is_paused` | yes | **no** |
| Can size at the fill (step 9) | yes (has the FX rate map) | no |

## What it actually did (8 days before the reset, 75 orders)

- **6 of 16 fills (38%)** came from the second poller ("fast-confirm"): CHF/JPY, EUR/USD, USD/JPY, NZD/CAD, BTC/USD, ETH/USD. The hunt made the other 10.
- **9 cancellations:** 5 impulse-broken (the hunt checks the same condition) and **4 position-cap cancellations under its stricter caps.**
- The refined-zone-failure branch fired on 287 polls but produced **0** cancellations in the window.
- Poll log: 3,261 rows (the hunt: 13,189).

## Effect of switching it off

- **Fills.** Orders the second poller would have filled are confirmed and filled by the hunt instead. The hunt runs every minute with the same `detectZoneConfirmation`, but its timing and tier settings can differ, so some fills may come at a different minute or price, or not at all. This can't be reconstructed offline.
- **Cancellations.** The impulse-broken cancel is unchanged (the hunt applies it). The 4 stricter-cap cancellations disappear; step 12 sets one cap set. The refined-zone-failure cancel (a TEST item) is dropped.
- **Risk / sizing.** Unchanged: every fill is sized by the hunt at 0.5% (step 9).
- **Already true in dry run.** The second poller skips dry-run orders entirely (step 8), so the dry-run funnel already measures single-poller behaviour.

## Tests

`step11SinglePoller.test.ts`:
- the switch defaults on;
- disabled skips the account before any order or candle fetch;
- the hunt alone covers arm, expiry, impulse-broken, zone-exit, cap, atomic fill and dry-run fill;
- refined-zone failure was second-poller-only.

Full Deno suite: 3,286 passed / 0 failed.

## Deploy plan (after your approval)

1. Merge the PR (default on, no change).
2. Set `simplification.secondPollerEnabled = false`.
3. Run once: `select cron.unschedule('zone-confirmation-scanner-every-minute');`. This stops the per-minute invocation; it's reversible from `supabase/cron/setup_cron.sql`.
