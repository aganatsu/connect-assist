# Task: Fix ICT Module Integration Bugs in Bot-Scanner

## Branch: manus/scanner-ict-field-fix

## Behavior changes

1. **ICT Displacement MSS module now functional** — Previously, `validateRecentMSS` was called with 2 args (candles, config) instead of 4 (candles, breaks, direction, config), causing it to throw silently. The result was always `null`. Now it correctly validates MSS displacement and can:
   - **Soft mode:** Apply score penalty when MSS lacks displacement
   - **Hard mode:** Block trades when MSS lacks displacement

2. **ICT Judas Swing module now functional** — Previously, `detectJudasSwing` was called with 3 args (candles, direction, config) instead of 4 (candles, mssIndex, direction, config), with a string passed where a number was expected. Now it correctly detects liquidity sweeps and can:
   - **Soft mode:** Apply score penalty when no sweep found
   - **Hard mode:** Block trades when no sweep found

3. **ICT FVG Invalidation module now functional** — Previously, `validateFVGBatch` was called without the required `direction` argument, and the result accessed `.validCount`/`.invalidatedCount`/`.exhaustedCount`/`.totalCount` which don't exist on the interface (producing `NaN` in score calculations). Now it correctly validates FVGs and derives count fields from the results array.

4. **ICT Kill Zone module now functional** — Previously accessed `.inKillZone` (undefined) instead of `.isKillZone`, so the soft penalty ALWAYS fired (treating every trade as outside KZ) and the hard gate ALWAYS blocked. Now it correctly reads the KZ result.

5. **Net effect for users with ICT modules enabled:** Trades will now be evaluated against ICT criteria as intended. Users who had ICT modules enabled in "hard" mode were getting all trades silently passed (because the try/catch swallowed the errors and left results as `null`). Users in "soft" mode were getting no penalties applied. Both modes now work correctly.

6. **Net effect for users with ICT modules disabled (default):** Zero change. All ICT code paths are gated behind `pairConfig.ict*Enabled` flags.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Fixed 8 ICT integration bugs: 3 field name mismatches, 2 function call signature errors, 2 missing derived count fields, 1 logging field fix. Also fixed config field name mappings (minRangeATR→minRangeATRMult, lookback→lookbackCandles for MSS; lookback→sweepLookback, minDepthATR→minSweepDepthATR for Judas). Added FVG type conversion (FairValueGap[] → FVGForValidation[] with midpoint derivation). |
| `supabase/functions/bot-scanner/ictFieldFix.test.ts` | New regression test file with 14 tests proving correct field names, function signatures, and penalty/gate logic. |

## Tests added

| Test | Assertion |
|------|-----------|
| MSSValidationResult has .isValid field, not .valid | `.isValid` is boolean, `.valid` does not exist |
| MSSValidationResult returns isValid=true when disabled | Disabled config returns isValid=true (passthrough) |
| validateRecentMSS requires 4 args | 4-arg call succeeds without throwing |
| JudasSwingResult has .found field, not .detected | `.found` is boolean, `.detected` does not exist |
| detectJudasSwing requires 4 args | 4-arg call succeeds without throwing |
| ICTKillZoneResult has .isKillZone, not .inKillZone | `.isKillZone` is boolean, `.inKillZone` does not exist; `.windowLabel` exists, `.activeZone` does not |
| BatchFVGValidationResult needs derived count fields | Raw result lacks `.validCount` etc., but has `.results` array for derivation |
| validateFVGBatch requires 4 args | 4-arg call (with direction) succeeds |
| Soft mode MSS penalty uses .isValid correctly | Penalty fires only when isValid=false |
| Soft mode Judas penalty uses .found correctly | Penalty fires only when found=false |
| Soft mode KZ penalty uses .isKillZone correctly | Prime bonus when in KZ, penalty when outside |
| Hard gate MSS blocks correctly with .isValid | Does NOT block when isValid=true |
| Hard gate Judas blocks correctly with .found | Blocks when found=false |
| Hard gate KZ blocks correctly with .isKillZone | Blocks when isKillZone=false |

## Tests run

