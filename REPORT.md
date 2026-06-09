# Task: Cascade Zone Engine (Daily→4H→1H→15m)

## Branch: manus/cascade-zone-engine

## Behavior changes

1. **New cascade zone analysis runs on every scan** — when `cascadeZoneMode` is "prefer" (default) or "only", the scanner now executes a top-down Daily→4H→1H→15m zone search and attaches results to `detail.cascadeZone`. This is **informational only** in this release — it does NOT gate trades or override the existing impulse zone system. It enriches the scan detail panel with cascade state information.

2. **Daily Fib levels now passed to HTF confluence scoring** — previously `htfFibLevelsD` was computed but never passed to the impulse zone engine's `HTFConfluenceData`. Zones that align with Daily Fib levels now receive +0.5 to +1.5 additional score from the existing `checkHTFConfluence()` function. This means some zones that previously scored 3.5/9 may now score 4.5/9 (passing the minZoneScore gate) and vice versa — zones that DON'T align with Daily Fib are relatively weaker.

3. **New UI panel** — CascadeZonePanel shows the cascade state machine progression (Daily zone → 4H confirmation → 1H entry → 15m refinement) in the scan detail view.

4. **New config options** — `cascadeZoneMode` (prefer/only/off) and `cascadeZoneDailyATRMult` (default 2.0) are available in Bot Config → Strategy tab.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/cascadeZoneEngine.ts` | **NEW** — Top-down cascade zone engine with state machine (no_daily_impulse → no_daily_zone → waiting_for_price → at_daily_zone → no_confirmation → confirmed → no_entry_zone → ready → triggered) |
| `supabase/functions/_shared/cascadeZoneEngine.test.ts` | **NEW** — 23 tests covering all state transitions, edge cases, and integration behavior |
| `supabase/functions/_shared/configMapper.ts` | Added `cascadeZoneMode` and `cascadeZoneDailyATRMult` to RUNTIME_DEFAULTS and mapping |
| `supabase/functions/bot-scanner/index.ts` | Added cascade engine import, config defaults/mapping, scanner integration call, and fixed Daily Fib bug (added `dailyFibLevels: htfFibLevelsD` to htfConfluenceData) |
| `src/components/CascadeZonePanel.tsx` | **NEW** — UI panel showing cascade state progression with color-coded story steps |
| `src/components/BotConfigModal.tsx` | Added cascade mode selector dropdown in Strategy tab |
| `src/pages/BotView.tsx` | Added CascadeZonePanel rendering in all 3 scan detail locations |

## Tests added

| Test | Assertion |
|------|-----------|
| `findDailyImpulseLeg: detects bullish impulse` | Validates Daily impulse detection with proper swing structure |
| `findDailyImpulseLeg: detects bearish impulse` | Validates bearish Daily impulse detection |
| `findDailyImpulseLeg: returns null with flat candles` | No false positives on ranging markets |
| `findDailyZone: finds OB within Daily impulse` | POI mapping within Daily impulse leg works |
| `findDailyZone: returns null with no POIs` | Graceful handling when no OBs/FVGs exist |
| `findDailyZone: filters mitigated zones` | Already-touched zones are excluded |
| `checkPriceAtDailyZone: price far from zone` | Proximity detection rejects distant price |
| `checkPriceAtDailyZone: price within threshold` | Proximity detection accepts nearby price |
| `detect4HConfirmation: returns null with insufficient candles` | Edge case handling |
| `detect4HConfirmation: detects displacement inside Daily zone` | 4H displacement detection within Daily zone bounds |
| `detect1HConfirmation: returns null with insufficient candles` | Edge case handling |
| `findEntryZoneWithinDailyZone: returns null with insufficient candles` | Edge case handling |
| `findEntryZoneWithinDailyZone: filters zones outside Daily zone` | Entry zones must overlap with Daily zone |
| `findCascadeZone: returns no_daily_impulse with flat daily candles` | State machine starts correctly |
| `findCascadeZone: returns waiting_for_price when price far from Daily zone` | Correct state when zone exists but price is distant |
| `findCascadeZone: state machine progression is valid` | All states are valid enum values |
| `findCascadeZone: triggered state has entry and SL populated` | Final state has actionable data |
| `findCascadeZone: no_confirmation state has dailyZone but no entry` | Intermediate state is correct |
| `findCascadeZone: bearish direction works` | Bidirectional support |
| `cascade: Daily zone is the mandatory first filter` | No cascade without Daily zone |
| `cascade: entry zone must overlap with Daily zone` | Entry zones outside Daily zone are rejected |
| `cascade: confirmation is required before entry zone search` | State machine ordering enforced |
| `cascade options: dailyZoneATRMult affects proximity detection` | Config option works |

## Tests run

```
$ deno test --no-lock --no-check --allow-all supabase/functions/
ok | 1350 passed | 0 failed (17s)
```

## Regression check

1. **Daily Fib bug fix** — this is an intentional behavior change. Zones that align with Daily Fib levels now score higher. This affects which zones pass the minZoneScore gate. The change is additive (more information = better scoring) and cannot cause zones that previously passed to fail (Daily Fib only adds score, never subtracts).

2. **Cascade engine** — runs alongside the existing impulse zone engine. It does NOT gate trades in this release. The existing parallel 1H/4H system continues to function identically. The cascade result is informational only (attached to `detail.cascadeZone`).

3. **Config defaults** — `cascadeZoneMode: "prefer"` means the cascade runs but doesn't block anything. The existing impulse zone gate (`impulseZoneGateMode`) remains the active gating mechanism.

## Open questions

1. **Should the cascade engine eventually REPLACE the impulse zone gate?** Currently it's informational. Once you've validated it in paper trading and confirmed the states make sense, we can wire it as a gate (e.g., `cascadeZoneMode: "only"` would skip pairs that don't have a complete cascade story).

2. **4H displacement detection sensitivity** — the current threshold uses body > 0.6× range AND range > 1.5× average. Should this be configurable, or is the default sensitivity correct for your pairs?

3. **1H CHoCH detection** — currently uses the last 10 1H candles to find a CHoCH inside the Daily zone. Should the lookback be configurable?

## Suggested PR title and description

**Title:** feat: top-down cascade zone engine (Daily→4H→1H→15m) + Daily Fib bug fix

**Description:**
Adds a sequential cascade zone engine that tells a coherent top-down story: Daily impulse zone → 4H confirmation (displacement/1H CHoCH) → 1H entry zone → 15m refinement.

**What's new:**
- `cascadeZoneEngine.ts` — state machine with 9 states tracking the cascade progression
- Config toggle: `cascadeZoneMode` (prefer/only/off) in Bot Config → Strategy
- UI: CascadeZonePanel shows the story progression with color-coded steps
- Bug fix: Daily Fib levels were computed but never passed to HTF confluence scoring

**What's NOT changed:**
- The existing impulse zone gate continues to function identically
- No trades are gated by the cascade engine (informational only in this release)
- All 21 gates remain unchanged
- All 1350 tests pass
