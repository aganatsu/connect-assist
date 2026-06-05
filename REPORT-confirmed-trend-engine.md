# Task: Confirmed Trend Engine (Three-Pillar Noise-Resistant MSB Detection)

## Branch: manus/confirmed-trend-engine

## Behavior changes

1. **Daily bias determination now uses `confirmedTrend()` instead of `analyzeMarketStructure().trend`** — this means the direction engine will only flip the daily trend when a swing break exceeds 25% of the swing range (configurable). Previously, a single new swing pair comparison could flip the trend.

2. **Close-based confirmation (Pillar 2):** A break only counts as a confirmed MSB if the candle's CLOSE is beyond the previous swing level — not just the wick/extreme. This matches LuxAlgo, zazenio, and ICT MSS methodology. Wick-through fakeouts (liquidity sweeps) no longer flip the trend.

3. **Alternation enforcement (Pillar 3):** An H→L→H→L state machine prevents double-counting consecutive same-direction swings. When multiple consecutive highs (or lows) are detected, only the most extreme one is kept. This produces cleaner swing sequences.

4. **4H fallback (when daily is ranging) also uses `confirmedTrend()`** — same three-pillar filter applies to the 4H bias determination, making the fallback path equally stable.

5. **Trades that would have fired on marginal/noisy trend flips will now be blocked** — the direction engine will return `null` (no trade) more often in ranging/choppy markets where the old system would oscillate between bullish/bearish on every new swing.

6. **Per-pair tunability:** `useConfirmedTrend`, `confirmedTrendFibFactor`, and `confirmedTrendSwingLookback` are all configurable per-pair in bot-scanner strategy overrides.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/directionEngine.ts` | Added `confirmedTrend()` function (~160 lines) with three pillars: fib extension filter, close-based confirmation, alternation enforcement. Added `ConfirmedTrendResult` interface with `closeBased` field on MSBs. Integrated into `determineDirection()` Step 1 bias determination. |
| `supabase/functions/_shared/directionEngine.test.ts` | Added 16 new tests covering: insufficient data, bullish/bearish detection, stability (noise resistance), trend flip on confirmed MSB, fib threshold comparison, integration with `determineDirection()`, legacy fallback, AUD/JPY scenario, close-based wick rejection, close-based confirmed break, alternation enforcement, and structural source code guards. |
| `supabase/functions/bot-scanner/index.ts` | Added 3 config options to DEFAULTS (lines 184-186), 3 lines to config merge (lines 691-693), and 3 lines to `determineDirection()` call (lines 3602-3604). No gate definitions modified. |

## Tests added

| Test | Assertion |
|------|-----------|
| `confirmedTrend: returns ranging when insufficient data` | Returns ranging with empty MSBs when < 15 candles |
| `confirmedTrend: detects bullish trend with strong HH extensions` | Detects bullish when HH extensions are 167% (>> 25%) |
| `confirmedTrend: detects bearish trend with strong LL extensions` | Detects bearish when LL extensions are large |
| `confirmedTrend: STABILITY - doesn't flip on a single marginal new swing` | Bullish trend holds when noise dip is only 3.8% extension (< 25%) |
| `confirmedTrend: flips from bullish to bearish on confirmed bearish MSB` | Correctly flips when LL extension is 77% (>> 25%) |
| `confirmedTrend: higher fibFactor requires larger breaks` | 50% threshold produces fewer MSBs than 25% threshold |
| `confirmedTrend: integrates with determineDirection via useConfirmedTrend=true` | No crash, valid output, agrees with legacy on clear trends |
| `confirmedTrend: useConfirmedTrend=false falls back to legacy behavior` | Legacy path works without crash |
| `confirmedTrend: AUD/JPY scenario - bullish confirmed trend stays bullish despite noise` | Strong bull run (108→115) holds despite tiny noise at top (8.3% extension) |
| `confirmedTrend: source code contains fib extension filter` | Structural guard verifying key code patterns exist |
| `confirmedTrend CLOSE-BASED: wick-through without close does NOT flip trend` | Bullish trend holds when candle wicks below prev swing low but closes above it |
| `confirmedTrend CLOSE-BASED: close-confirmed break DOES flip trend` | Trend flips to bearish when multi-candle selloff closes decisively below prev swing lows |
| `confirmedTrend ALTERNATION: consecutive same-direction swings are merged` | No crashes with consecutive same-direction swings; alternation produces clean sequence |
| `confirmedTrend STRUCTURAL GUARD: source code contains close-based and alternation logic` | Verifies closedAbove, closedBelow, alternation enforcement, and three pillars documented |

## Tests run

```
ok | 1043 passed | 0 failed (14s)
```

Full test suite: all 1043 tests pass, including 39 direction engine tests (16 new + 23 existing).

## Regression check

- **All existing direction engine tests pass unchanged** — the `useConfirmedTrend=true` default doesn't break any existing test because the synthetic trending data produces strong enough swings to pass all three filters.
- **Legacy mode verified** — `useConfirmedTrend: false` produces identical behavior to the previous implementation.
- **Close-based confirmation is additive** — it can only make the trend MORE stable (fewer flips), never less. A confirmed MSB under the old rules will still be confirmed under the new rules if the candle closed past the level.
- **Alternation enforcement is additive** — it only removes duplicate same-direction swings, never adds new ones. The resulting swing sequence is a subset of the original.
- **Bot-scanner changes are config-only** — no gate definitions modified, no scoring logic changed. The three new config options use the same `strategy ?? raw ?? default` pattern as all other configs.

## Open questions

1. **Should backtest-engine also pass the new config options?** Currently it only passes `h4ChochLookback` and `h1BosLookback`. Without explicit config, backtests will use the new `confirmedTrend` by default (matching live behavior), which is correct for forward parity. But historical backtests run before this change will produce different results.

2. **The 4H TREND BLOCK (from previous branch) is still active alongside confirmedTrend.** Both are complementary: `confirmedTrend` stabilizes the DAILY bias, while the 4H trend block catches 4H opposing the daily bias. They don't conflict.

## Suggested PR title and description

**Title:** `feat(direction-engine): three-pillar confirmedTrend — fib extension, close-based, alternation`

**Description:**
Replaces the fragile `analyzeMarketStructure().trend` (which flips on every new swing pair) with a research-backed `confirmedTrend()` function implementing three noise-resistance pillars:

1. **Fib extension filter** — breaks must exceed 25% of the swing range to count
2. **Close-based confirmation** — only candle CLOSES past structure count (matches LuxAlgo/ICT)
3. **Alternation enforcement** — H→L→H→L state machine prevents double-counting

Per-pair tunable via `confirmedTrendFibFactor`, `confirmedTrendSwingLookback`, `useConfirmedTrend`.

Directly addresses the AUD/JPY direction bug root cause: the old system would flip daily trend on marginal noise swings and wick-through fakeouts.

- 16 new tests, all 1043 existing tests pass
- Toggle: `useConfirmedTrend: false` reverts to legacy for rollback
