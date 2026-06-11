# System Redundancy Audit — Competing Sources for the Same Decision

## Executive Summary

The system has **7 decision domains** where multiple sources compete for the same answer. Each creates a "who wins?" ambiguity that makes the bot harder to reason about, debug, and tune.

| Domain | # of Competing Sources | Severity |
|--------|----------------------|----------|
| **1. Direction** | 6 sources | 🔴 Critical |
| **2. Entry Price** | 4 sources | 🟡 Medium |
| **3. Stop Loss** | 4 sources | 🟡 Medium |
| **4. Take Profit** | 3 sources | 🟢 Low (clean cascade) |
| **5. Position Sizing** | 5 multipliers | 🟡 Medium |
| **6. Session/Timing** | 4 overlapping filters | 🟡 Medium |
| **7. Confirmation** | 3 parallel systems | 🔴 Critical |

---

## 1. DIRECTION — 6 Competing Sources 🔴

This is the worst offender. See `DIRECTION_SOURCE_MAP.md` for the full breakdown.

| Source | Module | Role | Can Override? |
|--------|--------|------|---------------|
| confirmedTrend (fib-filtered MSBs) | `directionEngine.ts` | Primary spine | YES — sets direction |
| SimpleDirection (4H+1H CHoCH/BOS) | `directionEngine.ts` | Fallback if confirmedTrend fails | YES — overrides |
| Regime Classification (7 indicators) | `confluenceScoring.ts` | Gate 20 + score ±1.5 | BLOCKS or PENALIZES |
| Factor 22 (Daily Bias / HTF Trend) | `confluenceScoring.ts` | Score ±1.5 | PENALIZES |
| ICT HTF (Weekly bias) | `ictHTFIntegration.ts` | Currently OFF (info-only) | BLOCKS (if enabled) |
| Game Plan Bias (LLM-generated) | `gamePlan.ts` | Score ±0.75 + filter | PENALIZES + FILTERS |

**The conflict:** SimpleDirection says "long" → Regime says "strong bearish" → trade proceeds with penalty → may still pass gates → enters a losing trade against the macro trend.

**Where they touch the same decision:**
- Gate 1 (HTF Bias) checks regime confidence at 60% threshold
- Gate 20 (Regime Alignment) checks regime via tiered scoring
- Falling Knife Guard checks regime at 75% threshold
- Factor 22 checks daily BOS/CHoCH
- Game Plan filter checks LLM-generated session bias
- All of these are asking: "Should we trade this direction?"

---

## 2. ENTRY PRICE — 4 Competing Sources 🟡

| Source | Priority | Logic |
|--------|----------|-------|
| `computeLimitEntryPrice()` | Lowest | Nearest OB/FVG midpoint within 30 pips |
| Impulse Zone Engine | Medium | `izData.bestZone.refinedEntry` (OTE + S/R + LTF) |
| Cascade Zone Engine | High | `cascadeResult.entry` (Daily→4H→1H→15m story) |
| Unified Zone Engine | Highest | `unifiedZoneData.entry.entryPrice` (full story) |

**The conflict:** These are actually a clean priority cascade (each overrides the previous). The issue is that `computeLimitEntryPrice()` still runs even when it will be overridden, wasting computation. More importantly, the **base entry** (OB/FVG midpoint) uses a completely different methodology than the zone engines (which use Fib-ranked POIs with LTF refinement). If none of the zone engines fire, you fall back to a much simpler heuristic.

**Hidden issue:** When `marketFillAtZone` is enabled AND price is at zone, the limit entry cascade is bypassed entirely and market price is used. This creates a situation where the same pair can get wildly different entries depending on whether price happened to be at zone during the scan vs 5 minutes later.

---

## 3. STOP LOSS — 4 Competing Sources 🟡

| Source | Priority | Logic |
|--------|----------|-------|
| Confluence scoring (swing structure) | Lowest | Nearest swing high/low + buffer |
| Min/Max SL enforcement | Guard | Clamps to [minSlPips, maxSlPips] |
| Impulse Zone SL | Medium | Impulse origin ± buffer (only if wider than current) |
| Cascade Zone SL | High | Daily zone structure ± buffer |
| Unified Zone SL | Highest | Best TF impulse origin ± buffer |

