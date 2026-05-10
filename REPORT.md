# Task: Impulse Zone Hard Gate Integration

## Branch: manus/impulse-zone-gate

## Behavior changes

1. **Impulse Zone is now the primary entry gate (hard mode, default ON).** When `impulseZoneGateMode: "hard"` (default), pairs without a valid impulse zone are skipped entirely. Pairs where a zone exists but price is not at the zone are **watchlisted** (staged for entry when price arrives). Only when a zone exists AND price is at the zone does the bot proceed with confluence evaluation and safety gates.

2. **Counter-directional OBs score 0 points.** Previously, a bearish OB in a long trade received a x0.3 penalty (0.6pts from a 2pt max). Now it scores 0 points and is marked as `present: false`. This prevents counter-directional OBs from inflating confluence scores. The OB detail string reports the mismatch as informational ("counter-directional, not scored").

3. **SL overridden to impulse origin.** When the hard gate is active and the zone is confirmed, the stop loss is placed below the impulse origin (for longs) or above it (for shorts), with the configured SL buffer. The cap is configurable via `impulseSlCapMultiplier` (default 4, set higher for pairs like Gold with large impulses).

4. **TP recalculated from impulse SL.** When the SL is overridden to impulse origin, TP is recalculated as `entry + (impulseRisk x tpRatio)` to maintain proper R:R.

5. **Limit order entry uses impulse zone level.** When hard gate is active and the zone has a refined entry (from LTF refinement), limit orders target that level instead of the nearest Tier 1 OB/FVG. Fallback: zone midpoint.

6. **Market order entry uses impulse zone level.** When hard gate is active and limit orders are disabled, market orders also use the zone's refined entry (or zone midpoint) instead of current price.

7. **Zone-but-not-at-zone pairs are watchlisted.** Instead of being skipped entirely, pairs with a valid zone where price hasn't arrived yet are added to the staging/watchlist system with `setup_type: "impulse_zone_watch"`. The staged entry uses the zone's refined entry and SL at impulse origin. When price eventually reaches the zone, the bot is ready.

8. **Legacy "soft" mode preserved.** Setting `impulseZoneGateMode: "soft"` restores the old penalty/bonus behavior. Setting `"off"` makes the impulse zone purely informational.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Added `impulseZoneGateMode` config (default "hard"), `impulseSlCapMultiplier` config (default 4), impulse zone hard gate logic, zone watchlist staging, SL override to impulse origin, limit order entry override, market order entry override |
| `supabase/functions/_shared/confluenceScoring.ts` | Changed OB direction mismatch from x0.3 penalty to 0 points (counter-directional OBs not scored) |
| `supabase/functions/_shared/confluenceScoring.test.ts` | Added 3 regression tests for OB aligned-only scoring |

## bot-scanner/index.ts changes (caution file -- detailed explanation)

**What changed:** Five additions to the entry flow:

1. **DEFAULTS (line 165):** Added `impulseSlCapMultiplier: 4` — configurable max SL distance as multiple of min SL. Set higher (e.g., 6) for Gold/XAU to accommodate larger impulse ranges.

2. **Config resolution (line 771):** Added `impulseSlCapMultiplier` to the per-pair config resolution chain.

3. **Hard gate section (lines ~3648-3720):** The "not at zone" path was changed from `continue` (skip pair) to watchlist staging. When a zone exists but price hasn't reached it, the pair is staged with `setup_type: "impulse_zone_watch"`, entry at zone level, and SL at impulse origin. This ensures the bot is pre-loaded and ready when price arrives.

4. **SL override (line ~3912):** The hardcoded `4x` cap was replaced with `pairConfig.impulseSlCapMultiplier ?? 4`, making it configurable per pair.

5. **Market order section (lines ~4272-4278):** Added `marketEntryPrice` calculation that uses the zone's refined entry (or zone midpoint) when hard gate is active. Market orders now target the same precision level as limit orders.

**Why:** These refinements complete the sniper entry framework. The watchlist ensures no valid setup is lost just because price hasn't reached the zone yet. The market order override ensures consistent entry pricing regardless of order type. The configurable SL cap accommodates different volatility profiles across pairs.

## Tests added

| Test | Assertion |
|------|-----------|
| `OB aligned-only: bearish OB in long trade scores 0 points (not x0.3 penalty)` | Counter-directional OB has weight=0, present=false, detail includes "counter-directional" |
| `OB aligned-only: bullish OB in short trade scores 0 points` | Same as above for the inverse direction |
| `OB aligned-only: aligned OB retains full weight` | Aligned OB keeps its full default weight (2.0) and is marked present |

## Tests run

```
$ deno test --allow-all --no-check --ignore="src/test/example.test.ts"
ok | 462 passed | 0 failed (7s)
```

All 462 tests pass. 3 new tests added. No regressions.

## Regression check

- Type errors: 4 pre-existing type errors in bot-scanner/index.ts (confirmed identical on main). None introduced by this branch.
- All confluenceScoring snapshot tests pass (bullish, bearish, ranging fixtures produce stable output).
- The hard gate is placed BEFORE the entry decision, so it cannot affect downstream logic when it passes.
- The `"soft"` mode path is identical to the previous code.
- The watchlist staging uses the same `staged_setups` table and schema as existing staging logic.

## Open questions

None — all three refinements from user feedback are implemented.

## Suggested PR title and description

**Title:** feat: impulse zone hard gate — sniper entry framework with zone watchlist

**Description:**
Makes the impulse zone engine the primary entry gate. No zone = no trade. Price not at zone = watchlisted (ready when price arrives).

Changes:
- `impulseZoneGateMode: "hard"` (default) — no zone = skip, not-at-zone = watchlist
- Counter-directional OBs score 0 points (bearish OB in long = not scored)
- SL overridden to impulse origin (configurable cap via `impulseSlCapMultiplier`)
- Both limit and market orders target the zone's refined entry level
- Zone-watch staging: pairs with valid zones are pre-loaded in watchlist
- Legacy "soft" mode preserved via config

Eliminates entries at bad levels by requiring price to be at the predetermined institutional entry zone before any trade is evaluated.
