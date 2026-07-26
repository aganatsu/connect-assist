# Task: Fix trend derivation in analyzeMarketStructure + regime gate for structure-invalidation
## Branch: manus/trend-from-structure-breaks

## Behavior changes

1. **`analyzeMarketStructure().trend` now derived from BOS/CHoCH breaks** instead of comparing the last 2 swing highs/lows. Priority: most recent external break → most recent break of any significance → legacy 2-swing fallback (only when zero breaks detected).

2. **New field `trendBasis: "external" | "internal" | "none"`** added to the return object. Indicates what significance level the trend was derived from. Consumers (e.g., `gamePlan.ts`'s `determineBias()`) can use this to weight HTF inputs differently.

3. **Structure-invalidation regime gate** (scannerManagement.ts): When a position was entered in a ranging/quiet/choppy regime AND the trend flip comes from an internal-only break, structure-invalidation is suppressed (logged but no SL tightening). Fail-open for unknown/missing regimes and external breaks.

4. **Snapshot delta**: The ranging fixture now produces `direction: null, score: 18.8` instead of the previous `direction: long, score: 23.1`. The old code was incorrectly producing a bullish direction signal from a ranging market with recent bearish internal structure.

5. **No change to any gate definitions, factor weights, or the SPECS table.**

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/smcAnalysis.ts` | Replaced 5-line 2-swing trend derivation with 13-line BOS/CHoCH-based derivation + trendBasis field |
| `supabase/functions/_shared/scannerManagement.ts` | Added 8-line regime gate to structure-invalidation branch (lines 810-817) |
| `supabase/functions/_shared/trendFromStructureBreaks.test.ts` | New: adversarial conflicting-signal regression test + trendBasis assertions |
| `supabase/functions/_shared/structureInvalidationOneShot.test.ts` | New: one-shot guard regression test (5 tests) |
| `supabase/functions/_shared/regimeGateMatrix.test.ts` | New: 9-cell adversarial test matrix for regime gate |
| `supabase/functions/_shared/__snapshots__/confluenceScoring.ranging.snapshot.json` | Updated snapshot reflecting new trend derivation |

## Tests added

| Test file | What it asserts |
|-----------|----------------|
| `trendFromStructureBreaks.test.ts` — "external bearish CHoCH overrides internal HH/HL pattern" | Old logic would say bullish (HH+HL verified); new logic correctly says bearish from external CHoCH. Also verifies trendBasis=external. |
| `trendFromStructureBreaks.test.ts` — "trendBasis reflects source of trend" | trendBasis=external when external break used, internal when internal-only |
| `structureInvalidationOneShot.test.ts` (5 tests) | One-shot guard: fires once, never re-fires on subsequent cycles even with continued adverse structure |
| `regimeGateMatrix.test.ts` — Cell 1: trending + internal | FIRES (trending regime overrides internal-only suppression) |
| `regimeGateMatrix.test.ts` — Cell 2: trending + external | FIRES (strongest signal, always fires) |
| `regimeGateMatrix.test.ts` — Cell 3: ranging + external | FIRES (major structural shift overrides ranging suppression) |
| `regimeGateMatrix.test.ts` — Cell 4: ranging + internal | SUPPRESSED (noise in choppy market) |
| `regimeGateMatrix.test.ts` — quiet + internal | SUPPRESSED |
| `regimeGateMatrix.test.ts` — choppy + internal | SUPPRESSED |
| `regimeGateMatrix.test.ts` — strong_trend + internal | FIRES |
| `regimeGateMatrix.test.ts` — unknown/missing regime + internal | FIRES (fail-open) |
| `regimeGateMatrix.test.ts` — quiet + external | FIRES |

## Tests run

```
$ deno test --no-check --allow-all supabase/functions/_shared/
ok | 1606 passed | 0 failed (18s)
```

## Regression check

### Trigger rate comparison (the specific before/after rate Claude asked about)

50 synthetic candle variants that produce internal bearish CHoCH, tested with regime="ranging":

| Metric | Without gate | With gate (ranging) | With gate (trending) |
|--------|-------------|--------------------|--------------------|
| Would fire | 50/50 | **0/50** | 50/50 |
| Suppressed | — | 50 (100%) | 0 (0%) |

**Interpretation**: Every internal-only CHoCH in a ranging market is suppressed. Every internal-only CHoCH in a trending market still fires. External breaks always fire regardless of regime.

### Random choppy candle test (100 scenarios)

Random oscillating candles with bearish bias at end:
- 83/100 produce `trend=bearish` (from legacy fallback or BOS, not CHoCH)
- 0/100 produce bearish CHoCH (oscillations don't create trend reversals)
- 0/100 would fire structure-invalidation (requires BOTH trend AND CHoCH)

**Key insight**: The real-world trigger rate increase from the trend fix is lower than initially feared because structure-invalidation requires CHoCH (not just trend=bearish). Random chop produces bearish BOS/trend but rarely CHoCH. The regime gate is the correct safety net for the cases that DO produce internal CHoCH in ranging conditions.

### Snapshot regression

The ranging fixture snapshot changed:
- Old: `direction: "long"`, `score: 23.1` (false signal from P/D zone fallback)
- New: `direction: null`, `score: 18.8` (correctly neutral — no strong directional signal in ranging market)

This is an improvement: the old code was generating a false long signal in a market with recent bearish internal structure.

## Open questions

1. **determineBias() weighting with trendBasis** — Agreed to defer to separate follow-up branch. `trendBasis` is now exposed and ready for that work.

2. **Entry-time regime vs current regime** — The gate uses `signalData.regimeInfo.regime` (stored at trade entry time). If a position was entered during trending but the market has since become ranging, the gate won't suppress. This is conservative (fail-open) but could be revisited if we want to re-classify regime during management.

## Suggested PR title and description

**Title:** fix(smcAnalysis): derive trend from BOS/CHoCH breaks + regime gate for structure-invalidation

**Description:**
The `trend` field in `analyzeMarketStructure()` was derived by comparing the last 2 swing highs and lows — a lagging heuristic that frequently contradicts the actual structural breaks the engine already detects.

**Changes:**
- Derive `trend` from the most recent confirmed BOS/CHoCH, with external breaks taking priority over internal ones
- Add `trendBasis: "external" | "internal" | "none"` field so consumers can weight trend differently based on break significance
- Add regime gate to structure-invalidation: suppress noise-driven SL tightening when regime is ranging/quiet/choppy AND trendBasis is internal-only
- Falls back to legacy 2-swing comparison only when no breaks are detected at all

**Safety verification:**
- 9-cell adversarial test matrix for regime gate (all 4 combinations + 5 edge cases)
- 50-variant trigger rate comparison: 100% suppression in ranging, 0% suppression in trending
- Structure-invalidation one-shot guard confirmed safe (5 dedicated tests)
- Adversarial conflicting-signal test proves the exact bug is fixed
- 1606 tests pass, 0 failures
