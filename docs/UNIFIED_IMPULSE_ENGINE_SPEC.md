# Unified Impulse Zone Engine — Design Specification

## Overview

This document specifies the redesign of the impulse zone detection system into a **single unified engine** that tells the complete top-down story: from Daily impulse detection through liquidity sweep, confirmation, and continuation entry. The current separate "Cascade Zone Engine" and "Impulse Zone Engine" merge into one system with one panel, one score, and one narrative.

The fundamental shift: **this is a continuation engine, not a reversal engine.** The entry direction always matches the impulse direction. You are joining the move after a pullback to the zone — not fading it.

---

## Core Concept: The Continuation Trade

```
IMPULSE LEG (Daily/4H/1H):
  Price moves from A → B, breaking structure (BOS)
  This creates the impulse. Direction = bearish if A > B.

PULLBACK (retracement):
  Price retraces from B back toward A
  This is NOT a reversal — it's smart money accumulating

ZONE (the pullback target):
  FVG or OB created WITHIN the impulse leg
  Located at a Fib level (61.8%, 71%, 78.6%)
  This is where smart money re-enters

LIQUIDITY SWEEP:
  Price sweeps past the zone edge (takes stops)
  This is the "fuel" — trapped traders provide liquidity

CONFIRMATION:
  LTF structure shifts back in impulse direction
  CHoCH or displacement confirms the pullback is over

ENTRY:
  Continuation WITH the impulse direction
  Short if impulse was bearish, Long if impulse was bullish
  Target: impulse destination (BOS level) or extension
```

---

## Architecture: One Engine, Multiple Timeframes

The engine runs the SAME logic at every timeframe. The difference is scope and conviction:

| Timeframe | Impulse Source | Zone Source | Confirmation TF | Entry TF | Conviction |
|-----------|---------------|-------------|-----------------|----------|------------|
| **Daily** | Daily candles | Daily FVG/OB | 4H displacement or 1H CHoCH | 1H/15m | Maximum (A+) |
| **4H** | 4H candles | 4H FVG/OB | 1H CHoCH or 15m displacement | 15m/5m | High (B+) |
| **1H** | 1H candles | 1H FVG/OB | 15m CHoCH or 5m displacement | 5m | Standard (C+) |

**Daily always wins.** If a Daily impulse + zone exists, it takes priority. The 4H and 1H engines only fire when no Daily story is active (or as nested entry refinement within the Daily zone).

---

## The Unified Flow (Step by Step)

### Step 1: Find Impulse Leg (Top-Down)

Start from Daily, fall through to 4H, then 1H:

```typescript
function findImpulseLeg(candles: Candle[], direction: "bullish" | "bearish"): ImpulseLeg | null
```

