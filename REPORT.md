# Task: Backtest Parity — Phase A3: SL Override Chain
## Branch: manus/backtest-sl-override
## Behavior changes
1. **Impulse Zone SL Override** — When `izGateMode === "hard"` and an impulse zone is confirmed with price at zone, the backtest now overrides SL to the impulse origin (minus buffer). This widens the SL for structural protection, matching the live scanner. Only fires when the impulse SL is wider than current AND within the cap (staticMinSlPips × impulseSlCapMultiplier). TP is recalculated to maintain the configured R:R ratio.
2. **Regime-Adaptive TP Adjustment** — When `regimeAdaptiveTPEnabled === true`, the backtest now adjusts TP based on market regime: trending markets extend TP (×1.5 R:R), ranging markets tighten TP (×0.75 R:R), transitional/unknown leaves TP unchanged. Uses the same `adjustTPForRegime()` function from `_shared/exitEngine.ts` as the live scanner.

Both features are **off by default** (impulse zone requires `izGateMode: "hard"` with a confirmed zone; regime TP requires `regimeAdaptiveTPEnabled: true`). Users who haven't enabled these settings see zero change.

## Files modified
- `supabase/functions/backtest-engine/index.ts` — Added import for `adjustTPForRegime`, inserted Impulse Zone SL Override block (lines 2396-2421) and Regime-Adaptive TP block (lines 2423-2443) between the SL floor enforcement and position sizing.
- `supabase/functions/backtest-engine/slOverride.test.ts` — New test file with 12 regression tests.

## Tests added
1. `Impulse SL Override: widens SL to impulse origin for long` — Verifies SL moves to impulse.low - buffer
2. `Impulse SL Override: widens SL to impulse origin for short` — Verifies SL moves to impulse.high + buffer
3. `Impulse SL Override: does NOT override when impulse SL is tighter than current` — Guards against narrowing SL
4. `Impulse SL Override: does NOT override when impulse SL exceeds cap` — Verifies cap enforcement
5. `Impulse SL Override: XAU/USD with larger pip size` — Tests with non-standard pip size
6. `Regime TP: trending regime extends TP (long)` — Verifies TP extension in trends
7. `Regime TP: ranging regime tightens TP (long)` — Verifies TP tightening in ranges
8. `Regime TP: transitional regime leaves TP unchanged` — No adjustment for transitional
9. `Regime TP: null regime leaves TP unchanged` — No adjustment when regime unknown
10. `Regime TP: disabled config means no adjustment` — Verifies no-op when disabled
11. `Backward compat: no impulse zone means no SL override` — Zero-value impulse doesn't fire
12. `Backward compat: soft izGateMode skips impulse SL override` — Soft mode doesn't trigger

## Tests run
```
$ deno test supabase/functions/backtest-engine/ --no-check --allow-read
ok | 195 passed | 0 failed (709ms)
```

## Regression check
- All 183 existing tests (determinism + score parity + gates parity) still pass
- 12 new tests verify the override logic in isolation
- Backward compatibility confirmed: when izGateMode !== "hard" or regimeAdaptiveTPEnabled is false, the new code is completely skipped

## What was NOT ported (and why)
- **Unified Zone SL Override** — Requires `unifiedZoneData` which comes from a separate zone engine not present in the backtest. Would require porting the entire unified zone engine first.
- **Cascade Zone SL Override** — Requires `cascadeResult` from the cascade zone engine, also not present.
- **Direction-flipped SL recalculation** — The backtest uses `analysis.stopLoss` from `runConfluenceAnalysis` which already handles direction. The scanner's swing-point recalculation is part of its entry logic, not an override.

## Open questions
1. Should unified zone and cascade zone engines be ported to the backtest? This would be a significant effort (each is ~200-400 lines of logic with their own data requirements).
2. The `impulseSlCapMultiplier` default is 4 — is this still your preferred cap, or should it be configurable per-instrument?

## Suggested PR title and description
**Title:** `[backtest-parity] Phase A3: Port SL override chain to backtest engine`

**Description:**
Ports the Impulse Zone SL Override and Regime-Adaptive TP Adjustment from the live scanner to the backtest engine. When impulse zone gate is in hard mode and a zone is confirmed, SL is widened to the impulse origin for structural protection (capped at 4× static minimum). When regime-adaptive TP is enabled, TP is extended in trending markets and tightened in ranging markets. Both features are off by default — zero behavior change for existing configs. Includes 12 new regression tests; all 195 tests pass.
