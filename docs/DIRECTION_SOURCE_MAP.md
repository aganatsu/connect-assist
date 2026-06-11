# Direction Source Map — Full Inventory

## The Problem

Right now, **6 separate systems** have an opinion on "which way should we trade?" — and they interact in complex, sometimes contradictory ways. This document maps every touch point and proposes consolidation into a single `DirectionVerdict`.

---

## Current Direction Sources (in execution order)

### 1. SimpleDirection Engine (`directionEngine.ts`)
**When:** Called BEFORE confluenceScoring, result stored as `_overrideDirection`
**What it does:** ICT top-down flow: Daily bias → 4H confirms (retrace, no CHoCH) → 1H confirms (BOS in bias direction)
**Outputs:**
- `direction: "long" | "short" | null`
- `bias: "bullish" | "bearish" | null` (which TF set it)
- `biasSource: "daily" | "4h" | null`
- `h4Retrace`, `h4ChochAgainst`, `h1Confirmed`

**Uses internally:** `confirmedTrend()` (fib-extension-filtered MSBs on Daily) as primary bias source. Falls back to raw daily `analyzeMarketStructure().trend`.

**Impact:** When it returns a direction, it OVERRIDES the old confluenceScoring direction logic entirely. When it returns null, confluenceScoring falls through to its own logic.

---