**The conflict:** Each override only fires if it's WIDER than current SL (more protective). This means:
- If impulse SL is 50 pips but cascade SL is 30 pips, cascade won't override (it's tighter)
- But cascade is supposed to be "highest conviction" — why would we keep a wider SL from a lower-conviction source?
- The "only override if wider" rule was designed for safety but creates a bias toward wider stops

**Hidden issue:** The `impulseSlCapMultiplier` (default 4×) is shared across all three override sources. But a Daily impulse origin is naturally much wider than a 1H impulse origin. Using the same cap for both means the Daily override hits the cap more often.

---

## 4. TAKE PROFIT — 3 Sources (Clean Cascade) 🟢

| Source | Priority | Logic |
|--------|----------|-------|
| Base TP | Lowest | `entry + risk × tpRatio` |
| SL Override recalculation | Medium | When SL is overridden, TP is recalculated for same R:R |
| Regime-adaptive TP | Highest | `exitEngine.adjustTPForRegime()` — scales R:R by regime |

**Status:** This is actually well-designed. Each layer has a clear purpose and they compose cleanly. The only minor issue is that regime-adaptive TP can REDUCE the R:R below 1.0 in ranging markets (via `rangingRRMultiplier: 0.75`), which combined with spread means some trades are negative EV from entry.

---

## 5. POSITION SIZING — 5 Competing Multipliers 🟡

| Multiplier | Source | Range |
|------------|--------|-------|
| Base size | `computePositionSize()` (percent risk method) | Calculated |
| Volatility scaling | `unifiedPositionSizing.ts` (regime-aware) | 0.5x – 1.5x |
| Prop firm compliance | `propFirmRisk.ts` | 0.25x – 1.0x |
| Correlation advisory | `portfolioCorrelation.ts` | 0.5x – 1.0x |
| Signal source | Unified gate wiring | 0.5x or 1.0x |

**The conflict:** All multipliers are applied multiplicatively. In the worst case:
- High volatility (0.5x) × prop firm near limit (0.25x) × correlation (0.5x) × standalone (0.5x) = **0.03x** of base size
- This can produce 0.01 lot positions that are essentially meaningless after spread

**Hidden issue:** The prop firm gate also has its own size reduction logic (`propFirmSizeMultiplier`) that's separate from the prop firm context passed to `computePositionSize()`. These can double-count the same risk concern.

---

## 6. SESSION/TIMING — 4 Overlapping Filters 🟡

| Filter | Module | What it checks |
|--------|--------|----------------|
| Session Filter | `sessions.ts` | Is current time in allowed sessions? |
| Kill Zone Only | `ictKillZones.ts` | Is current time in ICT kill zone? |
| Opening Range | bot-scanner Gate 11 | Has OR period completed? |
| Session-Pair Affinity | `sessionAffinity.ts` | Is this pair good for this session? |

**The conflict:**
- Session Filter says "London is active" (02:00-08:30 NY)
- Kill Zone says "London KZ is 02:00-05:00" — after 05:00 you're in London session but NOT in kill zone
- Session-Pair Affinity says "EUR/USD is prime during London" — but which London? The full session or just the KZ?
- Opening Range says "wait until 06:00" — but KZ ends at 05:00, so you'd miss the best window

**Hidden issue:** The `killZoneOnly` config flag and the ICT Kill Zone gate mode are separate settings that can contradict each other. If `killZoneOnly: true` but `ictKillZoneGateMode: "off"`, the basic kill zone filter runs but the ICT-specific one doesn't.

---

## 7. CONFIRMATION — 3 Parallel Systems 🔴

| System | Module | When it runs | What it checks |
|--------|--------|--------------|----------------|
| Unified Confirmation Hierarchy | `confirmationHierarchy.ts` | During unified zone scoring | Sweep+CHoCH, LTF CHoCH, Displacement, Inducement |
| Zone Confirmation (5m) | `zoneConfirmation.ts` | After pending order placed | 5m CHoCH, engulfing, rejection, FVG, volume |
| Tick Zone Confirmation | `tickZoneConfirmation.ts` | Sub-5m during pending | Micro-structure, rejection, displacement, volume |

