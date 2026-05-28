# Task: Source-of-Truth Fixes (Workstream B) + ATR Floor + Test Fix
## Branch: manus/source-of-truth-fixes
## Behavior changes

1. **Paper-trading now enforces a two-layer SL floor** — when a paper trade is placed with a stop-loss tighter than the effective minimum, the SL is automatically widened and TP recalculated to preserve the original R:R ratio. The effective minimum is `max(staticMinSlPips, atrFloorPips)` where:
   - Layer 1 (static): `MIN_SL_PIPS[symbol]` (e.g., 10 pips for EUR/USD)
   - Layer 2 (dynamic): `ATR(14) × ATR_SL_FLOOR_MULTIPLIER / pipSize` — adapts to current volatility by fetching 15-minute candles from TwelveData at order time. Falls back to static-only if ATR data is unavailable.

2. **getQuoteToUSDRate now uses FALLBACK_RATES instead of returning 1.0** — when no live rate is available, the function uses approximate fallback rates (e.g., USD/JPY ≈ 142) instead of blindly returning 1.0. This produces more accurate PnL calculations and position sizing when live rates are temporarily unavailable.

3. **7 new forex cross pairs are now tradeable** in paper-trading and visible in the frontend: AUD/CHF, AUD/NZD, CAD/CHF, CHF/JPY, NZD/CAD, NZD/CHF, NZD/JPY.

