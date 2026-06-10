# Task: Unified Impulse Zone Engine
## Branch: manus/unified-impulse-engine
## Behavior changes
none — purely additive. The unified zone engine runs alongside the existing impulse zone and cascade zone engines. It stores results in `detail.unifiedZone` but does NOT affect any gates, scoring, or trade decisions. The existing `impulseZone` and `cascadeZone` outputs remain unchanged.

## Files modified

| File | Description |
|------|-------------|
| `supabase/functions/_shared/impulseZoneEngine.ts` | Extended `ImpulseLeg` interface with `timeframe`, `startDate`, `endDate`, `spanBars` (optional, backward-compatible). Added `dailyCandles` parameter to `findBestEntryZoneMultiTF` with Daily-first waterfall logic. Added `dailyResult` to `MultiTFZoneResult`. |
| `supabase/functions/_shared/zoneLiquidity.ts` | **NEW** — Zone-specific liquidity pool detection. Finds BSL/SSL near zone edges, classifies as entry_trigger/target, detects sweeps with recency check, scores +1.0/+2.5/+3.0. |
| `supabase/functions/_shared/zoneLiquidity.test.ts` | **NEW** — 11 tests for zone liquidity module. |
| `supabase/functions/_shared/confirmationHierarchy.ts` | **NEW** — Ranked confirmation evaluation: Sweep+CHoCH (2.5) > LTF CHoCH (2.0) > Displacement (1.5) > Inducement (1.0) > None (0). Close-based CHoCH only. |
| `supabase/functions/_shared/confirmationHierarchy.test.ts` | **NEW** — 8 tests for confirmation hierarchy. |
| `supabase/functions/_shared/unifiedZoneEngine.ts` | **NEW** — Composes impulse zone + liquidity + confirmation into one story. Entry direction = impulse direction (continuation). Scoring /14. State machine: no_zone → watching → at_zone → confirmed → triggered. |
| `supabase/functions/_shared/unifiedZoneEngine.test.ts` | **NEW** — 8 tests for unified zone engine. |
| `supabase/functions/bot-scanner/index.ts` | Added import for `findUnifiedZone`. Added unified zone call after existing impulse zone section (~line 4124). Stores result in `detail.unifiedZone`. Non-fatal try/catch. Does NOT modify any existing logic. |
| `src/components/UnifiedZonePanel.tsx` | **NEW** — Frontend panel displaying the unified story: Impulse → Zone → Price → Liquidity → Confirmation → Entry with progressive bullets. |
| `src/pages/BotView.tsx` | Added import and rendering of `UnifiedZonePanel` in all 3 detail view locations (alongside existing panels). |
| `docs/UNIFIED_IMPULSE_ENGINE_SPEC.md` | **NEW** — Full design spec document for the unified engine architecture. |

## Extra caution note: bot-scanner/index.ts
The change to bot-scanner is purely **additive**: a new `findUnifiedZone()` call is inserted between the existing impulse zone section and the cascade zone section. It writes to a new field `detail.unifiedZone` that did not previously exist. The existing impulse zone logic, cascade zone logic, gates, and trade decision flow are completely untouched. The call is wrapped in try/catch so any error is non-fatal and logged.

## Tests added

| Test | Assertion |
|------|-----------|
| `zoneLiquidity.test.ts` — 11 tests | BSL/SSL detection near zone, sweep detection, rejection scoring, distance filtering, pool strength filtering, direction classification, multiple pool sorting |
| `confirmationHierarchy.test.ts` — 8 tests | No signals → none, insufficient candles → none, sweep+CHoCH → 2.5, inducement → 1.0, wrong direction ignored, displacement detection, hierarchy ordering |
| `unifiedZoneEngine.test.ts` — 8 tests | Flat market → no_zone, zone found → watching, liquidity scoring, continuation direction, score breakdown structure, Daily TF bonus, story summary, state transitions |

## Tests run
```
$ deno test supabase/functions/_shared/ --no-check
FAILED | 1107 passed | 20 failed (12s)
```
All 20 failures are **pre-existing** (verified by running on clean main — identical result). The 72 tests for new/modified modules all pass:
```
$ deno test impulseZoneEngine.test.ts zoneLiquidity.test.ts confirmationHierarchy.test.ts unifiedZoneEngine.test.ts --no-check
ok | 72 passed | 0 failed (544ms)
```

## Regression check
- Ran full test suite on clean `main` (stash/unstash): same 1107 passed / 20 failed
- Ran full test suite with changes: same 1107 passed / 20 failed
- Zero new failures introduced
- The unified engine is additive — it does not modify any existing gate logic, scoring, or trade decisions
- Existing `impulseZone` and `cascadeZone` outputs are produced identically

## Open questions
1. **When to wire gates to unified score?** Currently the unified engine is display-only. Once you confirm the panel looks correct in live scans, we can wire the gate system to use `unifiedScore` instead of (or in addition to) the standalone impulse zone score. This should be a separate task.
2. **Remove cascade panel?** The cascade panel still renders alongside the unified panel. Once you're satisfied the unified panel shows the same (or better) information, we can remove the cascade panel and engine.
3. **5m candle data for confirmation?** The confirmation hierarchy currently uses the candles passed to it (4H or 1H). For finer-grained CHoCH detection within zones, 5m data would help. Need to verify TwelveData availability.
4. **Sweep timeout default:** Set to 10 candles on the confirmation timeframe. May need tuning with backtest data.

## Suggested PR title and description

**Title:** feat: Unified Impulse Zone Engine (story-driven, continuation entries, liquidity + confirmation)

**Description:**
Implements the Unified Zone Engine that composes the impulse zone engine, liquidity detection, and confirmation hierarchy into a single story-driven system.

Key changes:
- Entry direction = impulse direction (continuation, "don't catch a falling knife")
- Daily → 4H → 1H waterfall (Daily wins when zone found)
- Liquidity: detects BSL/SSL near zone, scores sweeps (+1.0 to +3.0)
- Confirmation hierarchy: Sweep+CHoCH (2.5) > CHoCH (2.0) > Displacement (1.5) > Inducement (1.0)
- Unified scoring /14 (base + liquidity + confirmation + TF bonus)
- New frontend panel with progressive story bullets
- **Purely additive** — no behavior change to existing gates or trade decisions

This is Phase 1 (display-only). Phase 2 will wire gates to the unified score once validated in live scans.
