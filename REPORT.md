# Task: SL Floor Enforcement & Tier 1 Gate Tightening

## Branch: manus/sl-floor-and-tier1-gate

## Behavior changes

1. **Structure invalidation SL tightening now enforces a per-instrument floor.** Previously, the 50% tightening on CHoCH could push the SL arbitrarily close to the entry price (e.g., 12 pips on GBP/USD when the entry floor is 25 pips). Now, the tightened SL is clamped so it cannot be closer than the management floor (approximately 60% of the entry-time MIN_SL_PIPS). For GBP/USD, the management floor is 15 pips; for EUR/USD, 12 pips; for XAU/USD, 30 pips. This means some trades that previously had their SL tightened to very small distances will now have a wider (safer) SL after structure invalidation.

2. **Tier 1 confluence gate raised from 2 to 3 core factors.** Trades now require at least 3 of the 4 Tier 1 factors (Market Structure, Order Block, FVG, Premium/Discount & Fib) to pass the gate. Previously, 2 factors sufficed, which allowed entries with only Market Structure + Premium/Discount — directional bias without an institutional entry trigger. This change will **reject trades** that previously passed with only 2 Tier 1 factors. The intent is to filter out low-conviction setups that lack an OB or FVG confirmation.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/scannerManagement.ts` | Added SL floor enforcement after the structure invalidation 50% tightening calculation (lines 641–663). The floor uses a `MGMT_SL_FLOOR_PIPS` lookup table (~60% of the entry-time `MIN_SL_PIPS` values). If the tightened SL distance from entry is below the floor, it is clamped. A log line is emitted when the floor activates. The attribution message was also updated to include the floor value. |
| `supabase/functions/_shared/confluenceScoring.ts` | Changed the Tier 1 minimum gate threshold from `tier1Count >= 2` to `tier1Count >= 3`. Updated the failure reason message from "need at least 2" to "need at least 3". |
| `supabase/functions/_shared/__snapshots__/confluenceScoring.snapshot.json` | Updated snapshot: gate reason message now says "need at least 3". |
| `supabase/functions/_shared/__snapshots__/confluenceScoring.bearish.snapshot.json` | Updated snapshot: gate reason message now says "need at least 3". |
| `supabase/functions/_shared/__snapshots__/confluenceScoring.ranging.snapshot.json` | Updated snapshot: `tier1GatePassed` changed from `true` to `false` (the ranging fixture had 2 Tier 1 factors, which no longer passes). Gate reason updated. |
| `supabase/functions/_shared/slFloorAndTier1Gate.test.ts` | **New file.** 5 tests covering both changes. |

### Extra caution: scannerManagement.ts

The change to `scannerManagement.ts` adds a floor enforcement block inside the structure invalidation tightening path (the `if (structureAgainst && hasFreshCHoCH)` branch). The logic is:

1. After calculating `newSL` via the existing 50% tightening formula, compute the distance from entry to the proposed new SL.
2. Look up the management floor for the instrument from `MGMT_SL_FLOOR_PIPS` (a static lookup table mirroring `MIN_SL_PIPS` at ~60% values).
3. If the distance is below the floor, clamp `newSL` to exactly the floor distance from entry.
4. The existing `shouldTighten` guard (which prevents widening) still runs after the floor check.

This change does **not** alter the one-shot flag, the rMultiple guard, or any other management path. It only affects the SL value produced by structure invalidation tightening.

## Tests added

| Test | Assertion |
|------|-----------|
| `SL floor: structure invalidation cannot tighten GBP/USD below 15 pips` | GBP/USD long with 25-pip SL, CHoCH fires, 50% tightening would produce 12 pips, but floor clamps to 15 pips. Asserts `newSLDistPips >= 14.9`. |
| `SL floor: tightening that already respects floor is not clamped` | GBP/USD long with 50-pip SL, 50% tightening produces 25.5 pips (above 15-pip floor). Asserts no unnecessary clamping (`newSLDistPips >= 20`). |
| `SL floor: one-shot flag prevents repeated tightening` | Position with `structureInvalidationFired: true` in exitFlags. Asserts no `sl_tightened` action is produced. |
| `Tier 1 gate: fewer than 3 core factors now FAILS` | Flat candle fixture produces 0 Tier 1 factors. Asserts `tier1GatePassed === false` and reason includes "need at least 3". |
| `Tier 1 gate reason message references threshold of 3` | Asserts the gate failure reason string contains "need at least 3". |

## Tests run

```
$ deno test --allow-all --no-check supabase/functions/_shared/
ok | 92 passed | 0 failed (4s)
```

All 92 tests pass (87 existing + 5 new). The `--no-check` flag is needed due to pre-existing type errors in `crossEngineEquivalence.test.ts` (unrelated to this change).

## Regression check

**Confluence scoring regression:** The 3 snapshot tests (`confluenceScoring.test.ts`) were updated to reflect the new threshold. The ranging snapshot now correctly shows `tier1GatePassed: false` with 2 factors (was `true` before). The bullish and bearish snapshots already had `tier1GatePassed: false` with 1 factor — only the reason message text changed ("at least 2" → "at least 3").

**SL floor regression:** The test `SL floor: tightening that already respects floor is not clamped` verifies that wide SLs (50 pips) are not affected by the floor. The floor only activates when the tightened SL would be dangerously close to entry.

**No other code paths affected:** The floor enforcement is scoped entirely within the `if (structureAgainst && hasFreshCHoCH)` block. No other SL modification paths (trailing stop, break-even, session tightening) are touched.

## Open questions

1. **Management floor values:** The `MGMT_SL_FLOOR_PIPS` table uses ~60% of the entry-time `MIN_SL_PIPS` values. Should these be configurable per user, or are the static values acceptable? Currently they are hardcoded in `scannerManagement.ts`.

2. **Tier 1 gate at 3:** This is a significant filter change. With 4 Tier 1 factors (Market Structure, OB, FVG, Premium/Discount), requiring 3 means every valid trade needs at least one of OB or FVG plus Market Structure plus Premium/Discount. Is this the right balance, or should we consider an "entry trigger" sub-gate instead (require at least one of OB/FVG specifically)?

3. **Limit order fill SL floor (secondary bug):** The SL floor is enforced relative to market price at signal time, but limit orders fill at a different price. This means the effective SL distance from the fill price can be less than the floor. This is a separate issue not addressed in this PR.

## Suggested PR title and description

**Title:** `[sl-floor-and-tier1-gate] Enforce SL floor in structure invalidation + raise Tier 1 gate to 3`

**Description:**

Two changes to improve trade quality and risk management:

**1. SL Floor in Structure Invalidation**
The structure invalidation tightening (CHoCH against trade direction) previously moved SL 50% closer to current price with no lower bound. This could produce dangerously tight SLs (e.g., 12 pips on GBP/USD when the entry minimum is 25 pips). Now, the tightened SL is clamped to a per-instrument management floor (~60% of entry-time MIN_SL_PIPS).

**2. Tier 1 Gate: 2 → 3**
Raised the minimum Tier 1 factor count from 2 to 3. Losing trades were observed passing with only Market Structure + Premium/Discount (directional bias without institutional entry trigger). Now requires at least one of OB or FVG in addition to structure and zone.

**Testing:** 5 new tests, 92 total passing. Snapshot regression verified.
