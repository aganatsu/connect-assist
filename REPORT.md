# Task: fix-gate6-heat-quotetousd

## Branch: manus/fix-gate6-heat-quotetousd

## Behavior changes

1. **Gate 6 portfolio heat now converts each position's risk to USD before summing.** Previously, risk was computed in the quote currency of each pair and then divided by the USD-denominated balance. This inflated heat for JPY-quoted pairs by ~142x and deflated it for GBP-quoted pairs by ~0.79x. After the fix, all risk amounts are in USD.

2. **Concrete impact on gate pass/fail:**
   - A single CAD/JPY position with 30-pip SL and 0.5 lots on a $10,000 account previously showed **150% heat** (gate blocked). It now correctly shows **~1.06% heat** (gate passes).
   - A single USD/CHF position with 30-pip SL and 0.5 lots previously showed **1.5% heat**. It now correctly shows **~1.70% heat** (modest increase, gate still passes).
   - USD-quoted pairs (EUR/USD, GBP/USD, etc.) are unchanged — quoteToUSD = 1.0.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added `getQuoteToUSDRate(p.symbol, rateMap)` call inside Gate 6 loop (line 966) and multiplied `riskPerUnit` by `quoteToUSD` (line 967). One line added, one line changed. |
| `supabase/functions/bot-scanner/gate6Heat.test.ts` | New test file: 6 tests covering structural verification, 4 quote-currency categories, and the fallback branch. |
| `REPORT.md` | This file. |

## Extra-caution file explanation: bot-scanner/index.ts

The change is a **two-line edit** inside the Gate 6 portfolio heat loop (lines 964–968). The existing line:

```ts
const riskPerUnit = Math.abs(pEntry - pSL) * spec.lotUnits * pSize;
```

was replaced with:

```ts
const quoteToUSD = getQuoteToUSDRate(p.symbol, rateMap);
const riskPerUnit = Math.abs(pEntry - pSL) * spec.lotUnits * pSize * quoteToUSD;
```

`getQuoteToUSDRate` is the same function already used at line 621 (position sizing), line 1017 (Gate 8 cost-adjusted RR), and line 2084 (PnL conversion). The `rateMap` parameter is already passed to `runSafetyGates` at line 892 and supplied at the call site (line 3210). No new imports, no new functions, no signature changes.

The fallback branch (line 970–971: `balance * (riskPerTrade / 100)`) was not changed because it already computes in USD (balance is USD, riskPerTrade is a percentage).

## Tests added

| Test | Asserts |
|------|---------|
| `Gate 6 source contains quoteToUSD conversion` | Structural: the fix exists in the source code (regex match for `getQuoteToUSDRate(p.symbol, rateMap)` inside Gate 6 block) |
| `Test 1: EUR/USD (USD-quoted)` | Heat = 1.5% for both old and new code (quoteToUSD = 1.0, no change) |
| `Test 2: CAD/JPY (JPY-quoted)` | Fixed heat = 1.056%, old heat = 150.0% (inflation ratio ~142x confirmed) |
| `Test 3: USD/CHF (CHF-quoted)` | Fixed heat = 1.705%, old heat = 1.5% (old/new ratio = 0.88, the USD/CHF rate) |
| `Test 4: Mixed EUR/USD + CAD/JPY` | Total heat = sum of individual heats (2.556%), old code produced >150% |
| `Test 5: Missing SL fallback` | Both old and new produce 1.0% (fallback branch is already in USD) |

## Tests run

```
$ deno test --allow-all --no-check supabase/functions/
ok | 223 passed | 0 failed (5s)
```

6 new tests + 217 existing tests, all passing.

## Regression check

### Hand-computed math (side-by-side)

**CAD/JPY: entry 110.00, SL 110.30, size 0.5, balance $10,000**

| Step | Old (buggy) | New (fixed) |
|------|-------------|-------------|
| SL distance | 0.30 | 0.30 |
| x lotUnits | x 100,000 | x 100,000 |
| x size | x 0.5 | x 0.5 |
| x quoteToUSD | (missing) | x 1/142 = 0.00704 |
| riskPerUnit | 15,000 (JPY) | $105.63 |
| / balance | / $10,000 | / $10,000 |
| **heat** | **150.0%** (wrong) | **1.056%** (correct) |

**EUR/USD: entry 1.0850, SL 1.0820, size 0.5, balance $10,000**

| Step | Old | New |
|------|-----|-----|
| SL distance | 0.0030 | 0.0030 |
| x lotUnits | x 100,000 | x 100,000 |
| x size | x 0.5 | x 0.5 |
| x quoteToUSD | (missing, but = 1.0) | x 1.0 |
| riskPerUnit | $150.00 | $150.00 |
| **heat** | **1.5%** (correct) | **1.5%** (correct) |

USD-quoted pairs are unchanged. JPY-quoted pairs drop from ~143x inflation to correct values. CHF/CAD/GBP/AUD/NZD-quoted pairs receive modest corrections proportional to their exchange rate.

## Open questions

None. The fix is minimal, well-scoped, and verified by hand computation. The `getQuoteToUSDRate` function and `rateMap` were already in scope — this was a missing multiplication.

## Suggested PR title and description

**Title:** fix(gate6): convert portfolio heat risk to USD via quoteToUSD

**Description:**

Gate 6 (portfolio heat) computed each position's risk as `|entry - SL| x lotUnits x size` and divided by the USD balance. For non-USD-quoted pairs, this produced risk in the quote currency (JPY, CHF, etc.) instead of USD, inflating JPY heat by ~142x and distorting CHF/CAD/GBP heat by their respective exchange rates.

**Fix:** multiply `riskPerUnit` by `getQuoteToUSDRate(p.symbol, rateMap)` — the same conversion already used by position sizing (line 621) and cost-adjusted RR (line 1017).

**Impact:** JPY-cross positions that previously showed 100%+ heat now show their true ~1% risk. USD-quoted pairs are unchanged. 6 new tests with hand-computed expected values. Full suite: 223 passed, 0 failed.
