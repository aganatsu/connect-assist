# Task: Derive trend from BOS/CHoCH breaks instead of 2-swing comparison
## Branch: manus/trend-from-structure-breaks

## Behavior changes

1. **`analyzeMarketStructure().trend` now reflects the most recent confirmed structural break** rather than a standalone comparison of the last 2 swing highs/lows.
   - Priority: external (major) breaks override internal (minor) ones.
   - Fallback: if no external break exists, the most recent break of any significance decides.
   - If no BOS/CHoCH is detected at all, the legacy 2-swing comparison is used (backward compat).

2. **Ranging fixture snapshot updated.** The synthetic "ranging" candle series used in the confluenceScoring snapshot test now correctly produces `direction: null, bias: neutral, score: 18.8` instead of the old `direction: long, bias: bullish, score: 23.1`. This is because:
   - Old code: trend = "ranging" (2-swing comparison on oscillating candles) → direction logic fell through to P/D zone → discount → long.
   - New code: trend = "bearish" (last internal CHoCH at idx 194 is bearish) → direction logic takes bearish path → but no daily confirmation → direction = null.
   - **Net effect on live trading:** In ranging markets with alternating internal breaks, the engine will now correctly identify the last structural event rather than defaulting to "ranging." This makes the direction engine more responsive to recent structure changes and less likely to take counter-trend trades in oscillating markets.

3. **No change to any gate definitions, factor weights, or the SPECS table.** The fix is purely in the trend derivation logic within `analyzeMarketStructure()`.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/smcAnalysis.ts` | Replaced 2-swing trend derivation (lines 1065-1084) with BOS/CHoCH-based derivation using external-first priority, with legacy fallback when no breaks exist |
| `supabase/functions/_shared/trendFromStructureBreaks.test.ts` | New regression test file (5 tests) proving the fix works correctly |
| `supabase/functions/_shared/__snapshots__/confluenceScoring.ranging.snapshot.json` | Updated snapshot to reflect new behavior (direction: null instead of long) |

## Tests added

| Test | What it asserts |
|------|-----------------|
| `external bearish CHoCH overrides internal HH/HL pattern` | Constructs candles where old logic says "bullish" (HH+HL) but last external break is bearish CHoCH → trend = "bearish" |
| `pure bullish BOS chain → trend = bullish` | Continuous uptrend with bullish BOS → trend correctly = "bullish" |
| `no BOS/CHoCH detected → trend = ranging` | Flat candles with no structure → legacy fallback → "ranging" |
| `always returns valid trend type` | Output is always one of bullish/bearish/ranging |
| `bearish BOS chain → trend = bearish` | Continuous downtrend with bearish BOS → trend correctly = "bearish" |

## Tests run

```
$ deno test --no-check --allow-all supabase/functions/_shared/
ok | 1592 passed | 0 failed (17s)
```

All 1592 tests pass, including:
- 5 new trend derivation tests
- 74 downstream direction engine / structure authority tests
- 47 daily POI / chart overlay tests
- 61 SMC enhancements / config mapper tests
- 1 updated ranging snapshot test

## Regression check

1. **Downstream direction engine tests (74 tests):** All pass unchanged. The `structureAuthority.test.ts` "Ranging market with daily bearish BOS → direction short" test passes because the daily candles in that fixture produce no BOS/CHoCH (too smooth), so the legacy fallback activates and produces "ranging" — same as before.

2. **Confluence scoring snapshot:** The ranging fixture's snapshot changed intentionally. Old: `direction=long, score=23.1`. New: `direction=null, score=18.8`. This is correct — the fixture has a bearish CHoCH at the end (idx 194), so the new code correctly identifies bearish structure, which causes the direction engine to NOT produce a long signal in a bearish-trending market. This is the exact bug the fix addresses: the old code was saying "ranging" when the last structural event was bearish, causing false long entries.

3. **No changes to gate definitions or factor weights.** The fix only changes how `trend` is derived; all downstream consumers that read `trend` continue to work correctly.

## Open questions

1. **Internal-only markets:** In markets with ONLY internal breaks (no external), the last internal break now determines trend. In the ranging fixture, this produces "bearish" from the last internal CHoCH. Is this the desired behavior, or should internal-only markets always produce "ranging"? Current implementation: internal breaks DO determine trend when no external breaks exist. This matches the task spec ("use lastExternalBreak ?? lastAnyBreak").

2. **Cascade effects on live trading:** The change means that in oscillating markets, the trend will flip more frequently (following each internal CHoCH). This is more responsive but potentially noisier. The direction engine's `hasDailyBOS` guard (line 572 of confluenceScoring.ts) already protects against this for the HTF tiebreaker path — it requires actual BOS evidence before trusting the daily trend. However, the entry-TF trend is now more volatile in ranging conditions.

## Suggested PR title and description

**Title:** fix(smcAnalysis): derive trend from confirmed BOS/CHoCH breaks, not 2-swing comparison

**Description:**
The `trend` field in `analyzeMarketStructure()` was derived by comparing the last 2 swing highs and lows — a lagging heuristic that frequently contradicts the actual structural breaks the engine already detects. This caused the direction engine to take counter-trend trades when the last confirmed break was bearish but the 2-swing comparison still showed HH+HL.

**Fix:** Derive `trend` from the most recent confirmed BOS/CHoCH, with external (major) breaks taking priority over internal (minor) ones. Falls back to the legacy 2-swing comparison only when no breaks are detected at all.

**Impact:** In ranging markets with alternating internal breaks, the engine now correctly identifies the last structural event. This makes direction determination more responsive and prevents false signals from the lagging 2-swing heuristic. The ranging fixture snapshot was updated to reflect the corrected behavior (direction=null instead of false long).

**Tests:** 5 new regression tests + all 1592 existing tests pass.
