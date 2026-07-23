# Task: Per-Trade Override Fix
## Branch: manus/fix-trade-overrides

## Behavior changes

1. **Status API now returns `tradeOverrides` and `effectiveConfig` per position** — previously these fields were absent from the status response, causing the frontend to guess from stale `exitFlags` data.
2. **Update position API now returns `effectiveConfig` and `tradeOverrides`** — previously only returned `{ success, position }`. The frontend now uses this to update state immediately without a full refresh.
3. **TradeOverrideEditor no longer flickers back to "After 1R"** — the root cause was that after saving overrides, the next status poll returned positions without `trade_overrides` data, so the UI re-initialized from `exitFlags` (which always showed the original signal-time defaults). Now the UI reads from `effectiveConfig` (the resolved merge of global config + per-trade overrides).

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/resolveTradeConfig.ts` | **NEW** — Shared helper with `extractGlobalExitConfig()`, `parseTradeOverrides()`, and `resolveTradeConfig()`. Single source of truth for merging global bot config with per-trade overrides. |
| `supabase/functions/_shared/resolveTradeConfig.test.ts` | **NEW** — 12 Deno tests covering extraction, parsing, and resolution logic. |
| `supabase/functions/paper-trading/index.ts` | **MODIFIED** — Status response now includes `tradeOverrides` + `effectiveConfig` per position. `update_position` response now returns `effectiveConfig` + `tradeOverrides` after saving. |
| `src/components/TradeOverrideEditor.tsx` | **REWRITTEN** — Reads `effectiveConfig` from API response (single source of truth). `handleSave()` and `handleReset()` update local state from API response immediately. Eliminates flicker and stale defaults. |

## Caution-file explanation: paper-trading/index.ts

Two targeted additions were made to `paper-trading/index.ts`:

1. **Status handler** (around line 1212): After building the position array for the status response, each position now includes `tradeOverrides: parseTradeOverrides(p.trade_overrides)` and `effectiveConfig: resolveTradeConfig(globalExitConfig, parseTradeOverrides(p.trade_overrides))`. The `globalExitConfig` is computed once from the user's bot_config before the position loop. This is purely additive — it adds two new fields to the response object without changing any existing fields or logic.

2. **update_position handler** (around line 1460): After the position is updated in the database, instead of just returning `{ success, position }`, it now also fetches the user's bot_config, resolves the effective config, and returns `{ success, position, tradeOverrides, effectiveConfig }`. This allows the frontend to update its state immediately from the response without needing to poll status again.

Neither change affects trade execution, position sizing, or gate logic. They are purely response-enrichment for the frontend.

## Tests added

| Test | Assertion |
|------|-----------|
| `extractGlobalExitConfig — extracts from nested exit object` | Correctly reads all fields from `config.exit.*` |
| `extractGlobalExitConfig — falls back to top-level keys` | Falls back to `config.breakEvenEnabled` etc. when no `exit` sub-object |
| `extractGlobalExitConfig — uses defaults for empty config` | Returns sensible defaults (BE=true/20pips, trail=false/15pips, etc.) |
| `extractGlobalExitConfig — handles null/undefined input` | Doesn't crash on null config |
| `parseTradeOverrides — returns null for null/undefined/empty` | Null/empty/"{}" all return null |
| `parseTradeOverrides — parses JSON string` | Correctly parses stringified overrides |
| `parseTradeOverrides — handles object directly` | Passes through already-parsed objects |
| `parseTradeOverrides — returns null for invalid JSON` | Gracefully handles malformed strings |
| `resolveTradeConfig — returns global config when no overrides` | Null overrides = global config unchanged |
| `resolveTradeConfig — overrides specific fields only` | Only overridden fields change; rest stays global |
| `resolveTradeConfig — override can disable a globally-enabled feature` | `{ breakEvenEnabled: false }` correctly disables |
| `resolveTradeConfig — full override replaces all fields` | Complete override set replaces every field |

## Tests run

```
$ deno test --no-check --allow-all supabase/functions/_shared/resolveTradeConfig.test.ts
running 12 tests from ./supabase/functions/_shared/resolveTradeConfig.test.ts
ok | 12 passed | 0 failed (11ms)
```

Full suite (1384 tests): 1377 passed, 7 failed. All 7 failures are **pre-existing** (beTrailingRace, brokerFillPriceBE, zoneLiquidity) — verified by running the same tests on `main` without our changes and observing identical failures.

TypeScript: `npx tsc --noEmit` → EXIT: 0 (zero errors)

## Regression check

- **Pre-existing behavior preserved**: The `resolveTradeConfig` helper is additive — it's only called in the status/update_position response paths to compute display data. The actual trade management logic in `scannerManagement.ts` was not modified.
- **No change to what trades get taken or how positions are sized**: The override system already existed in the database (`trade_overrides` column) and was already read by `scannerManagement.ts`. This fix only ensures the frontend correctly displays and persists those overrides.
- **Verified on `main` branch**: The 7 failing tests fail identically without our changes, confirming zero regression.

## Open questions

1. **Supabase Edge Function deployment**: The `resolveTradeConfig.ts` shared helper and `paper-trading/index.ts` changes need to be deployed to Supabase for the fix to take effect in production. User needs to run `supabase functions deploy paper-trading` after merge.
2. **Pre-existing test failures**: 7 tests in `beTrailingRace.test.ts`, `brokerFillPriceBE.test.ts`, and `zoneLiquidity.test.ts` fail on `main` — these appear to be tests written ahead of implementation or with outdated assertions. Not related to this task.

## Suggested PR title and description

**Title:** fix(overrides): proper per-trade override system with resolved effective config

**Description:**
Fixes the TradeOverrideEditor flicker bug where saved overrides would revert to "After 1R" defaults on every status refresh.

**Root cause:** The status API didn't return `trade_overrides` or resolved config, so the UI re-initialized from stale `exitFlags` data (which reflected signal-time defaults, not current overrides).

**Fix:**
- New `resolveTradeConfig.ts` shared helper (single source of truth for merging global config + per-trade overrides)
- Status API now returns `tradeOverrides` + `effectiveConfig` per position
- `update_position` API returns `effectiveConfig` + `tradeOverrides` after saving
- `TradeOverrideEditor` rewritten to use API-resolved config; updates state from response immediately without needing refresh

**Testing:** 12 new Deno tests, 0 TypeScript errors, no behavior changes to trade execution logic.
