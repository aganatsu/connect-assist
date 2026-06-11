# Task: Remove Cascade Zone Engine (Phase B)

## Branch: manus/remove-cascade-engine

## Behavior changes

1. The `cascadeZoneMode` config option is no longer read — effectively always "off"
2. Pairs that previously required cascade story completion (mode="only") now use the unified gate or fall through to impulse zone gate directly
3. Pairs where unified gate was already passing see zero change (unified always took priority over cascade)
4. The cascade zone config dropdown is removed from the bot settings UI
5. `detail.cascadeZone` is no longer populated in scan results (frontend never displayed it after the ZoneStoryPanel consolidation)

## Files modified

| File | Change |
|------|--------|
| `supabase/functions/bot-scanner/index.ts` | Removed import, 2 DEFAULTS, 2 config resolution lines, 80-line call block, 50-line gate block, SL override block, entry override block, zoneEngineWillOverride reference — total -724 lines |
| `src/components/BotConfigModal.tsx` | Removed cascade zone mode dropdown (16 lines) |
| `src/components/CascadeZonePanel.tsx` | Deleted (unused component) |
| `supabase/functions/_shared/cascadeGate.test.ts` | Deleted (tests the removed gate) |

## Tests added

None new — this is a pure removal. The cascade engine library file (`cascadeZoneEngine.ts`) and its unit tests (`cascadeZoneEngine.test.ts`) are retained since the module itself is still valid code.

## Tests run

```
$ deno test supabase/ --allow-all --no-check
ok | 1413 passed | 0 failed (16s)
```

(17 fewer than the 1430 from the previous branch — those 17 were in the deleted `cascadeGate.test.ts`)

## Regression check

- The unified gate already took priority over cascade for SL, entry, and gate pass decisions
- With cascade removed, the unified gate is now the sole "story-based" gate — same behavior for all pairs where unified was active
- For pairs where cascade was the only active gate (mode="only" without unified passing), they now fall through to the impulse zone hard gate — which is the correct behavior since the impulse zone data now comes FROM the unified engine (per the consolidate-zone-engines branch)

## Open questions

1. Should we also delete the `cascadeZoneEngine.ts` library file? It's 400 lines of dead code but harmless. Keeping it preserves the option to re-enable later.
2. Any pairs in your bot_configs table that have `cascadeZoneMode: "only"` will now fall through to the impulse zone gate instead of blocking. Verify this is acceptable for your setup.

## Suggested PR title and description

**Title:** `refactor: remove cascade zone engine from bot-scanner (Phase B)`

**Description:**
Removes the cascade zone engine integration from bot-scanner, completing the zone engine consolidation started in `manus/consolidate-zone-engines`.

The cascade engine is now redundant because:
- The unified zone engine already performs the same Daily → 4H → 1H waterfall
- The unified gate always took priority over cascade for SL/entry overrides
- The impulse zone data now derives from the unified engine's multiTFResult

This removes 732 lines of dead code paths, simplifying the gate flow from `unified > cascade > impulse` to `unified > impulse`.

The cascade engine library (`cascadeZoneEngine.ts`) is retained as a standalone module in case it's needed later.
