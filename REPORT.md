# Task: exit-engine
## Branch: manus/exit-engine
## Behavior changes
When enabled via config toggles (both default: `false`), the following behavior changes apply:

1. **Regime-adaptive TP (`regimeAdaptiveTPEnabled: true`):** At trade entry, TP is adjusted based on market regime:
   - Trending/strong_trend → TP extended (R:R × 1.5 by default, capped at maxRR 4.0 and 6×ATR sanity)
   - Ranging/choppy → TP tightened (R:R × 0.75 by default, floored at minRR 1.0)
   - Transitional/unknown/low-confidence → no change
   - This alters the TP level on new trades when the regime is clear.

2. **Adaptive trailing (`adaptiveTrailingEnabled: true`):** During open-trade management, trailing stop distance adapts to:
   - Momentum state: strong momentum → wider trail (let it run), fading momentum → tighter trail (protect profits)
   - Regime overlay: trending → +10% width, ranging → -15% width
   - R-multiple scaling: deeper in profit → progressively tighter
   - Floor: minimum 0.5×ATR to prevent micro-trails
   - This replaces the fixed-pip trailing with ATR-based adaptive trailing for positions where the config is enabled.

**When both toggles are `false` (default), behavior is identical to main — zero change.**

## Files modified
- `supabase/functions/_shared/exitEngine.ts` — NEW: regime-adaptive TP (`adjustTPForRegime`) and momentum-fade trailing (`computeAdaptiveTrail`)
- `supabase/functions/_shared/exitEngine.test.ts` — NEW: 22 unit tests covering both functions
- `supabase/functions/bot-scanner/index.ts` — Added import, config toggles (`regimeAdaptiveTPEnabled`, `adaptiveTrailingEnabled`, plus tuning params), config loading, and regime-adaptive TP call before MIN_TP_PIPS check
- `supabase/functions/_shared/scannerManagement.ts` — Added import and adaptive trailing logic in Phase B (trailing tightening), with fallback to original fixed-pip trailing when disabled

### Extra caution: scannerManagement.ts changes
The Phase B trailing block was modified to support adaptive trailing. When `config.adaptiveTrailingEnabled` is `true`, the trailing distance is computed by `computeAdaptiveTrail()` using ATR, momentum state, and regime — instead of the fixed `effectiveTrailPips`. When `false` (default), the original fixed-pip logic runs exactly as before. The ratchet-forward guard (`shouldTighten`) is shared by both paths, ensuring SL only moves in the profitable direction regardless of which trailing mode is active. The adaptive path fetches 15m candles for momentum detection (same `fetchCandlesFn` already injected into the function), wrapped in try/catch to degrade gracefully.

### Extra caution: bot-scanner/index.ts changes
Added a regime-adaptive TP block between the existing SL/TP finalization and the MIN_TP_PIPS check. When `regimeAdaptiveTPEnabled` is `true`, the TP is adjusted based on regime info already available in the analysis result. The adjustment is logged with full attribution (original TP, adjusted TP, regime, R:R change). When `false` (default), the block is skipped entirely.

## Tests added
1. `adjustTPForRegime — trending regime extends TP` — verifies R:R is multiplied by 1.5 in trending
2. `adjustTPForRegime — ranging regime tightens TP` — verifies R:R is multiplied by 0.75 in ranging
3. `adjustTPForRegime — strong_trend uses trending multiplier` — strong_trend treated as trending
4. `adjustTPForRegime — choppy uses ranging multiplier` — choppy treated as ranging
5. `adjustTPForRegime — transitional regime leaves TP unchanged` — no adjustment for transitional
6. `adjustTPForRegime — low confidence leaves TP unchanged` — confidence < 0.5 → no change
7. `adjustTPForRegime — null regime leaves TP unchanged` — null regime → no change
8. `adjustTPForRegime — zero SL distance returns unchanged` — edge case: SL = entry
9. `adjustTPForRegime — R:R capped at maxRR and ATR sanity` — verifies both caps
10. `adjustTPForRegime — R:R floored at minRR` — verifies floor
11. `adjustTPForRegime — short direction works correctly` — short TP calculation
12. `computeAdaptiveTrail — strong momentum widens trail` — big bodies + directional = wider
13. `computeAdaptiveTrail — fading momentum tightens trail` — small bodies + mixed = tighter
14. `computeAdaptiveTrail — neutral momentum uses base trail` — moderate bodies = base
15. `computeAdaptiveTrail — trending regime widens trail by 10%` — regime overlay
16. `computeAdaptiveTrail — ranging regime tightens trail by 15%` — regime overlay
17. `computeAdaptiveTrail — shouldTighten is true when new SL is better for long` — ratchet logic
18. `computeAdaptiveTrail — shouldTighten is false when current SL is already tight` — no widen
19. `computeAdaptiveTrail — short direction works correctly` — short SL calculation
20. `computeAdaptiveTrail — no ATR uses pipSize fallback` — fallback to 20 pips
21. `computeAdaptiveTrail — R-multiple scaling tightens at high R` — progressive tightening
22. `computeAdaptiveTrail — floor prevents micro-trail` — minimum 0.5×ATR