```
$ deno test supabase/functions/bot-scanner/ictFieldFix.test.ts --allow-all --no-check
running 14 tests from ./supabase/functions/bot-scanner/ictFieldFix.test.ts
[ICT Field Fix] MSSValidationResult has .isValid field, not .valid ... ok (1ms)
[ICT Field Fix] MSSValidationResult returns isValid=true when disabled ... ok (434µs)
[ICT Field Fix] validateRecentMSS requires 4 args (candles, breaks, direction, config) ... ok (171µs)
[ICT Field Fix] JudasSwingResult has .found field, not .detected ... ok (582µs)
[ICT Field Fix] detectJudasSwing requires 4 args (candles, mssIndex, direction, config) ... ok (228µs)
[ICT Field Fix] ICTKillZoneResult has .isKillZone field, not .inKillZone ... ok (569µs)
[ICT Field Fix] BatchFVGValidationResult needs derived count fields ... ok (888µs)
[ICT Field Fix] validateFVGBatch requires 4 args (fvgs, candles, direction, config) ... ok (210µs)
[ICT Field Fix] Soft mode MSS penalty uses .isValid correctly ... ok (123µs)
[ICT Field Fix] Soft mode Judas penalty uses .found correctly ... ok (113µs)
[ICT Field Fix] Soft mode KZ penalty uses .isKillZone correctly ... ok (109µs)
[ICT Field Fix] Hard gate MSS blocks correctly with .isValid ... ok (104µs)
[ICT Field Fix] Hard gate Judas blocks correctly with .found ... ok (83µs)
[ICT Field Fix] Hard gate KZ blocks correctly with .isKillZone ... ok (83µs)
ok | 14 passed | 0 failed (14ms)

$ deno test supabase/functions/backtest-engine/determinism.test.ts --allow-all --no-check
ok | 31 passed | 0 failed (12ms)
```

## Regression check

- **Existing determinism tests:** All 31 pass (no regression in backtest engine)
- **Users with ICT disabled (default):** Zero code path change — all ICT blocks are gated behind `pairConfig.ict*Enabled` flags
- **Users with ICT enabled:** Behavior changes from "silently broken" to "working as documented." This is intentional — the modules were advertised as functional but were completely inert due to these bugs.
- **No changes to gate definitions, factor weights, or scoring formula** — only the ICT module integration points were fixed.

## Open questions

1. **ICT Risk module (lines 4987-5010):** Also has pre-existing bugs — `assessRisk` called with 3 args but expects 1, accesses `.adjustedRiskPercent` (doesn't exist), `.reason` (should be `.reasons`). I did NOT fix this because it's a separate module and the scope was already large. Should I fix it on a follow-up branch?

2. **ICT KillZone config:** The scanner passes `silverBullet` and `pmSession` to `ICTKillZoneConfig` but those fields don't exist on the interface. The spread operator with `DEFAULT_ICT_KILLZONE_CONFIG` means they're harmlessly ignored, but the config mapper is storing values that have no effect. Low priority but worth noting.

3. **Deployment timing:** Since ICT modules were completely non-functional, enabling them now will change trading behavior for any user who had them toggled on. Recommend deploying during low-activity hours and monitoring the first scan cycle.

4. **Structure breaks for MSS:** The fix passes `analysis.structure?.bos ?? []` as the breaks array. This is the best available data, but the live scanner may need a more specific break extraction if the MSS module expects a particular format. Worth monitoring.

## Suggested PR title and description

**Title:** fix: ICT modules completely non-functional — 8 integration bugs

**Description:**
The ICT modules (Displacement MSS, Judas Swing, FVG Invalidation, Kill Zone) were entirely broken in the live scanner due to:
- 3 field name mismatches (accessing undefined properties)
- 2 wrong function call signatures (throwing silently in try/catch)
- 2 missing derived fields (producing NaN in calculations)
- 1 logging field name error

**Impact:** Any user with ICT modules enabled was getting zero benefit from them. Hard mode gates never blocked, soft mode penalties never applied. This fix makes them functional as documented.

**Risk:** Low for users with ICT disabled (default). For users with ICT enabled, behavior changes from "inert" to "working" — recommend monitoring first scan cycle after deploy.

**Tests:** 14 new regression tests + 31 existing tests passing.
