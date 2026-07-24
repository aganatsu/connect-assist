# Task: Backtest Score Parity
## Branch: manus/backtest-score-parity

## Behavior changes

1. **Effective score calculation now includes ICT module adjustments** — when ICT modules are enabled in a backtest config (e.g., `ictDisplacementMSSEnabled: true`, `ictJudasSwingEnabled: true`, etc.), the effective score will now be adjusted by the same penalties/bonuses the live scanner applies. This means:
   - Configs with ICT modules enabled will produce **lower scores** (more conservative) than before, as penalties for missing displacement, no Judas swing, invalidated FVGs, or being outside kill zones will now apply.
   - Configs with ICT modules disabled (the default) produce **identical results** to the previous version.

2. **Direction Verdict score adjustment now applies** — when `useConfirmedTrend` is enabled and daily candles are available, the Direction Verdict consensus engine will contribute a score adjustment (positive for strong agreement, negative for conflict).

**Net effect:** Backtests run with ICT modules enabled will now take fewer trades and show lower win rates than before (matching what the live scanner would actually do). Backtests with default configs are unchanged.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/backtest-engine/index.ts` | Added 6 new imports for ICT modules + Direction Verdict; inserted ~140 lines of ICT analysis + score adjustment logic between FOTSI penalty and effective score calculation (lines 2011-2155) |
| `supabase/functions/backtest-engine/scoreParity.test.ts` | New test file with 32 tests covering formula correctness, module integration, and backward compatibility |

## Tests added

| Test | Assertion |
|------|-----------|
| `Score Parity: base formula with all ICT modules disabled produces same result as before` | Backward compatibility — old formula still works |
| `Score Parity: direction verdict replaces HTF score adjustment` | When verdict present, HTF adj = 0 |
| `Score Parity: HTF score adjustment applies when no direction verdict` | HTF penalty applies when no verdict |
| `Score Parity: MSS soft penalty applies when isValid=false` | -2.0 penalty for invalid MSS |
| `Score Parity: MSS penalty does NOT apply when isValid=true` | No penalty for valid MSS |
| `Score Parity: MSS penalty does NOT apply when gateMode != soft` | Hard/off modes don't penalize |
| `Score Parity: Judas soft penalty applies when found=false` | -1.5 penalty for no Judas |
| `Score Parity: Judas penalty does NOT apply when found=true` | No penalty when found |
| `Score Parity: FVG invalidation penalty is weighted average` | Correct weighted formula |
| `Score Parity: FVG penalty does NOT apply when totalCount=0` | No penalty with no FVGs |
| `Score Parity: Kill Zone prime bonus applies when in prime KZ` | +1.5 bonus in prime KZ |
| `Score Parity: Kill Zone non-prime gives zero adjustment` | No bonus for non-prime KZ |
| `Score Parity: Kill Zone outside penalty applies when not in KZ` | -1.0 penalty outside KZ |
| `Score Parity: all adjustments combine correctly` | Full combination test |
| `Direction Verdict: bullish consensus produces positive scoreAdjustment` | Module integration |
| `Direction Verdict: conflicting signals reduce confidence` | Conflict handling |
| `Direction Verdict: null inputs produce neutral verdict` | Graceful null handling |
| `ICT Kill Zone: London open (08:00 UTC) is a kill zone` | Time window detection |
| `ICT Kill Zone: NY open (13:00 UTC) is a kill zone` | Time window detection |
| `ICT Kill Zone: disabled config returns passed=true` | Disabled behavior |
| `ICT MSS: no breaks returns isValid=true` | Edge case handling |
| `ICT MSS: disabled config returns isValid=true` | Disabled behavior |
| `ICT Judas: disabled config returns passed=true` | Disabled behavior |
| `ICT Judas: mssIndex out of range returns not found gracefully` | Edge case handling |
| `ICT FVG: empty FVG list returns empty results` | Edge case handling |
| `ICT FVG: disabled config returns empty results` | Disabled behavior |
| `ICT FVG: valid FVG returns non-empty results with status` | Module integration |
| `ICT HTF: disabled config returns passed=true with zero adjustment` | Disabled behavior |
| `ICT HTF: null weekly candles does not crash` | Backtest scenario (no weekly data) |
| `Regression: when all ICT configs are off/default, score equals old formula` | 5 test cases proving backward compat |
| `Regression: hard gate modes produce zero adjustment` | Hard gates don't penalize score |
| `Regression: off gate modes produce zero adjustment` | Off gates don't penalize score |

## Tests run

```
$ deno test --no-check --allow-all supabase/functions/backtest-engine/scoreParity.test.ts
running 32 tests from ./supabase/functions/backtest-engine/scoreParity.test.ts
ok | 32 passed | 0 failed (15ms)

$ deno test --no-check --allow-all supabase/functions/backtest-engine/determinism.test.ts
running 31 tests from ./supabase/functions/backtest-engine/determinism.test.ts
ok | 31 passed | 0 failed (16ms)
```

## Regression check

1. **Backward compatibility proven by test:** The `Regression: when all ICT configs are off/default, score equals old formula` test runs 5 different input combinations and proves the new formula produces identical results to the old formula when ICT modules are not enabled.

2. **Hard/off gate modes produce zero adjustment:** Two dedicated tests prove that when gate modes are "hard" or "off", the score adjustments are always 0 — meaning existing configs that don't use ICT soft gates are completely unaffected.

3. **No new TypeScript errors introduced:** `deno check` shows all errors are pre-existing (lines 1406, 1432, 1460, 1461, 1671, 1780-1782 — none in our new code at lines 2011-2155).

4. **Existing determinism tests still pass:** All 31 pre-existing tests pass unchanged.

## Open questions

1. **Bot-scanner field name mismatches:** The live scanner accesses `ictMSSResult.valid`, `ictJudasResult.detected`, and `ictKZResult.inKillZone` — but the shared modules define these as `isValid`, `found`, and `isKillZone` respectively. The backtest uses the correct shared module field names. This means the live scanner likely has TS errors it ignores at runtime (accessing undefined fields → always undefined → penalties never fire in live). Should we fix the scanner too?

2. **Weekly candles not available in backtest:** The Direction Verdict and ICT HTF modules pass `null` for weekly candles/bias. This is a known partial-parity gap. Adding weekly candle fetching to the backtest would be a separate task.

3. **Game plan bias not available in backtest:** The Direction Verdict passes `null` for game plan bias. This is intentional — game plans are live-only context.

## Suggested PR title and description

**Title:** `[A1] Backtest Score Parity: Add 5 missing ICT score components`

**Description:**
Ports the 5 missing ICT score components from the live bot-scanner to the backtest engine, closing the effective score formula gap identified in the backtest audit.

**What changed:**
- Direction Verdict consensus engine now contributes `verdictScoreAdj`
- ICT HTF Analysis contributes `ictHTFScoreAdj` (when no verdict)
- ICT Displacement MSS contributes penalty when MSS lacks displacement (soft mode)
- ICT Judas Swing contributes penalty when no sweep found (soft mode)
- ICT FVG Invalidation contributes weighted penalty for invalidated/exhausted FVGs (soft mode)
- ICT Kill Zone contributes bonus/penalty based on entry timing (soft mode)

**Backward compatible:** When ICT modules are disabled (default), the formula reduces to the previous `rawScore + fotsiPenalty + izPenalty`. Proven by 5 regression test cases.

**32 new tests** covering formula correctness, module integration, edge cases, and backward compatibility.
