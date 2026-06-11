# RFC: Consolidate Zone Engines into Single Narrative

**Branch:** `manus/consolidate-zone-engines`  
**Status:** Draft — awaiting approval before implementation  
**Author:** Manus AI  
**Date:** 2026-06-11

---

## Problem Statement

The bot currently runs **two independent zone detection engines** that can disagree on which impulse is active and which zone should trigger a trade:

| Engine | File | Impulse Source | Candles Used | Role in Trade Decision |
|--------|------|---------------|--------------|----------------------|
| Impulse Zone | `impulseZoneEngine.ts` | Finds own impulse | 1H + 4H only | **Primary gate** (hard mode blocks trades) |
| Unified Zone | `unifiedZoneEngine.ts` | Finds own impulse | D + 4H + 1H | Override only (needs confirmation.entryReady) |

The **root cause** of the disagreement is simple: the impulse zone engine call at line 4088 of `bot-scanner/index.ts` does **not** pass `dailyCandles` — it only receives 1H and 4H candles. The unified engine receives Daily candles and correctly prefers the Daily impulse when available. This means:

- The impulse zone engine finds a 1H or 4H impulse (smaller, nearer)
- The unified zone engine finds the Daily impulse (larger, higher conviction)
- The frontend shows **two different impulses** and **two different zones** — confusing the user
- The trade gate checks the 1H/4H impulse while the Daily impulse (the correct one per the user's methodology) is only advisory

The user's trading methodology is clear: **the story starts from the Daily impulse leg**. Within that leg, find the best POI (OB/FVG) ranked by confluence (Fib + S/R + HTF alignment + LTF refinement). That single zone is the trade idea.

---

## Proposed Solution

**Remove the separate impulse zone engine call. Use the unified zone engine as the single source of truth.** The unified engine already calls `findBestEntryZoneMultiTF()` internally (which is the impulse zone engine's multi-TF function), so all the zone-finding logic is preserved — it just gets the Daily candles it was missing.

### Architecture Change

```
BEFORE (two parallel calls):
┌─────────────────────────────────────────────────────┐
│ bot-scanner per-pair loop                            │
│                                                      │
│  ① findBestEntryZoneMultiTF(1H, 4H, 15m)           │  ← No daily!
│     → detail.impulseZone                             │
│     → izData (used by gate logic, 58 references)    │
│                                                      │
│  ② findUnifiedZone(1H, 4H, 15m, Daily, liquidity)  │  ← Has daily
│     → detail.unifiedZone                             │
│     → unifiedGatePassed (override only)             │
│                                                      │
│  Gate: izData.hasZone + izData.bestZone.priceAtZone │
└─────────────────────────────────────────────────────┘

AFTER (single call):
┌─────────────────────────────────────────────────────┐
│ bot-scanner per-pair loop                            │
│                                                      │
│  ① findUnifiedZone(1H, 4H, 15m, Daily, liquidity)  │
│     → detail.unifiedZone (full story)               │
│     → izData (derived from unifiedResult.multiTF)   │
│     → Gate: same logic (hasZone + priceAtZone)      │
│                                                      │
│  Frontend: ONE panel telling the full story          │
│    Impulse → Zone → Price → Liquidity → Confirm     │
└─────────────────────────────────────────────────────┘
```

### What Changes

| Component | Change | Risk |
|-----------|--------|------|
| `bot-scanner/index.ts` | Remove separate `findBestEntryZoneMultiTF` call; derive `izData` from unified result's `multiTFResult.bestZone` | Medium — 58 references to `izData` must still work |
| `bot-scanner/index.ts` | Remove `unifiedGatePassed` bypass logic (no longer needed — unified IS the gate) | Low — simplification |
| `bot-scanner/index.ts` | `detail.impulseZone` populated from unified result (backward-compatible shape) | Low — same data, different source |
| `BotView.tsx` (frontend) | Replace two panels (ImpulseZonePanel + UnifiedZonePanel) with one narrative panel | Low — display only |
| `unifiedZoneEngine.ts` | No changes needed | None |
| `impulseZoneEngine.ts` | No changes needed (still called internally by unified engine) | None |

### What Stays the Same

- All zone-finding logic (OB detection, FVG detection, Fib overlay, S/R check, LTF refinement, ranking)
- The hard gate behavior: no zone → skip; zone exists but price not there → watchlist; price at zone → proceed
- Zone score gate (minZoneScore threshold)
- Tier 1 credit logic (impulse-zone-confirmed factors)
- SL calculation (impulse origin)
- Entry price (zone edge or LTF refined entry)
- Watchlist/staging behavior
- All 58 `izData.*` field accesses (we'll populate the same shape from unified result)

---

## Implementation Plan

### Step 1: Derive `izData` from Unified Result

The unified engine returns `multiTFResult: MultiTFZoneResult` which contains exactly the same data as the current separate call. We extract it:

```typescript
// BEFORE:
const zoneResult = findBestEntryZoneMultiTF(hourlyCandles, h4Candles, candles, dir, price, htfData, opts);
(detail as any).impulseZone = { hasZone: !!zoneResult.bestZone, ... };

// AFTER:
const unifiedResult = findUnifiedZone(...); // already called
const zoneResult = unifiedResult.multiTFResult; // same type!
(detail as any).impulseZone = { hasZone: !!zoneResult.bestZone, ... }; // same shape
```

### Step 2: Remove Redundant Unified Gate Bypass

Currently, when `unifiedGatePassed`, the code bypasses the impulse zone gate. After consolidation, the unified result IS the impulse zone result, so there's no bypass needed — the gate logic applies directly to the unified output.

### Step 3: Merge Frontend Panels

Replace the separate `ImpulseZonePanel` + `UnifiedZonePanel` with a single `ZoneStoryPanel` that renders the full narrative:

```
┌─────────────────────────────────────────────────┐
│ 📍 Zone Story                          via D    │
│                                                  │
│ ● D Impulse: ↓ BEARISH 59073 → 78015 (1894 p) │
│   BOS: 59073  2026-05-26 → 2026-06-05 (10 bars)│
│                                                  │
│ ● Zone: FVG @ Fib 71.0% (S/R ✓)               │
│   [71315–73288] [HTF: D1_FIB_50.0]             │
│                                                  │
│ ○ Price: 87570 pips away                        │
│                                                  │
│ ● Liquidity: BSL @ 74157 (3 touches) (6 pools) │
│                                                  │
│ ○ Confirmation: Waiting for CHoCH/displacement  │
│                                                  │
│ ○ Entry: Not yet                                │
│                                                  │
│ Base: 3.5/9  Liq: +1.0  TF: +2.0  = 6.5/14   │
└─────────────────────────────────────────────────┘
```

This is already the format that `unifiedZoneEngine.ts` produces in its `storySummary` field.

---

## Behavior Changes

1. **The impulse zone gate will now consider Daily impulses** (previously only 1H/4H). This means:
   - Pairs that previously had "no impulse" on 1H/4H but DO have a Daily impulse will now show a zone (more pairs watchlisted)
   - Pairs where the Daily zone is far from current price will be watchlisted instead of skipped
   - This is the **intended** behavior per the user's methodology

2. **Zone scores may change** because the Daily impulse produces different POIs than the 1H impulse. The scoring logic is identical, but the input data (which candles, which impulse range) changes.

3. **Entry prices may change** for pairs where the Daily zone differs from the 1H zone. The entry will be at the Daily zone's POI edge instead of the 1H zone's POI edge.

4. **No change to pairs without Daily data** — they still fall back to 4H → 1H (same as before).

---

## Regression Safety

- The unified engine already calls the same `findBestEntryZoneMultiTF` function internally
- All zone scoring, ranking, and proximity logic is unchanged
- The gate conditions (hasZone, priceAtZone, totalScore >= minZoneScore) are unchanged
- We'll write a regression test that feeds the same 1H/4H candles (no Daily) and verifies identical output

---

## Open Questions

1. **Cascade Zone Engine**: Should it also be removed/merged? Currently it's a third engine with its own state machine. For this RFC, I propose leaving it as-is (it's already behind a config flag `cascadeZoneMode`). We can deprecate it in a follow-up.

2. **Confirmation gating**: Currently the unified gate requires `confirmation.entryReady` to override. In the consolidated version, should confirmation be:
   - (a) Required for entry (strict — current unified behavior)
   - (b) Optional bonus that improves score but doesn't block (recommended — matches current impulse gate behavior)
   - (c) Configurable per pair

---

## Approval Requested

Before implementing, please confirm:
1. Is the approach correct (use unified as single source, derive izData from it)?
2. Should confirmation remain optional (not block trades)?
3. Any concerns about the behavior changes listed above?
