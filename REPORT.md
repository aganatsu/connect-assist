# Task: direction-hysteresis

## Branch: manus/direction-hysteresis

## Behavior changes

1. **Direction engine hysteresis (paths 3 & 4 in `determineDirection`):** When the 4H is retracing and the 1H has no recent confirming BOS, the engine no longer nullifies direction. Instead it checks for an **opposing 1H CHoCH**. If no opposing CHoCH exists, direction is maintained. If an opposing CHoCH is found, direction is nullified. This prevents flip-flopping when a BOS simply ages out of the lookback window.

2. **`useSimpleDirection` now defaults to `true` for all pairs.** Previously defaulted to `false`, meaning the old `confluenceScoring.ts` P/D logic determined direction. Now all pairs use the ICT top-down direction engine (Daily→4H→1H) with hysteresis, unless explicitly overridden to `false` in the database/strategy config. This means:
   - Pairs like BTC/USD and ETH/USD that previously showed "No direction determined" will now get a direction from the new engine.
   - More pairs will proceed to impulse zone detection where they previously were skipped.
   - Any pair with `useSimpleDirection: false` explicitly set in the database will continue to use the old logic (the DB value takes precedence over the default).

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/directionEngine.ts` | Added hysteresis logic to paths 3 and 4: check for opposing 1H CHoCH before nullifying direction. If no opposing signal exists, direction is maintained. |
| `supabase/functions/bot-scanner/index.ts` **(CAUTION FILE)** | Two changes: (1) Line 167: `DEFAULTS.useSimpleDirection` changed from `false` to `true`. (2) Line 773: Config merge fallback changed from `?? false` to `?? true`. Without the line 773 change, the DEFAULTS change would have no effect because the merge function had a hardcoded `false` fallback that didn't reference DEFAULTS. |
| `supabase/functions/_shared/directionEngine.test.ts` | Updated existing test for non-deterministic data; added 4 hysteresis regression tests + 2 guard tests for the default config. |

## bot-scanner/index.ts changes (caution file — detailed explanation)

**What changed:** Two lines in `bot-scanner/index.ts`:

- **Line 167 (DEFAULTS object):** `useSimpleDirection: false` → `useSimpleDirection: true`. This is the default config that applies when no DB/strategy override exists.
- **Line 773 (config merge):** `strategy.useSimpleDirection ?? raw.useSimpleDirection ?? false` → `?? true`. This is the per-pair config builder. It was hardcoding `false` as the final fallback instead of referencing DEFAULTS, so changing DEFAULTS alone would have been a no-op.

**Why:** The direction engine with hysteresis was already written and tested, but it was behind an opt-in flag (`useSimpleDirection: false` by default). Pairs like BTC/USD that didn't have this flag set in the database were still using the old `confluenceScoring.ts` P/D logic, which returned `direction: null` in many valid scenarios (e.g., ranging structure + neutral fractals). Flipping the default to `true` activates the new engine fleet-wide.

**No gate definitions, factor weights, or smcAnalysis.ts were modified.**

## Tests added

| Test | Assertion |
|------|-----------|
| `HYSTERESIS: direction maintained when 1H BOS rolls off but no opposing CHoCH` | Daily bullish + 4H retracing + 1H flat → direction = "long" (not null) |
| `HYSTERESIS: direction nullified when 1H CHoCH against bias appears` | Daily bullish + 4H retracing + 1H bearish CHoCH → direction = null |
| `HYSTERESIS: consecutive scans without 1H confirmation produce stable direction` | Two identical calls produce identical direction (no flip-flop) |
| `HYSTERESIS: source code contains hysteresis check for opposing CHoCH` | Structural guard verifying key variables/comments exist in source |
| `GUARD: bot-scanner DEFAULTS has useSimpleDirection = true` | Reads bot-scanner source, verifies DEFAULTS object has `useSimpleDirection: true` |
| `GUARD: bot-scanner config merge falls back to useSimpleDirection = true` | Reads bot-scanner source, verifies config merge line falls back to `true` (not `false`) |

## Tests run

```
$ deno test --allow-all --no-check --ignore="src/test/example.test.ts"
FAILED | 470 passed | 1 failed (7s)
```

The 1 failure is **pre-existing** and unrelated to this change:
- `impulseZoneEngine.test.ts:949`: ETH-like bearish impulse assertion (confirmed failing on `main` before any changes)

All 20 direction engine tests pass (including the 6 new ones).

## Regression check

1. Verified that the `impulseZoneEngine.test.ts` failure exists identically on `main` (not introduced by this change).
2. All 470 passing tests continue to pass.
3. Ran `determineDirection` on real BTC/USD candle data (89 daily, 2153 4H, 8614 1H candles from Yahoo Finance as of 2026-05-10). Confirmed: with hysteresis, BTC/USD gets `direction = "long"` (daily bullish, 4H retracing, 1H ranging with no opposing CHoCH). Without hysteresis, same input produces `direction = null`.
4. The hysteresis tests use deterministic candle fixtures that produce verified structure (BOS, CHoCH) via `analyzeMarketStructure`, ensuring the tests are not brittle.

## Open questions

1. **Per-pair DB overrides:** Any pair that has `useSimpleDirection: false` explicitly in the database will still use the old logic. Should those be cleaned up, or is the intent that some pairs can opt out?
2. **Lookback window size:** The opposing CHoCH check uses the same `h1BosLookback` (default 8 candles) as the BOS confirmation check. Should it use a different window?
3. **Pre-existing test failure:** `impulseZoneEngine.test.ts:949` fails on `main`. Unrelated but should be investigated separately.

## Suggested PR title and description

**Title:** `[direction-hysteresis] Enable direction engine fleet-wide with hysteresis fix`

**Description:**

Fixes direction flip-flopping caused by 1H BOS aging out of the lookback window. The direction engine now applies hysteresis: direction is only nullified when an active opposing 1H CHoCH is detected, not when confirming BOS simply rolls off.

Also enables `useSimpleDirection` by default for all pairs (was `false`), so the ICT top-down direction engine replaces the old P/D logic fleet-wide. Pairs like BTC/USD that previously showed "No direction determined" will now get direction from the new engine.

**Behavior changes:**
- More pairs will have non-null direction → more impulse zone evaluations → potentially more trade signals
- Direction is more stable between scans (no flip-flop on BOS aging)
- Any pair with explicit `useSimpleDirection: false` in DB is unaffected

6 regression tests added. 470 existing tests pass (1 pre-existing failure unrelated).
