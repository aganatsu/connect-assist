# Task: ICT Weekly-Daily HTF Framework

## Branch: manus/ict-weekly-daily

## Behavior changes

none — pure addition of new modules. No existing bot-scanner logic, gates, scoring, or trade execution is modified. The three new modules are standalone and not yet wired into the scan loop.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/weeklyBiasDOL.ts` | **NEW** — Weekly bias determination via confirmed trend (HH/HL or LH/LL detection using existing `confirmedTrend`), Draw on Liquidity identification (weekly FVGs, liquidity pools, swing levels), premium/discount zone detection, and confidence scoring. |
| `supabase/functions/_shared/weeklyBiasDOL.test.ts` | **NEW** — 9 tests covering insufficient data, bullish/bearish/ranging bias detection, DOL identification, confidence scaling, FVG detection, liquidity pool detection, and result structure completeness. |
| `supabase/functions/_shared/dailyImpulseOB.ts` | **NEW** — Daily displacement detection (body ratio >= 0.65, range/ATR >= 1.3, body/avgBody >= 1.8), Daily OB identification (last opposing candle before displacement), OB invalidation tracking, containment check (is LTF zone inside Daily OB?), and cascading containment (Weekly -> Daily -> 4H -> 1H -> 15m nesting). |
| `supabase/functions/_shared/dailyImpulseOB.test.ts` | **NEW** — 16 tests covering insufficient data, bearish/bullish displacement detection, ranging market non-detection, OB finding before displacement, OB invalidation, full analysis result, direction-aligned OB selection, containment (full/partial/outside/below threshold), and cascading containment (all nested/entry outside/no zones). |
| `supabase/functions/_shared/ictHTFIntegration.ts` | **NEW** — Orchestration layer that runs weekly bias -> daily impulse -> containment in sequence. Supports three gate modes: "hard" (block trade if misaligned), "soft" (score penalty/bonus only), "off" (disabled). Configurable bonus (+2.0 default) and penalty (-3.0 default). |
| `supabase/functions/_shared/ictHTFIntegration.test.ts` | **NEW** — 11 tests covering disabled/off mode, weekly bias alignment/misalignment in hard/soft mode, containment pass/fail, no weekly candles graceful handling, full alignment bonus, result structure, and default config validation. |

## Tests added

| Test file | Count | Key assertions |
|-----------|-------|----------------|
| `weeklyBiasDOL.test.ts` | 9 | Bullish trend -> bullish bias; bearish trend -> bearish bias; ranging -> neutral/low confidence; DOL targets found; FVGs detected; liquidity pools detected |
| `dailyImpulseOB.test.ts` | 16 | Displacement detected with correct direction; OB identified as last opposing candle; OB invalidated when price closes past; containment math correct at various overlap levels; cascading containment validates nesting |
| `ictHTFIntegration.test.ts` | 11 | Hard mode blocks misaligned trades; soft mode always passes with penalty; full alignment gives +2.0 bonus; missing weekly data doesn't crash; disabled mode returns pass |

## Tests run

```
$ deno test supabase/functions/ --allow-all --no-check
ok | 1138 passed | 0 failed (17s)
```

All 1138 tests pass (36 new + 1102 existing). Zero regressions.

## Regression check

No regression check needed — these are new standalone modules that do not modify any existing code paths. The bot-scanner, scoring engine, gates, and trade execution are completely untouched. The full test suite (1138 tests) passes without modification.

## Open questions

1. **Integration into bot-scanner**: The next step is to wire these modules into the scan loop. This requires:
   - Fetching weekly candles (new API call, once per scan cycle)
   - Calling `runICTHTFAnalysis()` per pair after the direction engine runs
   - Using the result as a gate (hard/soft) and applying the score adjustment
   - Adding the ICT HTF config keys to the user-configurable settings

   This will be a **behavior change** (trades will be filtered/scored differently). Should I proceed with this as the next task?

2. **Gate mode default**: Currently defaulting to "soft" mode so the bot doesn't suddenly skip trades. Should it start as "off" for a burn-in period where it only logs, then switch to "soft"?

3. **Weekly candle source**: The bot currently fetches from Capital.com/OANDA. Need to confirm weekly candle availability and determine the lookback period (currently set to 20 weeks minimum, 52 weeks ideal).

## Suggested PR title and description

**Title:** `feat: ICT Weekly Bias/DOL + Daily Impulse/OB + Containment framework`

**Description:**
Implements the ICT 2022 Mentorship higher-timeframe framework as three new shared modules:

- **Weekly Bias + DOL** (`weeklyBiasDOL.ts`): Determines weekly directional bias using confirmed trend structure (HH/HL or LH/LL) and identifies Draw on Liquidity targets (FVGs, liquidity pools, swing levels).
- **Daily Impulse + OB** (`dailyImpulseOB.ts`): Detects daily displacement candles (institutional aggression), identifies the Daily Order Block (last opposing candle before displacement), tracks OB invalidation, and provides containment checking.
- **Integration Layer** (`ictHTFIntegration.ts`): Orchestrates weekly + daily analysis with configurable gate modes (hard/soft/off) and score adjustments.

**Key design decisions:**
- Modules are standalone — not yet wired into bot-scanner (no behavior change)
- Reuses existing `confirmedTrend`, `detectSwingPoints`, `calculateATR` from smcAnalysis.ts
- Displacement criteria: body/range >= 65%, range/ATR >= 1.3x, body/avgBody >= 1.8x
- Containment requires >= 50% overlap (configurable)
- Soft mode: always passes but applies -3.0 penalty for misalignment
- Hard mode: blocks trade if weekly bias opposes direction or zone not contained

36 new tests, all 1138 tests pass.
