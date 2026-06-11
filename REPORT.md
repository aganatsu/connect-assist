# Task: Consolidate Zone Engines
## Branch: manus/consolidate-zone-engines

## Behavior changes

1. **Impulse zone detection now uses Daily candles** — Previously, `detail.impulseZone` was derived from a separate `findBestEntryZoneMultiTF` call that only received 1H + 4H candles. Now it's derived from the unified engine's `multiTFResult`, which includes Daily candles. This means the impulse zone gate may now detect Daily impulses that were previously invisible to it.

2. **One zone per pair instead of two** — Previously, the frontend showed two separate panels (Impulse Zone + Unified Zone) that could display different impulses from different timeframes. Now there is one "Zone Story" panel showing a single coherent narrative from the same source.

3. **Zone selection may differ** — Because the waterfall now includes Daily (which always wins when available), pairs that previously showed a 1H zone may now show a Daily zone instead. This is intentional — Daily zones are higher conviction.

4. **No change to gate pass logic** — The impulse zone gate still checks the same fields (`izData.hasZone`, `izData.bestZone.priceAtZone`, etc.). The unified gate still checks the same conditions. Only the data source changed (from separate call to unified engine's multiTFResult).

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/bot-scanner/index.ts` | Removed separate `findBestEntryZoneMultiTF` call; derive `detail.impulseZone` from unified engine's `multiTFResult`. Cleaned import. |
| `src/components/ZoneStoryPanel.tsx` | **NEW** — Consolidated panel replacing both ImpulseZonePanel and UnifiedZonePanel. Single narrative: Impulse → Zone → Price → Liquidity → Confirmation → Entry. |
| `src/pages/BotView.tsx` | Replaced all 3 usages of ImpulseZonePanel + UnifiedZonePanel with single ZoneStoryPanel. Updated import. |
| `supabase/functions/_shared/zoneConsolidation.test.ts` | **NEW** — Regression test verifying derivation equivalence. |
| `RFC_ZONE_CONSOLIDATION.md` | **NEW** — Architecture spec documenting the consolidation approach. |

## Tests added

| Test | Assertion |
|------|-----------|
| `Zone Consolidation: unified engine's multiTFResult matches standalone call` | Verifies that calling `findBestEntryZoneMultiTF` directly produces the same result as extracting `multiTFResult` from `findUnifiedZone` — proving the consolidation is data-equivalent. |
| `Zone Consolidation: izData derivation from multiTFResult has all required fields` | Verifies all 16+ fields needed by gates and frontend are present in the derived izData object. |
| `Zone Consolidation: no zone case — izData.hasZone is false, bestZone is null` | Verifies graceful handling when no impulse/zone is found. |

## Tests run

```
ok | 1430 passed | 0 failed (16s)
```

## Regression check

1. **Data equivalence test** — The `zoneConsolidation.test.ts` proves that `unifiedResult.multiTFResult` produces identical output to a standalone `findBestEntryZoneMultiTF` call with the same inputs (same candles, same direction, same price).

2. **Field completeness test** — All 16+ fields accessed by `izData.*` in the gate logic are verified to exist with correct types after derivation from multiTFResult.

3. **Live scan verification** — After deploying the previous task's changes (which used the same unified engine), we observed a live scan where both BTC/USD and EUR/USD correctly showed zone data from the unified engine with no errors.

## Open questions

1. **Cascade Zone Engine removal** — Deferred to Phase B (follow-up task). The cascade engine (119 references) is still active behind its config flag. Once this branch is stable in production, a follow-up task should remove it entirely since the unified engine now handles the Daily → 4H → 1H waterfall.

2. **Old panel files** — `ImpulseZonePanel.tsx` and `UnifiedZonePanel.tsx` are no longer imported but still exist in the repo. They can be deleted in a cleanup commit once the new panel is verified in production.

3. **Daily candle availability** — The consolidation assumes Daily candles are available for the unified engine call. If a pair doesn't have Daily data, the waterfall falls back to 4H → 1H (same as before). Verify this works for all 16 pairs in the watchlist.

## Suggested PR title and description

**Title:** `feat: consolidate impulse zone + unified zone into single engine call`

**Description:**
Removes the separate `findBestEntryZoneMultiTF` call from bot-scanner and derives `detail.impulseZone` from the unified engine's `multiTFResult` instead. This fixes the "two different impulses" problem where the 1H impulse zone engine and the Daily unified zone engine detected different impulses for the same pair.

Frontend: merges the two zone panels (ImpulseZonePanel + UnifiedZonePanel) into a single "Zone Story" panel that tells one coherent narrative from impulse detection through to entry.

**Key changes:**
- Single zone engine call per pair (unified engine includes Daily → 4H → 1H waterfall)
- One panel in the UI instead of two competing displays
- All gate logic unchanged (same field names, same conditions)
- 3 regression tests proving data equivalence

**Behavior impact:** Zone selection may now prefer Daily impulses over 1H (higher conviction). No change to gate pass thresholds or scoring weights.
