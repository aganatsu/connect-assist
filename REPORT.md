# Task: Fix ICT Integration Bugs + All TypeScript Errors in Bot-Scanner

## Branch: manus/scanner-ict-field-fix

## Behavior changes

1. **ICT Displacement MSS module now functional** — Previously, `validateRecentMSS` was called with 2 args (candles, config) instead of 4 (candles, breaks, direction, config), causing it to throw silently. The result was always `null`. Now it correctly validates MSS displacement and can:
   - **Soft mode:** Apply score penalty when MSS lacks displacement
   - **Hard mode:** Block trades when MSS lacks displacement

2. **ICT Judas Swing module now functional** — Previously, `detectJudasSwing` was called with 3 args (candles, direction, config) instead of 4 (candles, mssIndex, direction, config), with a string passed where a number was expected. Now it correctly detects liquidity sweeps and can:
   - **Soft mode:** Apply score penalty when no sweep found
   - **Hard mode:** Block trades when no sweep found

3. **ICT FVG Invalidation module now functional** — Previously, `validateFVGBatch` was called without the required `direction` argument, and the result accessed `.validCount`/`.invalidatedCount`/`.exhaustedCount`/`.totalCount` which don't exist on the interface (producing `NaN` in score calculations). Now it correctly validates FVGs and derives count fields from the results array.

4. **ICT Kill Zone module now functional** — Previously accessed `.inKillZone` (undefined) instead of `.isKillZone`, so the soft penalty ALWAYS fired (treating every trade as outside KZ) and the hard gate ALWAYS blocked. Now it correctly reads the KZ result. Config now passes `enableSilverBullet`/`enablePMSession` (previously passed non-existent `silverBullet`/`pmSession`).

5. **ICT Risk Management module now functional** — Previously called `assessRisk` with wrong signature (3 positional args instead of 1 object), accessed `.adjustedRiskPercent` (doesn't exist, should be `.recommendedRiskPercent`), and `.reason` (should be `.reasons`). Now correctly assesses risk and can gate/adjust position sizing.

6. **Breaker Block entries now functional** — Previously used undefined `spec` variable (would throw at runtime), undefined `volCtx`/`propFirmCtx`/`exitFlags` (would throw). Now uses `SPECS[pair]`, passes `undefined` for vol/prop contexts, and builds exitFlags locally.

7. **Circuit breaker in MetaApi mirror failure path now functional** — Previously referenced undeclared `connHealth` variable (would throw). Now correctly derives health from `brokerHealthMap[conn.id] || createInitialHealth(conn.id)`.

8. **Correlation conflict logging now correct** — Previously accessed `.conflictingSymbol` and `.correlation` (don't exist). Now uses `.conflictsWith[0]` and `.severity`.

9. **Net effect for users with ICT modules disabled (default):** Zero change. All ICT code paths are gated behind `pairConfig.ict*Enabled` flags.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Fixed 8 ICT integration bugs + 10 additional TypeScript errors. Total: 18 errors → 0 in bot-scanner. |
| `supabase/functions/bot-scanner/ictFieldFix.test.ts` | New regression test file with 14 tests proving correct field names, function signatures, and penalty/gate logic. |

## Tests added

| Test | Assertion |
|------|-----------|
| MSSValidationResult has .isValid field, not .valid | `.isValid` is boolean, `.valid` does not exist |
| MSSValidationResult returns isValid=true when disabled | Disabled config returns isValid=true (passthrough) |
| validateRecentMSS requires 4 args | 4-arg call succeeds without throwing |
| JudasSwingResult has .found field, not .detected | `.found` is boolean, `.detected` does not exist |
| detectJudasSwing requires 4 args | 4-arg call succeeds without throwing |
| ICTKillZoneResult has .isKillZone, not .inKillZone | `.isKillZone` is boolean, `.inKillZone` does not exist |
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
$ deno test --no-check --allow-read supabase/functions/bot-scanner/
ok | 131 passed | 0 failed (1s)

$ deno test --no-check --allow-read supabase/functions/backtest-engine/
ok | 122 passed | 0 failed (522ms)
```

## Regression check

- **Type check:** `deno check bot-scanner/index.ts` → 0 errors in bot-scanner itself (3 harmless TS2367 remain in shared ICT modules — dead code in "off" mode branches)
- **Baseline comparison:** Main branch has same 2 permission-related test failures. Our branch: 0 failures with proper permissions.
- **Users with ICT disabled (default):** Zero code path change — all ICT blocks are gated behind `pairConfig.ict*Enabled` flags
- **Users with ICT enabled:** Behavior changes from "silently broken" to "working as documented." This is intentional.
- **No changes to gate definitions, factor weights, or scoring formula** — only integration points fixed.

## Open questions

1. **The 3 TS2367 errors in shared ICT modules** (`_shared/ictDisplacementMSS.ts`, `_shared/ictJudasSwing.ts`, `_shared/ictKillZones.ts`) are harmless dead-code comparisons in `gateMode === "off"` branches. Fixing requires modifying `_shared/` files — want me to do that on a separate branch?

2. **configMapper.ts** doesn't map `breakEvenOffsetPips` or `standaloneMultiplier` — these are accessed via `(pairConfig as any)` casts. Should I add them to the mapper for type safety?

3. **Deployment timing:** Since ICT modules were completely non-functional, enabling them now will change trading behavior for any user who had them toggled on. Recommend deploying during low-activity hours and monitoring the first scan cycle.

4. **Structure breaks for MSS:** The fix passes `analysis.structure?.bos ?? []` as the breaks array. This is the best available data, but worth monitoring if the MSS module expects a specific format.

## Suggested PR title and description

**Title:** fix: ICT modules completely non-functional + 18 TypeScript errors resolved

**Description:**
The ICT integration layer (Displacement MSS, Judas Swing, FVG Invalidation, Kill Zone, Risk Management) was entirely broken in the live scanner due to:
- 3 field name mismatches (accessing undefined properties)
- 3 wrong function call signatures (throwing silently in try/catch)
- 2 missing derived fields (producing NaN in calculations)
- 1 config field name error (enableSilverBullet/enablePMSession)
- 1 ICT Risk module completely wrong call signature + field names

Additionally fixes 8 pre-existing TypeScript errors:
- Undeclared variables in breaker block path (spec, volCtx, propFirmCtx, exitFlags)
- Undeclared connHealth in MetaApi mirror failure path
- null→undefined coercions for rejected setup logger
- Type narrowing for direction parameter
- CorrelationConflict field name mismatches

**Result:** Bot-scanner TypeScript errors: 18 → 0.

**Impact:** Zero change for users with ICT disabled (default). For users with ICT enabled, behavior changes from "inert" to "working as documented." Recommend monitoring first scan cycle after deploy.

**Tests:** 14 new regression tests + 131 bot-scanner tests passing + 122 backtest tests passing.
