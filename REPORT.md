# Task: Local Optimizer Runner + Backtest Heartbeat Fix

## Branch: manus/optimizer-backtest-heartbeat

## Behavior changes

1. **Backtest engine heartbeat during candle fetch** — The backtest engine now sends heartbeat updates before and after fetching candles for each instrument. Previously, if the candle API was slow (>5 min), the stale detection would kill the run.
2. **Optimizer error propagation** — The optimizer now reads `error_message` (from backtest engine's stale detection) in addition to the `error` field. Previously, failures showed "unknown" instead of the actual reason.
3. **Optimizer poll limit increased** — From 60 polls (10 min) to 120 polls (20 min). Accommodates multi-chunk backtests that legitimately take 15+ minutes.
4. **Optimizer config.json** — `walkForwardFolds` set to 0 (was 3), `userId` set to the user's ID.
5. **New local runner script** — `local-runner/optimizer-local.ts` runs the full optimization loop locally with a 30-minute timeout per backtest. This is the reliable path that bypasses all edge function time limits.

## Files modified

- `supabase/functions/backtest-engine/index.ts` — Added heartbeat updates during candle fetching phase
- `supabase/functions/optimizer/index.ts` — Fixed error_message propagation, increased poll limit to 120
- `supabase/functions/optimizer/config.json` — Set walkForwardFolds=0, added userId
- `supabase/functions/optimizer/optimizer.test.ts` — Added 4 tests for error propagation and poll limit
- `local-runner/optimizer-local.ts` — NEW: Full local optimizer runner script
- `local-runner/.env.local.example` — Updated with correct Supabase URL and instructions

## Tests added

1. `Error propagation: error_message field is preferred over error field`
2. `Error propagation: falls back to error field when error_message is absent`
3. `Error propagation: falls back to 'unknown' when both fields are absent`
4. `Poll limit: optimizer allows up to 120 polls (20 min) for multi-chunk backtests`

## Tests run

```
ok | 37 passed | 0 failed (26ms)
```

## Regression check

- Heartbeat additions are purely additive (new `updateProgress` calls). No logic changes.
- Error propagation uses `||` fallback chain — identical behavior when `error_message` is undefined.
- Poll limit increase only affects wait duration, not scoring or trade decisions.
- Local runner uses the exact same `OptimizationLoop` and `createHTTPBacktestRunner` as the edge function.

## Open questions

1. The edge function approach remains unreliable when the candle API is slow. The local runner is the recommended path.
2. Walk-forward folds are set to 0. Re-enable (2-3) for production optimization once baseline completes.
3. The userId is hardcoded in config.json.

## Suggested PR title and description

**Title:** feat: local optimizer runner + backtest heartbeat fix

**Description:**
Adds `local-runner/optimizer-local.ts` — a standalone Deno script that runs the full optimization loop locally with 30-minute backtest timeouts (no edge function limits).

Also fixes the root cause of optimizer failures:
- Backtest engine now sends heartbeats during candle fetching
- Optimizer properly reads `error_message` from failed backtests
- Poll limit increased from 60→120

Usage:
```bash
cd local-runner
cp .env.local.example .env.local  # add your service_role_key
deno run --allow-all optimizer-local.ts --trials=10 --verbose
```