**The conflict:** The unified engine's confirmation hierarchy decides whether `entryReady = true` (which passes the unified gate). But SEPARATELY, if a pending order is placed, the zone confirmation scanner runs its own independent confirmation check. These two systems:
1. Use different candle data (unified uses 1H/15m, zone confirmation uses 5m)
2. Have different thresholds (unified needs sweep+CHoCH for top score, zone confirmation accepts Tier 3 reversal patterns)
3. Can disagree: unified says "confirmed" but zone confirmation says "not yet" (or vice versa)

**The real problem:** If unified gate passes (entryReady=true) and a market fill happens, zone confirmation never runs. But if unified gate fails and the trade goes through standalone path with a pending order, zone confirmation runs independently with its own logic. The same setup can get different treatment depending on which path it took.

---

## 8. BONUS: Risk Management — 3 Overlapping Systems

| System | Module | Scope |
|--------|--------|-------|
| Standard Gates (6, 7, 8, 15) | bot-scanner | Portfolio heat, daily loss %, max drawdown, dollar loss |
| Prop Firm Gate (Gate 0) | `propFirmGate.ts` + `propFirmRisk.ts` | Daily loss, max drawdown, profit target |
| ICT Risk Management | `ictRiskManagement.ts` | Drawdown halving, daily/weekly limits, consecutive losses |

**The conflict:** All three systems check daily loss and max drawdown, but with different:
- Calculation methods (% vs $ vs equity-based)
- Thresholds (Gate 7: configurable %, Prop Firm: FTMO rules, ICT: 1% daily)
- Consequences (Gate blocks trade, Prop Firm reduces size OR blocks, ICT halves risk)

When all three are active, a single losing trade triggers three different responses that may compound or contradict.

---

## Consolidation Recommendations

### Tier 1 — Consolidate Now (Biggest Impact)

| # | What | Proposed Solution |
|---|------|-------------------|
| 1 | **Direction** (6 sources → 1) | Single `DirectionVerdict` module. confirmedTrend = spine, regime = confidence modifier, weekly = veto-only. One gate, one score adjustment. |
| 2 | **Confirmation** (3 systems → 1) | Unified confirmation hierarchy becomes THE confirmation. Zone confirmation scanner calls into it instead of running parallel logic. Tick confirmation becomes a "fast path" within the same hierarchy. |

### Tier 2 — Simplify (Medium Impact)

| # | What | Proposed Solution |
|---|------|-------------------|
| 3 | **Session/Timing** (4 filters → 2) | Merge session filter + kill zone into one "trading window" concept. Session-Pair Affinity stays as a score modifier only (never blocks). |
| 4 | **Sizing multipliers** (5 → 3) | Combine volatility + signal source into one "conviction multiplier". Keep prop firm and correlation as separate safety layers. Add a floor (never below 0.1x base). |
| 5 | **Risk management** (3 systems → 1) | Prop firm gate subsumes standard gates when active (it's stricter). ICT risk management becomes a config preset for the prop firm system. |

### Tier 3 — Clean Up (Low Impact, Good Hygiene)

| # | What | Proposed Solution |
|---|------|-------------------|
| 6 | **SL override logic** | Change from "only override if wider" to "use the source with highest conviction" (unified > cascade > impulse > structure). Let each source set its own SL regardless of width. |
| 7 | **Entry price** | Remove `computeLimitEntryPrice()` entirely when any zone engine fires. It's a legacy fallback that produces worse entries. |

---

## Dependency Graph (What Blocks What)

```
Direction (1) ──→ Entry (2) ──→ SL (3) ──→ TP (4) ──→ Sizing (5)
     ↑                                                      ↑
     │                                                      │
Session (6) ─────────────────────────────────────────── Risk (8)
     │
     └──→ Confirmation (7) ──→ Entry (2)
```

Direction must be resolved FIRST because everything downstream depends on it. This is why the Direction consolidation is the highest priority.

---

## Implementation Order

If you want to tackle this incrementally:

1. **Direction Verdict** — build it, log it parallel for 1-2 weeks, then wire in
2. **Confirmation unification** — make zone confirmation call into confirmationHierarchy instead of running its own logic
3. **Session simplification** — merge the 4 timing concepts into 2
4. **Everything else** — sizing floor, SL conviction-based, risk management merge

Each step is independently valuable and doesn't require the others to be done first.
