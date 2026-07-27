# Task: Extract Tier-1 Minimum Gate to Shared Function
## Branch: manus/extract-gate-tier1-minimum
## Behavior changes
none — pure refactor

## Files modified
- `supabase/functions/_shared/gateTier1Minimum.ts` — new shared function `checkTier1Minimum()`
- `supabase/functions/_shared/gateTier1Minimum.test.ts` — cross-engine agreement tests (8 tests)
- `supabase/functions/bot-scanner/index.ts` — Gate 19 replaced with `checkTier1Minimum()` call + import added
- `supabase/functions/backtest-engine/index.ts` — Gate 16 replaced with `checkTier1Minimum()` call + import added
- `REPORT.md` — this file

## Design decisions
- **Divergence preserved via caller input:** bot-scanner passes `!!ts.tier1GatePassed` (undefined → false → FAIL), backtest passes `ts.tier1GatePassed ?? true` (undefined → true → PASS). The shared function accepts a resolved boolean.
- **Reason string pass-through:** When `tier1GateReason` is provided by confluenceScoring, it's used directly (preserving upstream regex parsing at bot-scanner line 5192). Fallback format `"Tier 1 gate: ..."` only used when reason is missing.
- **Reason string safety:** Fallback format satisfies `gatePerformanceEngine.ts` pattern (`includes("Tier 1")` ✅) and backtest diagnostics (`split(":")[0]` → `"Tier 1 gate"` ✅).

## Tests added
- `cross-engine: shared matches bot-scanner inline pass/fail for all test cases` — 6 synthetic inputs through old inline logic vs shared function
- `cross-engine: shared matches backtest-engine inline pass/fail for all test cases` — same 6 inputs through backtest's old logic
- `divergence documentation: undefined tier1GatePassed treated differently per engine` — proves the intentional divergence is preserved
- `gate disabled always passes regardless of tier1GatePassed` — disabled config always passes
- `fallback reason strings when tier1GateReason is empty` — fallback format correctness
- `reason string satisfies gatePerformanceEngine pattern: includes 'Tier 1'` — pattern safety
- `reason string satisfies backtest diagnostics: split(':')[0] is consistent` — aggregation key safety
- `pass-through reason: when tier1GateReason is provided, it's used directly` — upstream reason preserved

## Tests run
```
ok | 1750 passed | 0 failed (19s)
```

## Regression check
- Cross-engine agreement tests instantiate the literal old inline logic from both engines and compare pass/fail against the shared function on identical inputs
- Reason string sweep confirmed no downstream parsers are affected (gatePerformanceEngine matches on "Tier 1" substring; backtest diagnostics split on colon; bot-scanner line 5192 parses upstream `tier1GateReason` not gate output)
- No third copy found — this gate was not in the pre-gates fast-path

## Open questions
None — this is the final gate extraction in Stage 2.

## Suggested PR title and description
**Title:** [extract-gate-tier1-minimum] Extract Tier 1 Minimum gate to _shared/gateTier1Minimum.ts

**Description:**
Extracts the Tier 1 Minimum gate check (bot-scanner Gate 19, backtest-engine Gate 16) into a shared function.

Key design: the intentional divergence (bot-scanner treats undefined tier1GatePassed as FAIL, backtest treats it as PASS) is preserved via caller input, not function branching. Reason strings pass through from confluenceScoring when available, with a safe fallback format that satisfies both gatePerformanceEngine pattern matching and backtest diagnostics aggregation.

This is the final individual gate extraction in Stage 2. All 9 gates + the pre-gates consolidation are now complete.
