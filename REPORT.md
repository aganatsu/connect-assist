# Task: Tiered Zone Confirmation

## Branch: manus/tiered-zone-confirmation

## Behavior changes

1. **Trades can now fire on Tier 2 (wick-based CHoCH + supporting signal)** — Previously, only close-based CHoCH triggered a fill. Now, a wick-based CHoCH that also has at least one supporting signal (engulfing, rejection wick, FVG, or volume spike) will trigger a fill. This means some trades that previously timed out waiting for a textbook close-based CHoCH will now execute.

2. **Trades can now fire on Tier 3 (reversal pattern without CHoCH)** — A strong engulfing candle with rejection wick and displacement >= threshold will trigger a fill even without a structural break. This is the most significant behavior change: trades that previously would NEVER fire (because CHoCH never formed) can now execute if the reversal pattern is strong enough.

3. **Displacement threshold lowered from 0.50 to 0.40 (default)** — The minimum candle body ratio for Tier 1 CHoCH is now 40% instead of 50%. For XAU/USD specifically, the threshold is 0.30 (was implicitly 0.50). This means more CHoCHs qualify, especially on volatile instruments like gold.

4. **Lookback window expanded from 6 candles (30 min) to 10 candles (50 min)** — CHoCHs that form on candles 7-10 after zone touch are now captured. Previously they were ignored.

