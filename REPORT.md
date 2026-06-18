# Task: Per-Pair Gate Overrides
## Branch: manus/pair-gate-overrides
## Behavior changes
1. **New capability**: Users can now configure per-pair gate overrides in their `config_json` under a new top-level `pairGateOverrides` field. When a symbol has an entry, those gate thresholds override the global config for that symbol only.
2. **No existing behavior changes**: If `pairGateOverrides` is empty or absent (the default), all behavior is identical to the previous version. No trades are affected until overrides are explicitly configured.

## Files modified
- `supabase/functions/_shared/configMapper.ts` — Added `PairGateOverride` interface, `pairGateOverrides` field to `RUNTIME_DEFAULTS`, mapping in `mapNestedToFlat()`, and exported `applyPairOverrides()` helper function.
- `supabase/functions/bot-scanner/index.ts` — Added import of `applyPairOverrides` and one-line call at line 3612 after `pairConfig` clone (before gates run). **This does NOT modify any gate definition** — it only changes the config values that feed into existing gates.
- `supabase/functions/backtest-engine/index.ts` — Same pattern: import + one-line call at pairConfig clone point so backtests respect per-pair overrides.
- `supabase/functions/bot-config/index.ts` — Added validation for `pairGateOverrides` in `validateConfig()` with bounds checking for all overridable fields.
- `supabase/functions/_shared/pairGateOverrides.test.ts` — 13 new tests covering all override scenarios.

## Tests added
1. `no overrides configured → config unchanged` — proves empty overrides is a no-op
2. `overrides minRiskReward for EUR/JPY only` — proves single-field override works
3. `non-targeted pair retains global values` — proves non-configured pairs are unaffected
4. `multiple fields overridden for one pair` — proves all 5 overridable fields apply
5. `partial override leaves other fields at global` — proves partial is truly partial
6. `mapNestedToFlat: pairGateOverrides passed through from raw config` — proves persistence layer works
7. `mapNestedToFlat: missing pairGateOverrides → empty object` — proves backward compat
8. `protectionMaxDailyLossDollar and maxConsecutiveLosses` — proves protection gates override
9. `regression: empty overrides = pure RUNTIME_DEFAULTS behavior` — regression guard
10. `returns same config reference (mutation, not copy)` — proves no unnecessary allocations
11. `different pairs get different override values` — proves multi-pair isolation
12. `value of 0 is applied (not skipped as falsy)` — edge case: zero is valid
13. `allowSameDirectionStacking=false is applied` — edge case: false is valid

## Tests run
```
$ deno test --no-check --allow-all supabase/functions/_shared/pairGateOverrides.test.ts
ok | 13 passed | 0 failed (50ms)

$ deno test --no-check --allow-all supabase/functions/_shared/configMapper.test.ts
ok | 51 passed | 0 failed (46ms)

$ deno test --no-check --allow-all supabase/functions/_shared/
ok | 1239 passed | 0 failed (16s)
```

Note: One pre-existing flaky test in `zoneLiquidity.test.ts` ("returns empty result when no pools provided") intermittently fails due to test ordering/state leakage. This is NOT caused by our changes — confirmed by running the same test on the unmodified branch (passes in isolation, fails when run after certain other tests in the suite). The `zoneLiquidity.ts` source file has zero modifications.

## Regression check
- `mapNestedToFlat` with no `pairGateOverrides` field produces identical output to before (Test 7, 9)
- `applyPairOverrides` on a non-configured symbol is a no-op (Test 1, 3)
- All 51 existing configMapper tests pass unchanged
- All 1239 shared module tests pass (excluding the pre-existing flaky test)
- The `applyPairOverrides` function uses `!== undefined` checks, so `0` and `false` are correctly applied (Tests 12, 13)

## Open questions
1. **UI integration**: The `pairGateOverrides` field needs a UI in the Lovable dashboard (Settings → Per-Pair Overrides section). Should I build that next?
2. **Recommended initial overrides**: Based on the rejected setups analysis, here are the data-driven overrides I recommend configuring immediately:

```json
{
  "pairGateOverrides": {
    "EUR/JPY": { "minTier1Factors": 1, "allowSameDirectionStacking": true, "maxPerSymbol": 2, "minRiskReward": 0.8 },
    "GBP/USD": { "protectionMaxDailyLossDollar": 5000, "maxConsecutiveLosses": 8 },
    "USD/CAD": { "minTier1Factors": 2 },
    "USD/CHF": { "minRiskReward": 0.8 },
    "NZD/CHF": { "minRiskReward": 0.8 },
    "XAU/USD": { "minConfluence": 35 },
    "BTC/USD": { "minTier1Factors": 4, "allowSameDirectionStacking": false, "maxPerSymbol": 1 }
  }
}
```

3. **The flaky zoneLiquidity test**: This is a pre-existing issue unrelated to this PR. It appears to be a test isolation problem where shared state from earlier tests leaks. Should I fix it in a separate branch?

## Suggested PR title and description

**Title:** feat: per-pair gate overrides — allow symbol-specific gate thresholds

**Description:**
Adds a `pairGateOverrides` config field that allows per-symbol overrides for key gate thresholds (R:R, Tier 1, stacking, max per symbol, confluence, daily P&L, consecutive losses).

**Motivation:** Rejected setups analysis showed that one-size-fits-all gate settings cost ~1,400 pips/week on profitable pairs (EUR/JPY 76% WR, GBP/USD 77% WR blocked) while correctly protecting on losers (BTC/USD 12.5% WR blocked). Per-pair overrides let us tune each symbol independently.

**Changes:**
- `configMapper.ts`: New `PairGateOverride` interface + `applyPairOverrides()` helper
- `bot-scanner/index.ts`: 1-line call after pairConfig clone
- `backtest-engine/index.ts`: Same 1-line call for backtest parity
- `bot-config/index.ts`: Validation for the new field
- 13 new tests with full regression coverage

**Zero behavior change** when `pairGateOverrides` is empty (the default). Only affects behavior when explicitly configured.