4. **bidirectionalScoring test is now deterministic** — previously failed when run outside London trading hours. Now pinned to a fixed London KZ timestamp.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/smcAnalysis.ts` | Added `export const MIN_SL_PIPS`, `export const ATR_SL_FLOOR_MULTIPLIER`, and `export function normalizeSymKey()` |
| `supabase/functions/_shared/calcPnl.test.ts` | Updated 5 edge-case tests to reflect new FALLBACK_RATES behavior |
| `supabase/functions/_shared/sourceOfTruth.test.ts` | **NEW** — 17 tests verifying all shared exports |
| `supabase/functions/_shared/bidirectionalScoring.test.ts` | Fixed time-dependent test by pinning `atMs` to London KZ timestamp |
| `supabase/functions/bot-scanner/index.ts` | Removed ~112 lines of local duplicates; now imports from shared |
| `supabase/functions/broker-execute/index.ts` | Replaced local `normalizeKey` with import from shared |
| `supabase/functions/zone-confirmation-scanner/index.ts` | Replaced local `normalizeSymKey` with import from shared |
| `supabase/functions/paper-trading/index.ts` | Added two-layer SL floor (static + ATR), `fetchATR()` helper, 7 missing pairs |
| `src/lib/marketData.ts` | Added 7 missing cross pairs to frontend INSTRUMENTS array |
| `src/components/BrokerTradesTab.tsx` | Removed local `formatPrice`/`getDigits`; uses shared `formatPrice` with symbol arg |
| `src/components/ExpandedPositionCard.tsx` | Removed local `formatPrice`; now imports from `@/lib/formatTime` |
| `src/components/GamePlanPanel.tsx` | Removed local `formatPrice`; now imports from `@/lib/formatTime` |
| `src/components/TradeDetailCard.tsx` | Removed local `formatPrice` and `getDigits`; now imports from `@/lib/formatTime` |

## Extra caution file explanations

### bot-scanner/index.ts
Removed 112 lines of locally-defined helper functions (FALLBACK_RATES, getQuoteToUSDRate, calculatePositionSize, normalizeSymKey) that were byte-for-byte duplicates of the shared module. Replaced with imports. The `resolveSymbol` function remains local (it's scanner-specific) but now calls the imported `normalizeSymKey`. No logic changes — pure import consolidation.

### broker-execute/index.ts
Replaced the local `normalizeKey` function with `const normalizeKey = normalizeSymKey` where `normalizeSymKey` is imported from shared. The implementation is identical (same regex, same behavior). Using an alias preserves all existing call sites without modification.

### paper-trading/index.ts
Three changes:
1. **Two-layer SL floor** (place_order handler): After computing SL/TP from the request, fetches ATR(14) from TwelveData 15-minute candles. Computes `effectiveMinSlPips = max(staticMinSlPips, atrFloorPips)`. If the SL distance is below this floor, widens the SL and recalculates TP to preserve the original R:R ratio. Logs which floor layer was binding (static or ATR). Gracefully degrades to static-only if ATR fetch fails.
2. **fetchATR() helper**: New async function that fetches 20 × 15-minute candles from TwelveData and computes ATR(14) using the shared `calculateATR` function. Returns 0 on any failure.
3. **7 new pairs**: Added AUD/CHF, AUD/NZD, CAD/CHF, CHF/JPY, NZD/CAD, NZD/CHF, NZD/JPY to the local SPECS and TWELVE_DATA_SYMBOLS arrays.

## Tests added

| Test file | Tests | What they assert |
|-----------|-------|-----------------|
| `sourceOfTruth.test.ts` | 7 normalizeSymKey tests | Correct normalization of various symbol formats |
| `sourceOfTruth.test.ts` | 3 MIN_SL_PIPS tests | EUR/USD, XAU/USD, USD/JPY have sane floor values |
| `sourceOfTruth.test.ts` | 1 ATR_SL_FLOOR_MULTIPLIER test | Is a positive number ≤ 5 |
| `sourceOfTruth.test.ts` | 2 FALLBACK_RATES tests | Contains USD/JPY > 100, GBP/USD > 1.0 |
| `sourceOfTruth.test.ts` | 1 calculatePositionSize test | Returns valid lot size for EUR/USD with 20-pip SL on $10k account |
| `sourceOfTruth.test.ts` | 2 getQuoteToUSDRate tests | EUR/USD → 1.0, USD/JPY → 1/rate |
| `sourceOfTruth.test.ts` | 1 SPECS test | All 7 new pairs exist with valid pipSize and lotUnits |
| `bidirectionalScoring.test.ts` | (fix) | All 15 tests now pass deterministically regardless of time-of-day |

## Tests run

```
ok | 913 passed | 0 failed (15s)
```

All 913 tests pass, including the previously-failing bidirectionalScoring regression test.

## Regression check

1. **bot-scanner**: Removed local functions were byte-for-byte identical to shared versions. Import consolidation only. Verified by full test suite.

2. **getQuoteToUSDRate fallback behavior**: Updated 5 tests in `calcPnl.test.ts` to document the new FALLBACK_RATES behavior. Old tests asserted `quoteToUSD = 1.0` when no rate was available — that was the bug. New tests assert correct fallback values.

3. **normalizeSymKey**: All three files used identical regex implementations. Shared version is the same regex. Full test suite passes.

4. **formatPrice consolidation**: Canonical `formatPrice` in `@/lib/formatTime` handles all cases via symbol-based digit resolution. Produces equivalent or better results than the local duplicates.

5. **Paper-trading SL floor**: Only affects trades where the SL was below the minimum — previously these would have been placed with dangerously tight stops. Now they're widened. Safety improvement, not regression.

6. **bidirectionalScoring test fix**: The test was non-deterministic (depended on wall-clock time). Pinning `atMs` to a London KZ timestamp makes it deterministic. The test logic and assertions are unchanged — only the timing input is now fixed.

## Open questions

1. **TwelveData API rate limits** — the `fetchATR()` call in paper-trading adds one extra API call per order placement. Given paper-trading volume is low (a few trades per day), this should be well within limits. However, if TwelveData rate-limits become an issue, we could cache ATR values per symbol for 15 minutes.

2. **BrokerTradesTab formatPrice signature** — all call sites have been updated from `formatPrice(price, digits)` to `formatPrice(price, symbol)`. The shared function derives digits from the symbol string. Verified visually equivalent output.

## Suggested PR title and description

**Title:** `fix: consolidate source-of-truth duplicates + add ATR-based SL floor to paper-trading`

**Description:**
Fixes critical source-of-truth issues and adds dynamic SL protection:

- **B1**: Remove 112 lines of duplicated helpers from bot-scanner → import from `_shared/smcAnalysis.ts`
- **B2**: Add two-layer SL floor to paper-trading (static MIN_SL_PIPS + dynamic ATR-based floor)
- **B3**: Add 7 missing forex cross pairs to paper-trading and frontend
- **B4**: Consolidate 4 duplicate `formatPrice` implementations into single shared import
- **B5**: Extract `normalizeSymKey()` to shared module; remove duplicates
- **Fix**: bidirectionalScoring test was time-dependent (failed outside trading hours); now deterministic

**Behavior change**: Paper trades with too-tight SLs are now automatically widened using `max(staticFloor, ATR×multiplier)`. `getQuoteToUSDRate` uses approximate fallback rates instead of returning 1.0. 7 new cross pairs are now tradeable.

913 tests pass. 0 failures.
