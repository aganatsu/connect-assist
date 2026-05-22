# Task: Per-Instrument SL Buffer Override
## Branch: manus/per-instrument-sl-buffer
## Behavior changes
1. **New config field `instrumentBuffers`**: When a symbol has an entry in `instrumentBuffers`, the bot uses that value directly as the SL buffer (in pips) — bypassing the asset-class multiplier. This means gold's SL buffer can now be set to 150 pips ($1.50) instead of the previous 4 pips ($0.04).
2. **Default config now ships with recommended overrides**: New users (or users who reset to defaults) will get: XAU/USD=150, XAG/USD=200, BTC/USD=100, ETH/USD=200, US Oil=100.
3. **Existing users are NOT affected until they explicitly set overrides**: The `instrumentBuffers` field defaults to `{}` in the scanner DEFAULTS, so existing saved configs continue to use the old global × multiplier behavior unchanged.

## Files modified
| File | Change |
|------|--------|
| `supabase/functions/bot-scanner/index.ts` | Added `instrumentBuffers` to DEFAULTS; added override resolution logic at line 3229 (3 lines of logic); added mapping in loadConfig merged object |
| `supabase/functions/backtest-engine/index.ts` | Mirrored the same override resolution for backtest parity (lines 1432-1436); added instrumentBuffers to config mapping |
| `supabase/functions/bot-config/index.ts` | Added validation for instrumentBuffers (1-1000 range); added recommended defaults to getDefaultConfig() |
| `src/components/BotConfigModal.tsx` | Added search index entry; added per-instrument SL buffer editor UI in the instruments tab (commodities, crypto, indices) with real-time $ distance display |
| `supabase/functions/_shared/instrumentBuffers.test.ts` | New test file with 9 tests |

## Extra caution: bot-scanner/index.ts changes explained
The change is minimal and safe:
1. Added `instrumentBuffers: {} as Record<string, { slBufferPips?: number }>` to DEFAULTS (line 99) — empty map, no behavior change for existing users.
2. Added `instrumentBuffers: raw.instrumentBuffers || entry.instrumentBuffers || {}` to the loadConfig merged object (line 916) — reads from saved config.
3. Changed the `adjustedSlBuffer` calculation (line 3229-3232): checks for a per-symbol override first; if found, uses it directly; otherwise falls through to the original `slBufferPips * slBufferMultiplier` calculation unchanged.

## Extra caution: backtest-engine/index.ts changes explained
Mirrors the scanner logic exactly:
1. Added `instrumentBuffers` to config mapping (line 423).
2. Changed `adjustedSlBuffer` calculation (lines 1432-1436) with the same override-first logic.

## Tests added
| Test | Assertion |
|------|-----------|
| XAU/USD override bypasses multiplier | Override=150 → result=150 (not 150×2) |
| BTC/USD override bypasses multiplier | Override=100 → result=100 (not 100×2) |
| No override for XAU uses global × commodity multiplier | 2×2.0=4 |
| EUR/USD (forex) uses global × 1.0 multiplier | 2×1.0=2 |
| US30 (index) uses global × 3.0 multiplier | 2×3.0=6 |
| Override for XAU doesn't affect XAG | XAU=150, XAG=4 (global fallback) |
| XAU override produces correct price distance | 150×0.01=$1.50 |
| Regression: without override XAU buffer is only $0.04 | Proves the bug exists without the fix |
| Recommended defaults produce reasonable price distances | All 5 symbols within expected $ ranges |

## Tests run
```
$ deno test --allow-all supabase/functions/_shared/instrumentBuffers.test.ts
running 9 tests from ./supabase/functions/_shared/instrumentBuffers.test.ts
instrumentBuffers: XAU/USD override bypasses multiplier ... ok (0ms)
instrumentBuffers: BTC/USD override bypasses multiplier ... ok (0ms)
instrumentBuffers: no override for XAU/USD uses global × commodity multiplier ... ok (0ms)
instrumentBuffers: EUR/USD (forex) uses global × 1.0 multiplier ... ok (0ms)
instrumentBuffers: US30 (index) uses global × 3.0 multiplier ... ok (0ms)
instrumentBuffers: override for XAU doesn't affect XAG ... ok (0ms)
instrumentBuffers: XAU/USD override produces correct price distance ... ok (0ms)
instrumentBuffers: regression — without override XAU buffer is only $0.04 ... ok (0ms)
instrumentBuffers: recommended defaults produce reasonable price distances ... ok (0ms)
ok | 9 passed | 0 failed (10ms)

$ deno test --allow-all --no-check supabase/functions/_shared/
FAILED | 505 passed | 1 failed (9s)
# The 1 failure is pre-existing in impulseZoneEngine.test.ts (ETH bearish impulse fixture) — unrelated to this PR.
```

## Regression check
- The `resolveAdjustedSlBuffer` function is a pure superset: when `instrumentBuffers` is empty (which it is for all existing saved configs), the logic falls through to the original `slBufferPips * slBufferMultiplier` calculation — identical behavior.
- Tests 3, 4, and 5 explicitly verify the fallback path produces the same values as before.
- Vite production build passes cleanly (2556 modules, no errors).
- No gate definitions were modified. No factor weights were changed. No protected files were touched.

## Open questions
1. **Existing users**: Their saved config has no `instrumentBuffers` key, so they'll continue using the old (too-tight) buffers until they open settings and save. Should we auto-inject the recommended defaults for existing users via a migration script?
2. **Paper trading**: `paper-trading/index.ts` also has SL logic — it imports from `scannerManagement.ts` which calls `calculateSLTP` from smcAnalysis.ts. That function uses `config.slBufferPips` directly without the asset-class multiplier. Should we add the override there too? (Would require modifying scannerManagement.ts — a caution file.)

## Suggested PR title and description
**Title:** feat: per-instrument SL buffer overrides (fixes gold/crypto buffer too tight)

**Description:**
Adds a new `instrumentBuffers` config field that lets you set per-symbol SL buffer values (in pips). When set, the override is used directly — no asset-class multiplier is applied on top.

**Problem:** Gold (XAU/USD) with pipSize=0.01 and global buffer=2 pips × 2.0 commodity multiplier = $0.04 buffer. Gold moves $0.50-$2.00 in seconds, so SLs get wicked out immediately.

**Solution:** Per-instrument overrides with recommended defaults:
- XAU/USD: 150 pips = $1.50
- XAG/USD: 200 pips = $0.20
- BTC/USD: 100 pips = $100
- ETH/USD: 200 pips = $2.00
- US Oil: 100 pips = $1.00

Changes: bot-scanner, backtest-engine, bot-config validation, BotConfigModal UI, 9 new tests.
