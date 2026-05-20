# Task: HTF Confluence Scoring
## Branch: manus/htf-confluence-scoring

## Behavior changes

1. **Zone scoring now includes HTF confluence layers.** When `htfData` is passed to `findBestEntryZone` / `findBestEntryZoneMultiTF`, each candidate zone receives additional score points (0–5) based on overlap with 4H Order Blocks (+1), 4H FVGs (+1), 4H Breaker Blocks (+1), HTF Fibonacci levels (+0.5 for 50%, +1.5 for 61.8%/71%/78.6%), and Premium/Discount alignment (+0.5). This means **zones backed by HTF structure will rank higher** than naked zones at the same Fib depth.

2. **Maximum possible zone score increased from 6 to 11.** Previously: fibScore(4) + SR(1) + LTF(1) = 6. Now: fibScore(4) + htfConfluence(5) + SR(1) + LTF(1) = 11. The reason string in scan logs now shows `/11` instead of `/6`.

3. **Scan detail output includes `htfConfluenceScore` and `htfLayers`.** The `impulseZone.bestZone` object in scan detail now includes `htfConfluenceScore` (number) and `htfLayers` (string array like `["4H_OB", "HTF_FIB_61.8", "PD_ALIGNED"]`).

4. **When `htfData` is not provided (e.g., insufficient 4H candles), behavior is identical to before.** The `htfData` parameter is optional; when omitted, `htfConfluenceScore` stays 0 and `htfLayers` stays empty. This is a backward-compatible addition.

5. **No gate behavior changes.** The impulse zone engine remains informational (enriches scan detail, does NOT gate trades). The HTF confluence score only affects zone ranking within the engine, not whether a trade is taken.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/impulseZoneEngine.ts` | Added `HTFConfluenceData` interface, `checkHTFConfluence()` function, initialized `htfConfluenceScore`/`htfLayers` in `overlayFibOnPOIs`, updated all `totalScore` calculations to include `htfConfluenceScore`, updated `findBestEntryZone` and `findBestEntryZoneMultiTF` signatures to accept optional `htfData`, inserted HTF confluence step in pipeline between S/R check and LTF refinement, updated reason string denominator from `/6` to `/11` |
| `supabase/functions/bot-scanner/index.ts` | Updated import to include `HTFConfluenceData`, built `htfConfluenceData` object from existing `h4OBs`, `h4FVGs`, `h4Breakers`, `htfFibLevels4H`, `htfPD4H` variables, passed it to `findBestEntryZoneMultiTF`, added `htfConfluenceScore` and `htfLayers` to scan detail output |
| `supabase/functions/_shared/impulseZoneEngine.test.ts` | Added `htfConfluenceScore: 0, htfLayers: []` to all existing `RankedPOI` object literals to satisfy updated interface |
| `supabase/functions/_shared/htfConfluence.test.ts` | **New file** — 27 tests for `checkHTFConfluence()` |

### Extra caution note: bot-scanner/index.ts

The change to `bot-scanner/index.ts` is minimal and safe:
- **Import line**: Added `type HTFConfluenceData` to the existing import from `impulseZoneEngine.ts`.
- **Call site**: Built an `htfConfluenceData` object from variables that already exist in scope (`h4OBs`, `h4FVGs`, `h4Breakers`, `htfFibLevels4H`, `htfPD4H`) with `?? []` / `?? null` null-safety. Passed it as the 6th argument to `findBestEntryZoneMultiTF`.
- **Detail output**: Added two fields (`htfConfluenceScore`, `htfLayers`) to the existing `bestZone` detail object.
- No control flow changes. No gate changes. The impulse zone engine remains informational-only.

## Tests added

| Test | Assertion |
|------|-----------|
| `empty zones returns empty array` | `checkHTFConfluence([])` returns `[]` |
| `no overlapping HTF data → score 0` | OBs/FVGs far from zone → score 0, layers empty |
| `4H OB overlaps zone → +1 score` | Bullish OB overlapping zone adds 1 point and "4H_OB" layer |
| `4H FVG overlaps zone → +1 score` | Bullish FVG overlapping zone adds 1 point and "4H_FVG" layer |
| `4H Breaker overlaps zone → +1 score` | Active bullish breaker overlapping zone adds 1 point and "4H_BREAKER" layer |
| `HTF Fib 61.8% inside zone → +1.5 score` | Premium Fib level inside zone adds 1.5 points |
| `HTF Fib 71% inside zone → +1.5 score` | Premium Fib level inside zone adds 1.5 points |
| `HTF Fib 78.6% inside zone → +1.5 score` | Premium Fib level inside zone adds 1.5 points |
| `HTF Fib 50% inside zone → +0.5 score` | Equilibrium Fib level adds only 0.5 points |
| `P/D discount for bullish → +0.5 score` | Discount zone for bullish direction adds 0.5 |
| `P/D premium for bearish → +0.5 score` | Premium zone for bearish direction adds 0.5 |
| `P/D discount for bearish → NO score` | Wrong P/D alignment adds nothing |
| `full confluence: all layers → max 5.0 score` | OB+FVG+Breaker+Fib61.8+PD = 1+1+1+1.5+0.5 = 5.0 |
| `bearish OB ignored for bullish direction` | Direction filtering works |
| `broken OB excluded` | State filtering works |
| `mitigated OB excluded` | State filtering works |
| `filled FVG excluded` | State filtering works |
| `inactive breaker excluded` | isActive filtering works |
| `broken breaker excluded` | State filtering works |
| `best Fib wins: 61.8% beats 50%` | Only best Fib score is used, not cumulative |
| `totalScore includes htfConfluenceScore` | totalScore = fibScore + htfConfluence + sr |
| `multiple zones scored independently` | Each zone gets its own score |
| `OB counts at most once` | Multiple overlapping OBs don't double-count |
| `Fib outside zone → no score` | Fib must be inside zone range |
| `bearish direction with correct layers` | Bearish OB+FVG+Breaker+PD all work |
| `daily Fib levels also checked` | `dailyFibLevels` optional field works |
| `REGRESSION — 61.8% with HTF beats naked 78.6%` | Core requirement: HTF-backed zone outranks naked deeper zone |

## Tests run

```
$ deno test supabase/functions/_shared/impulseZoneEngine.test.ts supabase/functions/_shared/htfConfluence.test.ts --allow-all
ok | 64 passed | 0 failed (134ms)

