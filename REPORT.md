# Task: TP Next-Level Skip — R:R Minimum Enforcement

## Branch: manus/tp-next-level-skip

## Behavior changes

1. **When `tpMethod = "next_level"`, targets that produce R:R below `minRiskReward` are now skipped.** Previously, the nearest structural target was always used regardless of how close it was to entry. Now the system iterates through sorted targets and picks the first one that satisfies the configured minimum R:R.

2. **When ALL structural targets produce sub-minimum R:R, the system falls back to `rr_ratio` method** (TP = SL distance × `tpRatio`). Previously, it would use the nearest target even if it was 0.7 pips away with a 15-pip SL (R:R = 0.05).

3. **Net effect on live trading**: Trades that previously passed all other gates but failed Gate 10 (R:R too low) due to a nearby structural target will now get a viable TP from the next target or the rr_ratio fallback. This means **some trades that were previously rejected will now pass** Gate 10 — but only when a valid structural target exists further away or the rr_ratio fallback produces adequate R:R.

## Files modified

- `supabase/functions/_shared/smcAnalysis.ts` — Modified `calculateSLTP()` next_level TP logic: replaced `tp = targets[0]` with R:R-aware target selection that skips sub-minimum targets and falls back to rr_ratio when none qualify.
- `supabase/functions/_shared/tpNextLevelSkip.test.ts` — New test file with 5 regression tests covering: skip nearest target, use nearest when adequate, rr_ratio fallback, long direction, and higher minRiskReward config.

## Tests added

1. **"skips nearest target when R:R < minRiskReward"** — Short with PDL 0.7 pips away (R:R=0.05) → skips to sell-side pool at 15 pips (R:R=1.0)
2. **"uses nearest target when R:R is adequate"** — Short with PDL giving R:R=3.14 → uses PDL correctly
3. **"falls back to rr_ratio when ALL targets produce sub-minimum R:R"** — All targets within 2 pips → falls back to entry ± SL×tpRatio
4. **"long direction skips close targets correctly"** — Long with ATR floor pushing SL to 15 pips → skips PDH, pool, PWH (all R:R < 1.0) → uses distant pool (R:R=1.47)
5. **"respects higher minRiskReward config"** — With minRiskReward=2.0, skips targets with R:R 1.0 → uses target with R:R=2.33

## Tests run

```
ok | 315 passed | 0 failed (7s)
```

## Regression check

- All 315 existing tests pass unchanged
- The change only affects `tpMethod === "next_level"` — other TP methods (fixed_pips, atr_multiple, rr_ratio) are completely untouched
- When R:R is adequate (target far enough from entry), behavior is identical to before (first target is used)
- The ATR floor interaction was verified: SL distance used for R:R calculation is the FINAL SL distance (after ATR floor), ensuring consistency with Gate 10's own R:R check

## Open questions

None — the fix is straightforward and well-bounded.

## Suggested PR title and description

**Title:** fix: next_level TP skips targets with sub-minimum R:R

**Description:**
Previously, `calculateSLTP()` with `tpMethod = "next_level"` always used the nearest structural target (PDL, PWL, liquidity pool) regardless of distance from entry. When the nearest target was very close (e.g., PDL 0.7 pips away with SL 14 pips), this produced R:R of 0.05 — which Gate 10 then rejected.

Now the TP logic iterates through sorted targets and picks the first one producing R:R >= `minRiskReward`. If no structural target qualifies, it falls back to `rr_ratio` method (TP = SL × tpRatio).

This means trades with good setups but a nearby-but-useless structural target will now get a viable TP from the next target in the queue, rather than being rejected at Gate 10.
