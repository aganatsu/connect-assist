# Add Prop Firm on/off toggle

## Goal
Give you a one-click switch on `/prop-firm` to turn the prop firm gate off (so paper scans stop being blocked by the profit-target lock) without wiping your config, plus a "Unlock today" button that clears the current daily lock so scans resume immediately.

## Current state (verified)
- `paper_accounts.execution_mode = 'paper'` for user `57c79dee…`, bot `smc`
- `prop_firm_config` is active with a $10k profit target
- Today's `prop_firm_daily_state.is_locked = true` (reason: profit target reached)
- Every scan since 10:22 UTC exits via `runPropFirmGate` → "prop_firm_locked"
- `deleteConfig` action already exists (sets `is_active=false`) — no re-enable action yet

## Changes

### 1. Backend — `supabase/functions/prop-firm/index.ts`
Add two new actions:
- `config.setActive` — flip `is_active` true/false on the existing row (no delete, keeps all settings)
- `daily.unlock` — sets today's `prop_firm_daily_state.is_locked = false`, clears `lock_reason` and `locked_at`, and logs a `manual_unlock` event

### 2. API — `src/lib/api.ts`
Add `propFirmApi.setActive(active: boolean, botId?)` and `propFirmApi.unlockToday(botId?)`.

### 3. UI — `src/pages/PropFirm.tsx`
In the header row next to the ACTIVE/LOCKED badge:
- Small `Switch` labeled "Prop firm gate" — checked when `config.is_active`; unchecking calls `setActive(false)`, checking calls `setActive(true)`. Confirms with a toast.
- When `dailyState.is_locked === true`, show an "Unlock today" button next to the badge that calls `unlockToday()` and invalidates the status query.

Also surface `config.is_active === false` as a new badge state ("Disabled") so it's obvious the gate is off but the config is preserved.

No other pages or scanner logic change — bot-scanner already skips the gate when no active config exists (verified in `propFirmGate.ts` line 82-84).

## Result
Flip switch off → next 5-min cron tick, SMC scans resume and start writing to `scan_logs` again. Flip back on when you want FTMO rules enforced.
