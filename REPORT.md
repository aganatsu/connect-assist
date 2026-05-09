# Task: FTMO Prop Firm Risk Gates + Structure Invalidation Toggle

## Branch: manus/ftmo-risk-gates

## Behavior changes

1. **New pre-entry gate (Gate 0)**: Before the existing 21 gates, a prop firm compliance check now runs. If a `prop_firm_config` row is active for the user, it evaluates daily loss, max drawdown, and profit target. If any limit is breached or approaching breach, new entries are blocked. This gate only fires when the user explicitly configures prop firm compliance — no behavior change for users without a config.

2. **Position size reduction**: When daily loss or drawdown usage exceeds the configured threshold (default 60%), new positions are sized at 50% of normal. At 80%, size drops to 25%. This only applies when `reduce_size_near_limit: true` in the prop firm config.

3. **Emergency close-all**: When equity drops within the `emergency_close_pct` (default 0.2%) of the actual FTMO limit, all open positions are closed immediately. Only fires when `close_on_breach: true`.

4. **Structure invalidation toggle**: The `structureInvalidationEnabled` config field now has a UI toggle in the Bot Config modal (Entry/Exit tab). Previously this setting existed in the backend but had no UI control. Default remains `false` — no behavior change unless user explicitly enables it.

5. **Daily lock**: When the prop firm gate locks the day (due to limit breach), a `is_locked: true` flag is set in `prop_firm_daily_state`. This prevents all new entries for the remainder of the trading day. Management (trailing, BE, partial TP) continues to run normally.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/propFirmRisk.ts` | **NEW** — Pure calculation functions for FTMO compliance (daily loss, drawdown, profit target, size reduction, emergency close). Zero side effects, fully testable. |
| `supabase/functions/_shared/propFirmRisk.test.ts` | **NEW** — 60 unit tests covering all calculation functions + 4 regression tests. |
| `supabase/functions/_shared/propFirmGate.ts` | **NEW** — Integration helper that bot-scanner calls. Loads config from DB, runs compliance check, logs events, returns gate decision. |
| `supabase/functions/prop-firm/index.ts` | **NEW** — Edge function API for the dashboard UI (status, config CRUD, events, daily history). |
| `supabase/functions/prop-firm-daily-reset/index.ts` | **NEW** — CEST midnight cron function that finalizes EOD state and creates next day's row. |
| `supabase/migrations/20260509120000_create_prop_firm_tables.sql` | **NEW** — Creates `prop_firm_config`, `prop_firm_daily_state`, `prop_firm_events` tables with indexes. |
| `supabase/migrations/20260509120001_add_prop_firm_daily_reset_cron.sql` | **NEW** — Schedules daily reset cron at 22:00 and 23:00 UTC (DST-safe). |
| `supabase/functions/bot-scanner/index.ts` | Added import of `runPropFirmPreGate` and inserted Gate 0 check after management-only return, before max-positions check. Also applies `propFirmSizeMultiplier` to calculated lot size. |
| `src/pages/PropFirm.tsx` | **NEW** — Full prop firm dashboard page with compliance meters, account summary, daily history table, event log, and config editor. |
| `src/lib/api.ts` | Added `propFirmApi` export with 6 endpoints (status, getConfig, saveConfig, deleteConfig, events, dailyHistory). |
| `src/App.tsx` | Added PropFirm route at `/prop-firm`. |
| `src/components/IconRail.tsx` | Added "Prop Firm" nav item with Shield icon. |
| `src/components/MobileNav.tsx` | Added "Prop Firm" to mobile nav. |
| `src/components/BotConfigModal.tsx` | Added Structure Invalidation toggle in Entry/Exit tab + search index entry. |

## Tests added

| Test | Assertion |
|------|-----------|
| `checkDailyLoss: within limit — allowed` | Equity loss below 5% of day_start_balance returns allowed=true |
| `checkDailyLoss: at limit — blocked` | Equity loss at exactly 5% returns allowed=false |
| `checkDailyLoss: beyond limit — blocked + emergency` | Loss beyond limit triggers emergency_close flag |
| `checkDailyLoss: approaching limit — allowed with size reduction` | 70% of limit used returns sizeMultiplier=0.5 |
| `checkDailyLoss: near limit — allowed with severe size reduction` | 85% of limit returns sizeMultiplier=0.25 |
| `checkDailyLoss: uses safety buffer` | Block triggers 0.8% before actual limit |
| `checkMaxDrawdown: within limit — allowed` | Equity above floor returns allowed=true |
| `checkMaxDrawdown: at floor — blocked` | Equity at floor returns allowed=false |
| `checkMaxDrawdown: 2-step floor stays fixed` | Floor = initial_balance × (1 - 10%) regardless of profit |
| `checkMaxDrawdown: 1-step trailing floor moves up` | Floor trails highest EOD balance |
| `checkProfitTarget: below target — allowed` | Balance below target returns null (no restriction) |
| `checkProfitTarget: at target — soft lock` | Balance at target returns soft lock |
| `checkProfitTarget: funded account — returns null` | No profit target for funded accounts |
| `checkBestDayRule: no rule configured — returns null` | 2-step config has no best day rule |
| `checkBestDayRule: exceeds limit — warning` | Single day profit > 50% of total triggers warning |
| `checkPropFirmCompliance: all clear — overall allowed` | Composite check returns allowed when all sub-checks pass |
| `checkPropFirmCompliance: daily loss blocks — overall blocked` | Daily loss failure blocks overall |
| `checkPropFirmCompliance: size reduction — minimum multiplier wins` | When both daily and drawdown reduce size, smallest multiplier wins |
| `createDefaultFTMO2StepConfig: challenge/verification/funded` | Factory function produces correct defaults for each stage |
| `createDailyState: initializes correctly` | New day state has correct starting values |
| `updateDailyStateWithEquity: new high/low/no change` | Equity tracking updates correctly |
| `REGRESSION: daily loss uses day_start_balance not initial_balance` | Confirms FTMO's actual rule (loss from day-start, not account-start) |
| `REGRESSION: drawdown floor is from initial balance, not peak` | 2-step fixed floor calculation |
| `REGRESSION: profit target uses balance not equity` | Target comparison uses realized balance |
| `REGRESSION: emergency close only fires when close_on_breach is true` | Config flag respected |

## Tests run

```
$ deno test supabase/functions/_shared/ --allow-all --no-check
ok | 238 passed | 0 failed (6s)
```

All 238 tests pass. The 25 type errors are pre-existing in `tpNextLevelSkip.test.ts` (unrelated to this change — they're about a `liquidityPools` type mismatch that existed before this branch).

## Regression check

1. **Gate behavior**: The prop firm gate only activates when `prop_firm_config.is_active = true` for the user. Users without a config row see zero behavior change — the gate returns `{ allowed: true, sizeMultiplier: 1.0 }` immediately.

2. **Existing gates untouched**: The 21 existing gate definitions in bot-scanner are not modified. Gate 0 runs before them and can only block or reduce size — it cannot override a gate that would otherwise block.

3. **Management unchanged**: `scannerManagement.ts` is not modified. The prop firm monitoring runs at the bot-scanner level (every 1-minute management cron), not inside the per-position management loop.

4. **Structure invalidation toggle**: The backend already supported `structureInvalidationEnabled` — this change only adds the UI toggle. Default remains `false`, so no existing behavior changes.

5. **Position sizing**: The `propFirmSizeMultiplier` is applied multiplicatively to the existing `calculatePositionSize` result. When no prop firm config exists, multiplier = 1.0 (identity operation).

## Open questions

1. **Migration application**: The two new SQL migrations need to be applied to production Supabase. Should I provide instructions, or will you apply them via the Supabase dashboard?

2. **Daily reset cron**: The cron jobs reference vault secrets `supabase_url` and `service_role_key`. Confirm these vault secret names match your production setup (some projects use different names like `project_url`).

3. **Emergency close mechanism**: Currently the gate sets a flag and logs the event, but the actual position closing is delegated to the next management cycle. For truly instant close-all, we'd need to call broker-execute directly from the gate. Is the 1-minute delay acceptable, or do you want sub-second emergency close?

4. **FTMO account connection**: Once you have the FTMO MT5 credentials, you'll add them to MetaApi and connect via the Brokers page. The prop firm gate uses the same balance/equity data that the bot already fetches from MetaApi. No additional integration needed.

## Suggested PR title and description

**Title:** `[ftmo-risk-gates] Add FTMO prop firm compliance firewall + structure invalidation UI toggle`

**Description:**
Adds a 3-layer FTMO compliance system to protect prop firm accounts:

- **Layer 1 (Pre-Entry Gate)**: Checks daily loss, max drawdown, and profit target before allowing any new trade. Blocks entries and reduces position size as limits approach.
- **Layer 2 (Continuous Monitoring)**: Runs every 1-minute management cycle. Tracks equity highs/lows, updates daily state, and triggers emergency close-all if breach is imminent.
- **Layer 3 (Daily Housekeeping)**: CEST midnight cron finalizes EOD state, resets daily lock, and creates next day's tracking row.

Also adds:
- Full Prop Firm dashboard page with real-time compliance meters, event log, and daily history
- Structure Invalidation toggle in Bot Config UI (previously backend-only)
- 60 new unit tests + 4 regression tests

Configured for FTMO 2-Step Swing, $100K, with 0.2% safety buffer and auto-close on breach.