## Tests run
```
Main:   414 passed | 12 failed (pre-existing)
Branch: 414 passed | 12 failed (same pre-existing failures)
New tests: 22 (all passing)
```

Pre-existing failures (unchanged): example.test.ts, candleSource.test.ts (2), confluenceScoring.test.ts snapshots (3), rangingDirectionFixes.test.ts (3), gate6Heat.test.ts, smtVeto.test.ts, reset.test.ts

## Regression check
- Both toggles default to `false` — when disabled, code paths are identical to main
- Verified on main: same 414/12 pass/fail ratio
- The regime-adaptive TP only fires when `regimeAdaptiveTPEnabled: true` AND regime confidence ≥ 0.5
- The adaptive trailing only fires when `adaptiveTrailingEnabled: true` AND trailing is already activated (Phase B)
- Both paths preserve the ratchet-forward guard (SL only moves in profitable direction)

## Open questions
1. Should `regimeAdaptiveTPEnabled` default to `true` after paper testing, or keep it opt-in permanently?
2. The `baseTrailATRMultiple` default of 1.5 may need tuning per instrument class (forex vs crypto). Should we add per-instrument overrides?
3. Should the adaptive trailing also affect the trailing activation threshold (Phase A), or only the tightening distance (Phase B)?

## Config toggles

| Setting | Default | Description |
|---------|---------|-------------|
| `regimeAdaptiveTPEnabled` | `false` | Enable regime-adaptive TP at trade entry |
| `trendingRRMultiplier` | `1.5` | R:R multiplier in trending/strong_trend regimes |
| `rangingRRMultiplier` | `0.75` | R:R multiplier in ranging/choppy regimes |
| `maxRR` | `4.0` | Hard cap on adjusted R:R |
| `minRR` | `1.0` | Floor on adjusted R:R |
| `adaptiveTrailingEnabled` | `false` | Enable momentum-fade adaptive trailing |
| `baseTrailATRMultiple` | `1.5` | Base trail distance as ATR multiple |
| `momentumFadeThreshold` | `0.4` | Body/range ratio below this = fading momentum |
| `trailTightenFactor` | `0.6` | Multiply trail distance by this when fading |
| `trailWidenFactor` | `1.3` | Multiply trail distance by this when strong |

## Suggested PR title and description
**Title:** `[exit-engine] Regime-adaptive TP and momentum-fade trailing stop`

**Description:**
Adds two opt-in exit improvements:

1. **Regime-adaptive TP** — extends TP in trending markets (let winners run) and tightens in ranging (take profits quickly). Scales R:R by regime multiplier with maxRR/minRR/ATR caps.

2. **Momentum-fade trailing** — replaces fixed-pip trailing with ATR-based adaptive distance that tightens when momentum fades (small bodies, mixed direction) and widens when momentum is strong. Includes regime overlay and progressive R-multiple scaling.

Both are off by default (`regimeAdaptiveTPEnabled: false`, `adaptiveTrailingEnabled: false`). Enable on paper mode first.

22 new tests, all passing. Zero behavior change when toggles are off.