### 2. ConfluenceScoring Internal Direction (`confluenceScoring.ts` line 519-600)
**When:** Only fires if `_overrideDirection` is NOT set (i.e., simpleDirection threw an error or wasn't called)
**What it does:** Structure Authority hierarchy:
1. Entry-TF fractal balance (leading indicator)
2. HTF daily structure (BOS-confirmed)
3. P/D zone mean-reversion (last resort, guarded by falling knife)

**Impact:** Sets `analysis.direction` which flows to everything downstream.

---

### 3. Regime Classification (`classifyInstrumentRegime` in smcAnalysis.ts)
**When:** Computed early in confluenceScoring (before Factor 4)
**What it does:** 7-indicator check on Daily candles: EMA crossovers, ADX, ATR trend, Bollinger width, fractal density, swing structure, momentum
**Outputs:**
- `regime: "strong_trend" | "mild_trend" | "choppy_range" | "mild_range" | "transitional"`
- `confidence: 0-1`
- `directionalBias: "bullish" | "bearish" | "neutral"`
- `atrTrend: "expanding" | "contracting" | "stable"`
- `transition: { state, confidence, momentum }`

**Impact (multiple touch points):**
| Touch Point | Effect | Strength |
|---|---|---|
| Falling knife guard (confluenceScoring) | Blocks P/D mean-reversion when regime ≥75% opposes | HARD BLOCK (direction = null) |
| Gate 1: HTF Bias (bot-scanner) | When daily is "ranging", regime ≥60% opposing → block | HARD BLOCK |
| Gate 20: Regime Alignment (tieredScoring) | When effective adjustment < -1.0 → gate fails | HARD BLOCK |
| Regime scoring adjustment (confluenceScoring) | +0.5 aligned strong trend, -1.5 opposing strong trend | SCORE ±0.25 to ±1.5 |
| Multi-TF alignment (4H vs Daily regime) | ±0.15 modifier on regime adjustment | SCORE ±0.15 |

---

### 4. ICT HTF Analysis (`ictHTFIntegration.ts`)
**When:** Called AFTER confluenceScoring, uses `analysis.direction`
**What it does:** Weekly candle bias + Daily impulse + containment check (LTF zone inside Daily OB)
**Outputs:**
- `weeklyBias: { bias, confidence }`
- `dailyImpulse: { direction, high, low, bosPrice }`
- `containment: { contained, overlap% }`
- `scoreAdjustment: +2.0 aligned / -3.0 misaligned`
- `passed: boolean`

**Impact:**
| Mode | Effect |
|---|---|
| `"off"` (DEFAULT) | Log only, no trade impact |
| `"soft"` | Score adjustment ±2.0/3.0 |
| `"hard"` | Block trade entirely if weekly opposes |

**Current default: OFF** — so this is currently informational only.

---

### 5. Game Plan Bias (`gamePlan.ts`)
**When:** Generated per-session (every 4h), applied during scoring
**What it does:** LLM-generated premarket analysis combining structure + DOL + news + zone context
**Outputs:**
- `bias: "bullish" | "bearish" | "neutral"`
- `biasConfidence: 0-100`
- `dol: { description, price }`
- `regime: string`
- `tradeable: boolean`

**Impact:**
| Touch Point | Effect | Strength |
|---|---|---|
| GP Bias Confidence scoring (confluenceScoring) | +0.5 aligned (≥70% conf) / -0.75 opposing (≥70% conf) | SCORE ±0.25 to ±0.75 |
| GP Filter gate (bot-scanner) | INFO-ONLY (legacy gate converted to soft scoring) | NONE (just logs) |
| News Impact Alignment gate (bot-scanner) | Blocks when news strongly conflicts (strength ≥40) | HARD BLOCK |

---

### 6. Unified Zone Engine Direction (`unifiedZoneEngine.ts`)
**When:** Called AFTER confluenceScoring, receives `analysis.direction` converted to bullish/bearish
**What it does:** Entry direction = impulse direction (continuation). Finds Daily→4H→1H impulse leg, direction is ALWAYS the impulse direction.
**Outputs:** `direction` field on the entry story (always matches the impulse it found)

**Impact:** With the new unified gate wiring, when unified engine is ready (state=triggered/confirmed + entryReady), it provides entry/SL overrides. Direction itself comes FROM `analysis.direction` — it doesn't generate its own.

---

## Where They Contradict

| Scenario | What happens |
|---|---|
| SimpleDirection says "long" but Regime says strong bearish (90%) | Trade proceeds (SimpleDirection overrides), but regime scoring applies -1.5 penalty, Gate 20 may block |
| SimpleDirection says "long" but ICT HTF weekly says bearish | Currently nothing (ICT HTF is "off"). If turned to "hard", would block. |
| SimpleDirection says "long" but Game Plan says bearish (80% conf) | Trade proceeds with -0.75 score penalty |
| Daily structure is ranging, fractals balanced, P/D says "long" but regime is 70% bearish | Falling knife guard does NOT fire (needs 75%). Gate 1 does NOT fire (needs 60% + opposing). Trade proceeds into a bearish regime. |
| SimpleDirection says null (no trade) but Game Plan says bullish (90%) | No trade — SimpleDirection null is final. |
| Cascade zone says bullish impulse but SimpleDirection says short | Cascade receives direction from analysis.direction (short), so it won't find a bullish cascade zone. No conflict. |

---

## Redundancy Analysis

| What's being measured | Sources that measure it | Overlap |
|---|---|---|
| "Is daily trending?" | SimpleDirection (confirmedTrend), Regime (EMA/ADX/structure), ICT HTF (weekly bias), Game Plan (LLM analysis) | **4 sources** |
| "Is 4H confirming?" | SimpleDirection (h4Retrace, h4ChochAgainst), ConfluenceScoring (Factor 1 BOS/CHoCH) | **2 sources** |
| "Is entry-TF aligned?" | SimpleDirection (h1Confirmed), ConfluenceScoring (Factor 1 trend alignment) | **2 sources** |
| "Should we trade in this regime?" | Regime gate (Gate 20), Regime scoring, Falling knife guard, Gate 1 HTF bias | **4 checks** |

---

## Proposal: Single `DirectionVerdict`

### Architecture

```
┌─────────────────────────────────────────────────┐
│              DirectionVerdict                     │
│                                                  │
│  Input: Daily candles, 4H candles, 1H candles   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │ Layer 1: STRUCTURAL SPINE (leading)       │   │
│  │  confirmedTrend (Daily fib-MSBs)          │   │
│  │  → primary bias                           │   │
│  └──────────────────────────────────────────┘   │
│                    ↓                             │
│  ┌──────────────────────────────────────────┐   │
│  │ Layer 2: CONFIRMATION (structural)        │   │
│  │  4H retrace + no CHoCH against            │   │
│  │  1H BOS in bias direction                 │   │
│  │  → confirms or downgrades confidence      │   │
│  └──────────────────────────────────────────┘   │
│                    ↓                             │
│  ┌──────────────────────────────────────────┐   │
│  │ Layer 3: CONTEXT (lagging, advisory)      │   │
│  │  Regime classification → confidence mod   │   │
│  │  Weekly candle bias → confidence mod      │   │
│  │  → can REDUCE confidence, never flip dir  │   │
│  └──────────────────────────────────────────┘   │
│                    ↓                             │
│  Output:                                         │
│    verdict: "long" | "short" | "neutral"         │
│    confidence: 0-100                             │
│    sources: { spine, confirmation, context }     │
│    veto: null | "falling_knife" | "regime_block" │
│                                                  │
└─────────────────────────────────────────────────┘
```

### What gets consolidated

| Current Source | Becomes | Role |
|---|---|---|
| SimpleDirection (confirmedTrend) | Layer 1: Spine | Primary direction generator |
| SimpleDirection (4H retrace/CHoCH, 1H BOS) | Layer 2: Confirmation | Confirms or reduces confidence |
| Regime classification | Layer 3: Context | Reduces confidence if opposing (never flips) |
| ICT HTF weekly bias | Layer 3: Context | Reduces confidence if opposing (never flips) |
| Game Plan bias | **REMOVED from direction** | Stays as score modifier only (it's LLM-generated, too noisy for direction) |
| ConfluenceScoring internal direction | **REMOVED** | Fully replaced by DirectionVerdict |

### What gets removed from gates

| Current Gate | Proposed |
|---|---|
| Gate 1: HTF Bias Alignment | **REMOVE** — absorbed into DirectionVerdict Layer 3 |
| Gate 20: Regime Alignment | **REMOVE** — absorbed into DirectionVerdict Layer 3 |
| Falling knife guard | **REMOVE** — absorbed into DirectionVerdict veto |
| ICT HTF hard gate | **REMOVE** — absorbed into DirectionVerdict Layer 3 |
| GP Filter gate | **KEEP** as info-only (already is) |
| News gate | **KEEP** as-is (event-driven, not structural) |

### Single gate replacement

One new gate: **DirectionVerdict Gate**
- `verdict === "neutral"` → no trade (skip pair)
- `confidence < 40` → no trade (too uncertain)
- `confidence 40-60` → trade allowed, 0.5× size multiplier
- `confidence > 60` → full size

### Benefits

1. **One place to look** — `detail.directionVerdict` tells the full story
2. **No contradictions** — spine sets direction, context can only reduce confidence
3. **Fewer gates** — removes 4 gates that currently overlap/contradict
4. **Clearer sizing** — confidence maps directly to position size
5. **Easier debugging** — "why did it go long?" has one answer, not six

---

## What I Recommend Based on Code Analysis

**The SimpleDirection engine (confirmedTrend + 4H/1H confirmation) is already the strongest signal.** It uses:
- Fib-extension-filtered MSBs (not just any swing break)
- Close-based confirmation (not wick-based)
- Strict alternation enforcement
- 4H retrace validation (no CHoCH against)
- 1H BOS confirmation

The regime and ICT HTF are **lagging indicators** (EMAs, ADX, weekly candles) that should never override structural price action. They should only reduce confidence.

The Game Plan is **LLM-generated** — useful for context but too noisy to be a direction source. Keep it as a score modifier.

---

## Implementation Estimate

- **New file:** `_shared/directionVerdict.ts` (~150 lines)
- **Modify:** `bot-scanner/index.ts` — replace 4 gate sections with 1 DirectionVerdict gate
- **Modify:** `confluenceScoring.ts` — remove internal direction logic, accept verdict as input
- **Remove:** Nothing deleted (old code stays as dead code for rollback safety)
- **Tests:** ~20 new tests for the verdict logic
- **Risk:** Medium — changes direction determination for all trades

---

## Open Question

Should I build this? It's a meaningful refactor that simplifies the system but touches live trade decisions. The conservative path is:
1. Build `directionVerdict.ts` as a parallel computation (like unified engine was)
2. Log it alongside existing direction for 1-2 weeks
3. Compare: does the verdict agree with the current system? Where does it disagree? Are disagreements better or worse?
4. Then wire it in as the primary source

This is the same pattern we used for the unified engine — build → observe → wire.