$ deno test supabase/functions/ --allow-all --no-check
ok | 505 passed | 0 failed (7s)
```

All 505 tests pass (including 37 existing impulseZoneEngine tests + 27 new htfConfluence tests).

Type-check errors: 32 (down from 43 pre-existing on the parent branch). All 32 are in other test files (`tpNextLevelSkip.test.ts`, `structureAuthority.test.ts`, `confluenceScoring.test.ts`, etc.) and are pre-existing — none introduced by this change.

## Regression check

1. **Existing impulseZoneEngine tests**: All 37 pass unchanged (after adding the required `htfConfluenceScore: 0, htfLayers: []` fields to test fixtures).
2. **Backward compatibility**: When `htfData` is not provided (the parameter is optional), `checkHTFConfluence` is never called, and all zones have `htfConfluenceScore: 0` and `htfLayers: []` — identical to previous behavior.
3. **Full suite**: All 505 tests across the entire `supabase/functions/` directory pass with `--no-check`.
4. **Score math verified**: `1+1+1+1.5+0.5 = 5.0` max HTF confluence. Maximum total: `4 + 5 + 1 + 1 = 11`.

## Open questions

1. **Daily Fib levels**: The `HTFConfluenceData` interface includes an optional `dailyFibLevels` field. The bot-scanner currently does not compute daily Fib levels, so this field is not populated. Should we add daily Fib computation in a follow-up task?

2. **Score denominator display**: The reason string now shows `/11` as the max. In practice, without HTF data the max is still 6. Should we make the denominator dynamic (show actual max based on whether HTF data was available)?

## Suggested PR title and description

**Title:** `[htf-confluence-scoring] Add HTF confluence layer scoring to impulse zone engine`

**Description:**
Adds a new scoring layer to the impulse zone engine that evaluates overlap between 1H entry zones and 4H market structure (Order Blocks, FVGs, Breaker Blocks, Fibonacci levels, Premium/Discount zones).

**What it does:**
- New `checkHTFConfluence()` function scores each candidate zone based on 5 HTF layers (max +5 points)
- Inserts between S/R check and LTF refinement in the pipeline
- Bot-scanner passes already-computed 4H analysis data through to the zone engine
- Scan detail output now includes `htfConfluenceScore` and `htfLayers` for transparency

**Why:**
A zone at 61.8% backed by a 4H OB + FVG + HTF Fib should rank higher than a naked zone at 78.6%. This change implements that ranking logic.

**Behavior changes:** Zone ranking within the impulse engine changes when HTF data is available. No gate changes. No trade execution changes. The impulse zone engine remains informational-only.

**Tests:** 27 new tests + 37 existing tests pass. Full suite: 505/505.