**Rules:**
- Must have a valid BOS (close-based)
- Origin must not be broken (price hasn't closed past the start)
- No internal pullback > 50% of the impulse range (validates it's impulsive, not corrective)
- Most recent valid impulse wins

**Output:**
```typescript
{
  high: number;           // Swing high wick (Fib 1)
  low: number;            // Swing low wick (Fib 0)
  direction: "bullish" | "bearish";
  startIndex: number;     // Swing origin
  endIndex: number;       // BOS candle
  bosPrice: number;       // Structure break level
  startDate: string;      // ISO date
  endDate: string;        // ISO date
  spanBars: number;       // Duration
  timeframe: "D" | "4H" | "1H";  // Which TF produced this impulse
}
```

### Step 2: Map POIs Within the Impulse

Find all FVGs and OBs created DURING the impulse move:

```typescript
function mapImpulsePOIs(candles: Candle[], impulse: ImpulseLeg): ImpulsePOI[]
```

**Rules:**
- POI must be between `startIndex` and `endIndex`
- POI direction must match impulse direction (bearish OB = last bullish candle before the drop)
- Both FVGs and OBs are mapped

### Step 3: Overlay Fibonacci & Rank Zones

Draw Fib from impulse high (1.0) to impulse low (0.0). Score each POI:

| Fib Level | Score | Meaning |
|-----------|-------|---------|
| 78.6% | 2.0 | Deepest premium — highest conviction |
| 71.0% | 2.0 | OTE (Optimal Trade Entry) |
| 61.8% | 1.5 | Golden ratio — standard quality |
| 50.0% | 1.0 | Equilibrium — acceptable |
| 38.2% | 0.0 | Too shallow — tracked but no score |

### Step 4: Check Historical S/R

For each POI, check if the zone overlaps with historical support/resistance (close-based, line chart method):

```typescript
function checkHistoricalSR(candles: Candle[], zone: ImpulsePOI, lookback: number): boolean
```

**Score: +2.0 if S/R confirmed**

### Step 5: Detect Liquidity Pools Near the Zone

This is NEW. Before checking if price is at the zone, identify WHERE liquidity sits:

```typescript
interface LiquidityPool {
  type: "bsl" | "ssl";              // Buy-side or Sell-side liquidity
  level: number;                     // Price level
  source: "equal_highs" | "equal_lows" | "swing_high" | "swing_low" | "trendline";
  strength: number;                  // 1-3 (how many times tested)
  relativeToZone: "above" | "below" | "inside";
  distanceFromZone: number;          // In pips
}
```

**Detection logic:**
- **Equal highs/lows:** 2+ swing points at the same level (within tolerance)
- **Swing points:** Recent swing highs above the zone (BSL) or swing lows below (SSL)
- **Relative position:** Liquidity ABOVE a bearish zone = buy-side that will be swept before shorts enter

**Why this matters:** The sweep of this liquidity IS the confirmation that smart money is entering. It's not just "price at zone" — it's "price swept liquidity at zone, now continuing."

### Step 6: Price Proximity & Sweep Detection

```typescript
interface ProximityResult {
  atZone: boolean;              // Price within ATR threshold of zone
  insideZone: boolean;          // Price literally between zone.high and zone.low
  liquiditySwept: boolean;      // Price wicked past liquidity pool then closed back
  sweepDetails: SweepEvent | null;
  distancePips: number;
}

interface SweepEvent {
  sweptLevel: number;           // Which liquidity level was taken
  sweepType: "bsl" | "ssl";    // Buy-side or sell-side
  wickDepth: number;            // How far past the level (in pips)
  closedBack: boolean;          // Did price close back inside/past the level?
  candleIndex: number;
  quality: "clean" | "messy";   // Clean = single wick, Messy = multiple candles past
}
```

**Scoring:**
- Liquidity pool identified near zone: **+1.0**
- Liquidity swept (wick past + close back): **+1.5**
- Clean sweep (single candle, deep wick): **+0.5 bonus**

### Step 7: Confirmation Hierarchy

Once price is at/in the zone (and ideally after a liquidity sweep), look for confirmation that the pullback is OVER and the impulse is resuming:

```typescript
interface Confirmation {
  type: "ltf_choch" | "displacement" | "sweep_reclaim" | "inducement_taken";
  timeframe: "4H" | "1H" | "15m" | "5m";
  direction: "bullish" | "bearish";  // Must match impulse direction
  index: number;
  insideZone: boolean;
  quality: number;  // 1-3
}
```

**Confirmation types (ranked by conviction):**

| Rank | Type | Description | Score |
|------|------|-------------|-------|
| 1 | **Liquidity Sweep + CHoCH** | Price sweeps past zone, then CHoCH back in impulse direction | +2.5 |
| 2 | **LTF CHoCH** | 15m or 1H structure shifts back to impulse direction (close-based) | +2.0 |
| 3 | **Displacement** | Strong momentum candle (body >70%, range >1.5x ATR) in impulse direction | +1.5 |
| 4 | **Inducement Taken** | Minor swing inside zone gets swept, then price reverses | +1.0 |
| 5 | **None (price at zone only)** | No confirmation yet — watchlist only, do not enter | +0.0 |

**Rules:**
- Confirmation direction MUST match impulse direction
- CHoCH must be close-based (not wick-based)
- Displacement must occur while price is inside or exiting the zone
- Multiple confirmations stack (sweep + CHoCH = 2.5, not 1.5 + 2.0)

### Step 8: LTF Entry Refinement

Once confirmed, scale down to find the precise entry:

```typescript
function refineLTFEntry(
  entryCandles: Candle[],  // 15m or 5m
  zone: RankedPOI,
  direction: "bullish" | "bearish"
): { entry: number; sl: number; refined: boolean; ltfType: "ob" | "fvg" | null }
```

**Logic:**
- Find OB or FVG on 15m/5m INSIDE the zone bounds
- Entry = edge of the LTF POI (top of OB for shorts, bottom for longs)
- SL = beyond the zone high (for shorts) or zone low (for longs)
- If no LTF refinement found, use the zone edge itself

**Score: +1.0 if LTF refined**

### Step 9: HTF Confluence Check

Does a higher timeframe structure align with this zone?

- If zone is on 1H: check if 4H OB/FVG/Fib overlaps → **+1.5**
- If zone is on 4H: check if Daily OB/FVG/Fib overlaps → **+1.5**
- If zone is on Daily: automatic **+1.5** (it IS the HTF)

### Step 10: Compute Final Score

```
TOTAL SCORE (out of 14):
├── Fib Level:           0 – 2.0
├── S/R Confirmed:       0 or 2.0
├── Liquidity Pool:      0 or 1.0
├── Liquidity Swept:     0 or 1.5 (+0.5 clean bonus)
├── Confirmation:        0 – 2.5
├── LTF Refined:         0 or 1.0
├── HTF Confluence:      0 or 1.5
├── Impulse TF Bonus:    Daily +2.0, 4H +1.0, 1H +0.0
└── TOTAL:               0 – 14.0
```

**Gate thresholds:**
- **A+ setup (Daily impulse, score ≥ 10/14):** Full position size
- **B+ setup (4H impulse, score ≥ 8/14):** 75% position size
- **C+ setup (1H impulse, score ≥ 7/14):** 50% position size
- **Below threshold:** Watchlist only, do not enter

---

## The Story Output (Panel Display)

One panel. Progressive disclosure. Filled bullets = completed, empty = pending.

**Full story (A+ Daily setup, all steps complete):**
```
IMPULSE ZONE — Score 11.5/14 via Daily                    [A+ SETUP]
● Daily Impulse: ↓ BEARISH 155.60 → 160.71 (512 pips)
    BOS: 155.60  2026-04-15 → 2026-05-02 (12 bars)
● Zone: FVG @ Fib 61.8% (S/R ✓) [157.60–159.52]
● Liquidity: BSL @ 159.80 (equal highs) — SWEPT ✓
    Wick to 159.85, closed at 159.20 (clean sweep)
● Confirmation: 1H CHoCH (bearish) after sweep
● Entry: SHORT @ 158.30  SL: 159.90  TP: 155.60
    [15m OB refined] [R:R 4.2:1]
    Score: Fib 1.5 + S/R 2.0 + Liq 1.0 + Swept 2.0 + Conf 2.5 + LTF 1.0 + HTF 1.5 = 11.5/14
```

**Partial story (waiting for price):**
```
IMPULSE ZONE — Score 5.5/14 via Daily                     [WATCHLIST]
● Daily Impulse: ↓ BEARISH 155.60 → 160.71 (512 pips)
    BOS: 155.60  2026-04-15 → 2026-05-02 (12 bars)
● Zone: FVG @ Fib 61.8% (S/R ✓) [157.60–159.52]
● Liquidity: BSL @ 159.80 (equal highs) — not yet swept
○ Price: 83 pips away
○ Confirmation: Waiting
○ Entry: Not yet
```

**4H setup (no Daily story):**
```
IMPULSE ZONE — Score 8.0/14 via 4H                       [B+ SETUP]
● 4H Impulse: ↓ BEARISH 1.1518 → 1.1645 (127 pips)
    BOS: 1.1518  2026-06-05 → 2026-06-08 (6 bars)
● Zone: OB @ Fib 71.0% (S/R ✓) [1.1598–1.1612]
● Liquidity: BSL @ 1.1620 (swing high) — SWEPT ✓
● Confirmation: 15m displacement (bearish)
● Entry: SHORT @ 1.1605  SL: 1.1625  TP: 1.1518
    [No LTF refinement] [R:R 4.3:1]
```

---

## Direction Logic: Continuation, Not Reversal

This is the critical conceptual change from the current engine:

| Current Engine (reversal) | New Engine (continuation) |
|---------------------------|--------------------------|
| Bearish impulse → zone is DEMAND → look for LONGS | Bearish impulse → zone is SUPPLY → look for SHORTS |
| "Price retraces to zone, then reverses" | "Price retraces to zone, then CONTINUES the impulse" |
| Entry opposes impulse direction | Entry matches impulse direction |
| SL beyond zone (in impulse direction) | SL beyond zone (against impulse direction) |
| TP at impulse origin | TP at BOS level or extension |

**Wait — this needs clarification.** The zone created by a bearish impulse is:
- The last BULLISH candle before the drop (OB) = supply zone
- The FVG left behind during the drop = imbalance to fill

When price PULLS BACK UP into this zone, it's retracing. The entry is SHORT (continuation of the bearish impulse). The zone acts as supply — smart money sells here to push price back down.

```
Bearish impulse: price drops from 160.71 to 155.60
Zone: FVG at Fib 61.8% [157.60–159.52] (created during the drop)
Price retraces UP to 158.50 (inside the zone)
Liquidity swept: wicks above 159.52 (takes buy stops)
CHoCH: 1H makes lower-low (bearish structure shift)
Entry: SHORT @ 158.30 (continuation of the bearish impulse)
SL: 159.90 (above the zone + sweep wick)
TP: 155.60 (BOS level — where the impulse ended)
```

---

## What Happens to the Cascade Engine

The cascade engine (`cascadeZoneEngine.ts`) gets **deprecated**. Its useful logic is absorbed:

| Cascade Feature | Where It Goes |
|-----------------|---------------|
| Daily impulse detection | `findImpulseLeg()` now accepts Daily candles |
| Daily zone finding | `mapImpulsePOIs()` + `rankZones()` on Daily candles |
| `checkPriceAtDailyZone()` | Merged into unified `checkProximity()` |
| `detect4HConfirmation()` | Merged into unified `detectConfirmation()` hierarchy |
| `detect1HConfirmation()` | Merged into unified `detectConfirmation()` hierarchy |
| State machine (waiting_for_price, etc.) | Replaced by progressive story output (filled/empty bullets) |
| Separate panel | Removed — one panel shows everything |

The `dailyImpulseOB.ts` module (Daily displacement + OB detection) remains as a helper that the unified engine calls when processing Daily timeframe.

---

## What Happens to the Existing Modules

| Module | Status | Notes |
|--------|--------|-------|
| `impulseZoneEngine.ts` | **EXTENDED** | Add Daily TF support, liquidity, confirmation hierarchy |
| `cascadeZoneEngine.ts` | **DEPRECATED** | Logic absorbed into unified engine |
| `dailyImpulseOB.ts` | **KEPT** | Used as helper for Daily displacement detection |
| `ictJudasSwing.ts` | **KEPT** | Used for liquidity sweep detection |
| `inducementDetection.ts` | **KEPT** | Used for inducement confirmation type |
| `CascadeZonePanel.tsx` | **REMOVED** | Replaced by enhanced ImpulseZonePanel |

---

## Existing Scoring (Current /11) vs New Scoring (/14)

| Factor | Current Score | New Score | Change |
|--------|--------------|-----------|--------|
| Fib Level | 0–2.0 | 0–2.0 | Same |
| S/R Confirmed | 0 or 2.0 | 0 or 2.0 | Same |
| HTF Confluence | 0–1.5 | 0–1.5 | Same |
| LTF Refined | 0 or 1.0 | 0 or 1.0 | Same |
| Fib bonus (>78.6%) | 0–0.5 | Removed (absorbed into Fib Level) | Simplified |
| OB alignment | 0–0.5 | Removed (OBs scored same as FVGs) | Simplified |
| **Liquidity Pool** | — | 0 or 1.0 | **NEW** |
| **Liquidity Swept** | — | 0–2.0 | **NEW** |
| **Confirmation** | — | 0–2.5 | **NEW** |
| **Impulse TF Bonus** | — | 0–2.0 | **NEW** |
| **TOTAL** | /11 | /14 | Extended |

---

## Multi-Timeframe Selection (Revised)

The current `findBestEntryZoneMultiTF` runs 1H and 4H in parallel and picks the best. The new version adds Daily as the primary and uses a **waterfall** approach:

```
1. Check Daily candles → findImpulseLeg(dailyCandles, direction)
   - If Daily impulse found:
     → This is the PRIMARY story
     → Zone = Daily FVG/OB within the impulse
     → Confirmation = 4H displacement or 1H CHoCH
     → Entry refinement = 1H/15m zone within Daily zone bounds
     → Impulse TF Bonus = +2.0
     → DONE (don't check 4H/1H as primary)

2. If no Daily impulse:
   Check 4H candles → findImpulseLeg(h4Candles, direction)
   - If 4H impulse found:
     → This is the PRIMARY story
     → Zone = 4H FVG/OB within the impulse
     → Confirmation = 1H CHoCH or 15m displacement
     → Entry refinement = 15m zone within 4H zone bounds
     → Impulse TF Bonus = +1.0
     → DONE

3. If no 4H impulse:
   Check 1H candles → findImpulseLeg(h1Candles, direction)
   - If 1H impulse found:
     → Zone = 1H FVG/OB within the impulse
     → Confirmation = 15m CHoCH or 5m displacement
     → Entry refinement = 5m zone within 1H zone bounds
     → Impulse TF Bonus = +0.0
     → DONE

4. If no impulse on any TF:
   → SKIP this pair entirely (no trade without impulse)
```

---

## Stop Loss & Take Profit

**Stop Loss:**
- Always beyond the zone boundary on the OPPOSITE side of the impulse
- For bearish continuation (short): SL above zone high (+ buffer of 0.5 × ATR)
- For bullish continuation (long): SL below zone low (- buffer of 0.5 × ATR)
- If liquidity was swept: SL above the sweep wick (gives extra room)
- Configurable SL cap for large-impulse instruments (Gold, BTC)

**Take Profit:**
- Primary TP: BOS level (where the impulse broke structure)
- Extended TP: -27.2% Fib extension of the impulse
- Partial close at 1:1 R:R, trail remainder

---

## Entry Direction Validation

Before entering, validate that the entry direction doesn't conflict with higher timeframe bias:

```
IF impulse is on 4H:
  → Check Daily regime. If Daily is STRONGLY opposite → reject or reduce size
  → If Daily is neutral/mild → proceed

IF impulse is on 1H:
  → Check 4H regime. If 4H is STRONGLY opposite → reject
  → Check Daily regime. If Daily is STRONGLY opposite → reject
  → If both neutral/aligned → proceed

IF impulse is on Daily:
  → No higher check needed (Daily IS the highest)
  → Always proceed (maximum conviction)
```

---

## Implementation Plan

### Phase 1: Extend `findImpulseLeg` to accept Daily candles
- Add `timeframe` parameter to the function
- Return `timeframe` in the result
- No behavior change for existing 1H/4H usage

### Phase 2: Add liquidity pool detection
- New function: `detectLiquidityPools(candles, zone, lookback)`
- Integrate with existing `ictJudasSwing.ts` for sweep detection
- Add to scoring

### Phase 3: Add confirmation hierarchy
- New function: `detectConfirmation(candles, zone, direction, confirmationTF)`
- Absorb logic from `cascadeZoneEngine.detect4HConfirmation` and `detect1HConfirmation`
- Add sweep+CHoCH combo detection
- Add inducement confirmation type

### Phase 4: Restructure `findBestEntryZoneMultiTF` as waterfall
- Daily → 4H → 1H priority
- Single result with full story metadata
- Progressive state (which steps are complete)

### Phase 5: Unify the panel
- Merge CascadeZonePanel into ImpulseZonePanel
- One panel, one story, progressive bullets
- Remove cascade panel from UI

### Phase 6: Update bot-scanner integration
- Remove separate cascade engine call
- Single call to unified engine
- Update gate logic to use new /14 scoring

---

## Open Questions for User

1. **Direction confirmation:** You said "continuation entry" — does this mean the current engine's direction logic is WRONG? Currently it enters AGAINST the impulse (reversal). Should ALL entries now be WITH the impulse? Or should both be options (configurable)?

2. **Minimum R:R:** With continuation entries targeting the BOS level, R:R depends on where in the zone you enter. What's the minimum acceptable R:R? Currently it's 3:1.

3. **Multiple zones in one impulse:** If a Daily impulse has 3 FVGs at different Fib levels, do we still pick Zone 1 (deepest/best) only? Or set limit orders at multiple zones?

4. **Sweep timeout:** How long after a liquidity sweep is it still valid as confirmation? (e.g., if BSL was swept 20 candles ago but CHoCH just happened now — still valid?)

5. **5m data availability:** The confirmation hierarchy mentions 5m CHoCH for 1H impulses. Is 5m candle data available from MetaApi/TwelveData for all 16 pairs?

---

## Summary

The unified engine tells ONE story per pair:

> "There is a [Daily/4H/1H] bearish impulse. Price has pulled back to a [FVG/OB] at Fib [61.8/71/78.6]%. [Liquidity was swept / not yet]. [Confirmation fired / waiting]. Entry: [SHORT/LONG] at [price], SL at [price], targeting [BOS level]."

No separate systems. No conflicting signals. One engine, one score, one decision.
