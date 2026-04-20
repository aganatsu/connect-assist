
## Fix smc-analysis/index.ts type errors

### Verified shapes (from `_shared/smcAnalysis.ts`)
- `DisplacementResult` → `{ isDisplacement, displacementCandles[], lastDirection }` (no `detected`, no `count`)
- `AMDResult.phase` → `"accumulation" | "manipulation" | "distribution" | "unknown"` (no `"none"`)
- `VWAPResult` → `{ value, distancePips, rejection, barsAnchored }` (no `vwap`)

### Edits to `supabase/functions/smc-analysis/index.ts`

**Factor 10 — Displacement (~line 262)**
- `displacement.detected` → `displacement.isDisplacement`
- `displacement.count` → `displacement.displacementCandles.length`

**Factor 15 — AMD Phase (~line 332)**
- `amd.phase !== "none"` → `amd.phase !== "unknown"`

**Factor 16 — VWAP (~lines 346–349)**
- All 3 `vwap.vwap` → `vwap.value`
- Null check stays the same (`!== null`)

### Out of scope
- No bot logic changes
- No UI changes
- Other pre-existing build errors in other functions (backtest-engine, bot-scanner, bot-weekly-advisor) — handle in a follow-up if they still block deploy after this fix

### Verification
After edit, the 6 reported TS errors in `smc-analysis/index.ts` clear. Bot-scanner deploy + same-direction stacking test proceeds next.
