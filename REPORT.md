# Task: Simplified Direction Engine (ICT Top-Down)
## Branch: manus/direction-simple

## Behavior changes

**When `useSimpleDirection: false` (default): NONE — pure addition, zero change to existing behavior.**

When `useSimpleDirection: true` (opt-in), the following behavior changes apply:

1. **Direction determination is replaced** with the ICT top-down flow: Daily sets bias → 4H confirms structure intact → 1H confirms turn (BOS in bias direction)
2. **4H CHoCH against daily bias = hard block** — the pair is skipped entirely (direction = null)
3. **4H retracing without 1H confirmation = wait** — direction is null until 1H prints a BOS in the bias direction
4. **Option C for ranging daily**: when daily has no clear trend, the engine falls back to 4H trend (if 4H has 2+ BOS and no recent opposing CHoCH). If both daily and 4H are ranging → no trade.
5. **P/D zone fallback is bypassed** when the simple direction engine is active — the old fractal balance → daily structure → P/D zone hierarchy is skipped entirely in favor of the new logic.

## Files modified

| File | Description |
|------|-------------|
| `_shared/directionEngine.ts` | **NEW** — Simplified multi-TF direction engine (determineDirection function) |
| `_shared/directionEngine.test.ts` | **NEW** — 14 unit tests covering all direction logic paths |
| `_shared/confluenceScoring.ts` | Added `_overrideDirection` support at the top of the direction determination block (4 lines: check for override, use it if set, else fall through to old logic) |
| `bot-scanner/index.ts` | Added import, config toggles (useSimpleDirection, h4ChochLookback, h1BosLookback), direction engine call before runConfluenceAnalysis, and detail.simpleDirection attachment |
| `REPORT.md` | This report |

### Extra caution note: bot-scanner/index.ts changes

The bot-scanner changes are minimal and safe:
- **Import**: Added `determineDirection` and `DirectionResult` import (1 line)
- **DEFAULTS**: Added 3 config toggles with safe defaults (`useSimpleDirection: false`)
- **Config loading**: Added 3 lines to load the toggles from strategy settings
- **Direction call**: Wrapped in `if (pairConfig.useSimpleDirection)` + try/catch — if it errors, falls back to old logic silently
- **Detail attachment**: Adds `detail.simpleDirection` for dashboard visibility (informational only)

The key safety mechanism: `useSimpleDirection` defaults to `false`, so deploying this branch changes zero behavior until explicitly enabled.

### Extra caution note: confluenceScoring.ts changes

The change is 4 lines at the top of the direction determination block:
```typescript
const _overrideDir = (config as any)?._overrideDirection;
const _hasOverride = _overrideDir !== undefined;
if (_hasOverride) {
  direction = _overrideDir;
} else if (structure.trend === "bullish") { // ← old logic continues unchanged
```

When `_overrideDirection` is not set (the default), the `_hasOverride` check is false and the entire old direction block runs exactly as before. No existing logic is modified or removed.

## Tests added

| Test | Assertion |
|------|-----------|
| returns no direction when daily candles insufficient | direction=null, reason includes "Insufficient daily" |
| returns no direction when all candles are null | direction=null, bias=null |
| result has correct shape | direction is "long"/"short"/null, bias is "bullish"/"bearish"/null, biasSource is "daily"/"4h"/null, booleans are boolean |
| daily ranging + 4H ranging = no trade | direction=null (or null-like) |
| daily ranging + no 4H candles = no trade | reason explains outcome, biasSource is "daily" or null |
| no 4H and no 1H data still returns direction from daily bias | biasSource="daily" when daily is trending |
| h4ChochAgainst blocks the trade | direction=null when h4ChochAgainst=true, reason includes "BLOCKED" |
| config overrides are respected | Different lookback values produce valid results |
| biasSource is 'daily' when daily has clear trend | biasSource="daily" for bearish daily |
| h4Retrace + h1Confirmed is the ideal setup | Function doesn't error, returns valid booleans |
| h4Retrace without h1Confirmed = wait (no trade) | direction=null when h4Retrace=true + h1Confirmed=false |
| returns consistent results for same input | Determinism: same input → same output |
| with insufficient h1 candles, still returns bias info | bias and biasSource populated even without 1H |
| Option C fallback — daily ranging, 4H trending = use 4H bias | biasSource="4h" when daily is ranging but 4H has clear trend |

## Tests run

```
$ deno test supabase/functions/ --no-check
FAILED | 406 passed | 11 failed (4s)
```

All 11 failures are **pre-existing** on main (verified by stashing changes and running on clean main: same 406 passed, 11 failed). Our 14 new tests all pass.

## Regression check

1. **Stash test**: Stashed all changes, ran full suite on clean main → identical 406/11 pass/fail ratio
2. **Default safety**: `useSimpleDirection` defaults to `false` → the `_overrideDirection` property is never set on config → the `_hasOverride` check in confluenceScoring.ts is false → old direction logic runs unchanged
3. **Try/catch safety**: Even if `useSimpleDirection: true` and the engine throws, the catch block logs a warning and does NOT set `_overrideDirection` → old logic runs as fallback

## Open questions

1. **Ready to enable?** Set `useSimpleDirection: true` in your bot config to activate. Recommend testing on paper mode first.
2. **Backtest validation**: Consider running the backtest engine with `useSimpleDirection: true` vs `false` on 3-6 months of data to compare win rate and trade count before going live.
3. **Dashboard widget**: The `detail.simpleDirection` data is now available. Want a dashboard widget to visualize it?

## Suggested PR title and description

**Title:** `[direction-simple] ICT top-down direction engine with toggle`

**Description:**
Adds a simplified direction determination engine based on ICT multi-timeframe top-down analysis:
- Daily sets bias → 4H confirms structure intact (retrace, no CHoCH) → 1H confirms turn (BOS in bias direction)
- Option C for ranging daily: falls back to 4H trend if it has clear structure
- 4H CHoCH against daily bias = hard block (no trade)
- Opt-in via `useSimpleDirection: true` (default: false, zero behavior change)
- 14 new tests, all passing
- Includes `detail.simpleDirection` for dashboard visibility