5. **Confirmation signal now includes a `tier` field (1, 2, or 3)** — Stored in `signal_reason.confirmation.tier` for every confirmed trade. This is purely informational and does not affect execution.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/zoneConfirmation.ts` | Complete rewrite: added tiered confirmation system (T1: close-based CHoCH, T2: wick-based CHoCH + support, T3: reversal pattern), instrument-aware displacement thresholds, expanded lookback window, tier enable/disable config flags |
| `supabase/functions/bot-scanner/index.ts` | Updated `detectZoneConfirmation` call to pass `pending.symbol` for instrument-aware thresholds; added tier logging; added `tier` field to stored confirmation data |
| `supabase/functions/zone-confirmation-scanner/index.ts` | Same updates as bot-scanner: pass symbol, add tier logging, store tier in confirmation data |
| `supabase/functions/_shared/zoneConfirmation.test.ts` | Rewritten with 41 tests covering all 3 tiers, instrument-aware displacement, tier priority, config flags, and regression check |

## Tests added

| Test | Assertion |
|------|-----------|
| Tier 1: returns bearish_choch for short direction | Close-based CHoCH detected -> tier=1, type=bearish_choch |
| Tier 1: returns bullish_choch for long direction | Close-based CHoCH detected -> tier=1, type=bullish_choch |
| Tier 1: returns null when no CHoCH present | Steady uptrend -> null (no false positives) |
| Tier 1: returns null for wrong direction | Bearish pattern + long direction -> null |
| Tier 1: respects zoneTouchIndex filter | CHoCH before zone touch -> ignored |
| Tier 1: returns null for insufficient candles | < 5 candles -> null |
| Tier 1: respects minDisplacement config | 0.99 displacement -> filters most CHoCHs |
| Tier 2: disabled when tier2Enabled is false | Config flag respected |
| Tier 2: wick-based CHoCH with support | When Tier 1 disabled, wick CHoCH + signal -> tier=2 |
| Tier 3: detects bearish reversal pattern | Engulfing + rejection wick -> tier=3, type=bearish_reversal_pattern |
| Tier 3: detects bullish reversal pattern | Engulfing + rejection wick -> tier=3, type=bullish_reversal_pattern |
| Tier 3: does NOT fire without both signals | Rejection wick alone -> null |
| Tier 3: disabled when tier3Enabled is false | Config flag respected |
| Instrument-aware: XAU/USD uses 0.30 | Gold threshold applied |
| Instrument-aware: EUR/USD uses 0.40 | Default threshold applied |
| Instrument-aware: custom override | Config instrumentDisplacements map works |
| Tier priority: Tier 1 over Tier 3 | When both match, Tier 1 returned |
| Tier priority: Tier 3 only when 1&2 miss | Reversal pattern only fires as fallback |
| maxLookbackCandles: expanded window | 10 candles finds CHoCH that 3 candles misses |
| DEFAULT config has updated defaults | Verifies 0.4 displacement, 10 lookback, all tiers enabled |
| formatConfirmationSummary: Tier 1 | Includes [T1:CHoCH] label |
| formatConfirmationSummary: Tier 2 | Includes [T2:CHoCH+] label |
| formatConfirmationSummary: Tier 3 | Includes [T3:Reversal] label |
| formatConfirmationSummary: adequate strength | 0.35-0.5 shows "adequate" |
| Regression: Tier 1 only = old behavior | Old config (0.5 disp, 6 candles, no T2/T3) produces same results |

Plus all existing isPriceInZone, isImpulseBroken, and state machine tests preserved (41 total).

## Tests run

```
$ deno test supabase/functions/_shared/zoneConfirmation.test.ts --allow-all
ok | 41 passed | 0 failed (23ms)
```

Type checking:
```
$ deno check supabase/functions/_shared/zoneConfirmation.ts -> OK (no errors)
$ deno check supabase/functions/zone-confirmation-scanner/index.ts -> OK (no errors)
$ deno check supabase/functions/bot-scanner/index.ts -> 9 pre-existing errors (unrelated, verified on base branch)
```

## Regression check

1. **Tier 1 only config = old behavior**: A dedicated regression test proves that when `tier2Enabled=false`, `tier3Enabled=false`, `minDisplacement=0.5`, and `maxLookbackCandles=6`, the function produces identical results to the previous implementation.

2. **Pre-existing type errors**: Verified that the 9 TypeScript errors in bot-scanner exist on the base branch by stashing our changes and re-running `deno check`. All 9 errors are pre-existing property access issues unrelated to zone confirmation.

3. **Backward compatibility**: The `ConfirmationSignal` type adds a `tier` field. All existing code that reads `type`, `price`, `displacement`, `significance`, `closeBased`, `supportingSignals` continues to work unchanged.

## Open questions

1. **Zone-confirmation-scanner deployment**: The `zone-confirmation-scanner` function has no pg_cron job. The management cron in bot-scanner handles pending orders every 1 minute, but deploying the dedicated scanner as a separate 1-min cron would provide redundancy. Should I create a migration for this?

2. **Tier 3 aggressiveness**: Tier 3 fires on engulfing + rejection wick without a structural break. This is the most aggressive tier. If it triggers too many false entries, we can disable it via config (`tier3Enabled: false`) or add a volume spike requirement. Want me to default it to requiring 3 signals instead of 2?

3. **Per-instrument config**: Currently the instrument displacement map is hardcoded in `zoneConfirmation.ts`. Should this be moved to the bot config (Supabase `bot_configs` table) so you can tune it per-instrument from the dashboard?

## Suggested PR title and description

**Title:** `feat: tiered zone confirmation — 3 confirmation paths with instrument-aware thresholds`

**Description:**

Replaces the binary CHoCH-only zone confirmation with a 3-tier system:

- **Tier 1 (highest confidence):** Close-based CHoCH with displacement filter — instant fill
- **Tier 2 (medium confidence):** Wick-based CHoCH + at least 1 supporting signal (engulfing/rejection wick/FVG/volume spike) — fill
- **Tier 3 (pattern-based):** Strong reversal pattern (engulfing + rejection wick + displacement) without structural break — fill

Additional improvements:
- Instrument-aware displacement thresholds (XAU/USD: 0.30, BTC: 0.25, forex: 0.40)
- Lookback window expanded from 30 min to 50 min
- Each tier individually configurable (enable/disable)
- Confirmation tier recorded in trade metadata for analytics

Fixes the issue where trades reach "awaiting confirmation" but never fire because the CHoCH requirements were too strict for live 5m price action.
