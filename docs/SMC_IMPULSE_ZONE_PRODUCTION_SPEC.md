# SMC IMPULSE ZONE SYSTEM V1 — PRODUCTION SPEC

Reverse-engineered from current `main`, 2026-09-28. Traced from actual callers,
not filenames. Live style is **scalper** (`bot_configs.config_json.tradingStyle.mode`).

Audit only — nothing here changed production behaviour.

---

## 1. THE ONE ZONE CALL, AND ITS TWO VIEWS

There is exactly **one** zone computation per pair per scan:

```
bot-scanner:5423   decideZone(...)                        _shared/smcZoneDecision.ts
  └─ :202          findUnifiedZone(...)                   _shared/unifiedZoneEngine.ts
       └─ Step 1   findBestEntryZoneMultiTF(...)          _shared/impulseZoneEngine.ts:1503
          Steps 2-10: impulse story, zone story, price story, zoneLiquidity,
                      confirmationHierarchy, unified score, STATE, EntryStory
```

Its result is written to `detail` twice, and the rest of the scanner reads
**both views as if they were separate engines**:

| view | assigned | read as |
|---|---|---|
| `detail.unifiedZone` | `zoneDecision.unifiedZone` | `unifiedZoneData` (:6067) |
| `detail.impulseZone` | `zoneDecision.impulseZone` (derived from `multiTFResult`, back-compat for 58 call sites) | `izData` (:6092, :5668) |

`findUnifiedZone` is **not** an independent engine — Step 1 is the same
`findBestEntryZoneMultiTF` the legacy path used. It adds liquidity,
confirmation, scoring, the state machine and the EntryStory on top.

**Consequence that matters:** the market-fill decision reads `izData`
(`priceAtZoneStrict`, `sideOk`) while the entry *price* comes from
`unifiedZoneData.entry.entryPrice`. Two views of one result govern two halves
of the same order.

### Other zone-ish engines

| engine | call site | status for LIVE (scalper) |
|---|---|---|
| `cascadeZoneEngine.findCascadeZone` | :5597 | **INACTIVE** — gated `resolvedStyle === "swing_trader"` |
| `structuralOrderBlockRunner.runStructuralOrderBlocks` | :5366 | **SHADOW** — "Nothing consumes this. Displaying it is allowed; acting on it is not" |
| `zoneConfirmation.detectZoneConfirmation` | :3901 | **ACTIVE**, but only inside the pending-order loop |
| ICT modules (HTF, MSS, Judas, FVG-inval, killzone, risk) | :5662–5915 | log-only in "off" mode (6 blocks) |

---

## 2. TWO PHASES, NOT ONE

`runScanForUser` (:2205–8683) has two distinct decision phases. They are
frequently conflated and they are not the same code.

**PHASE A — pending-order management (:3440–4204).** Runs BEFORE any scanning.
Operates on rows already in `pending_orders`.

```
:3512  SL invalidation
:3568  thesis re-validation
:3692  ZONE CONFIRMATION ENTRY STATE MACHINE
:3708    Branch A  status "pending"              -> did price touch the zone?
:3800    Branch B  status "awaiting_confirmation" -> isImpulseBroken? classifyZoneExit?
:3901                                               detectZoneConfirmation (the CHoCH hunt)
:3926                                               Tier gate: Tier 1 required when no refined zone
```

**PHASE B — fresh scan (:4650–8450).** direction → HTF context → zone → gates →
route selection → execution.

The CHoCH hunt lives **only** in Phase A. A fresh scan never waits for a CHoCH;
it either market-fills or writes a pending order for Phase A to hunt later.

---

## 3. GATE ORDER (Phase B)

```
:5987  DIRECTION VERDICT                 computeDirectionVerdict
:6062  UNIFIED ZONE GATE
         swing_trader + cascade "triggered" + priceAtEntry -> signalSource "cascade"
         unifiedZoneData.hasZone
           && state ∈ {triggered, confirmed}
           && confirmation.entryReady === true            -> signalSource "unified"
         else                                             -> signalSource "standalone"
:6086  IMPULSE ZONE GATE (izGateMode, default "hard")
         unifiedGatePassed        -> bypass, +impulseZoneBonus
         requireUnifiedZone       -> skip pair ("skipped_require_unified")
         hard && !izData.hasZone  -> skip ("skipped_no_impulse_zone")
         hard && !priceAtZone     -> "watching_zone" + INSERT staged_setups
:6186  ZONE SCORE GATE            totalScore < minZoneScore (default 4) -> "skipped_weak_zone"
:6204+ Tier-1 / P-D-Fib / confluence-stack / HTF-POI credits
:6503  bidirectional conflict counter
:6712  game plan gate    :6769 news gate
:6827  SL floors, zone SL overrides, TP adjust, min-TP gate
:7151  portfolio correlation (advisory)   :7196 sizing
:7317  ROUTE SELECTION
```

---

## 4. ROUTE SELECTION (:7317–7404) — the decisive block

**Entry price, last writer wins:**

1. `computeLimitEntryPrice` (legacy OB/FVG) — only if no zone engine overrides
2. `izData.bestZone.refinedEntry` → `IZ-<TYPE>` (izGateMode hard)
3. `izData.bestZone` midpoint → `IZ-<TYPE>` (fallback)
4. **`unifiedZoneData.entry.entryPrice` → `UNIFIED-<TF>` — highest priority**

**Market fill:**

```
strictZone            = izData.bestZone.priceAtZoneStrict === true
sideOk                = izData.bestZone.sideOk === true
priceIsAtValidatedZone= izGateMode === "hard" && strictZone && sideOk
priceOnCorrectSide    = Layer 3, price within 2x zone width of the near edge
useMarketFillAtZone   = priceIsAtValidatedZone && config.marketFillAtZone && priceOnCorrectSide
```

**Limit route:**

```
effectiveLimitEnabled = !useMarketFillAtZone
                        && (config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry))
```

This is why a setup can be LIMIT while `limitOrderEnabled=false`: the second
clause auto-enables it whenever the hard gate produced any `limitEntry`. With
live defaults (`limitOrderEnabled` false, `izGateMode` "hard"), **the limit
route is on by default for every zone where price is not strictly at the zone.**

**Routes are mutually exclusive by construction** — `effectiveLimitEnabled`
negates `useMarketFillAtZone`. There is no dedup problem because only one
branch can be taken.

---

## 5. STATE MACHINES

### Zone state — `unifiedZoneEngine` :393–401, RECOMPUTED every scan, not persisted

| state | condition |
|---|---|
| `no_zone` | `!multiTFResult.bestZone` |
| `watching` | `!bestZone.priceAtZone` |
| `at_zone` | at zone, no entry-ready confirmation, `requireConfirmation` **true** (default) |
| `confirmed` | as above but `requireConfirmation` false, OR entry-ready and not strict |
| `triggered` | entry-ready confirmation **and** `priceAtZoneStrict` |

`EntryStory` is built **only** for `confirmed` / `triggered` (Step 9).

### Pending-order status — PERSISTED in `pending_orders`

`pending` → `awaiting_confirmation` → `triggered`/`filled`, or
→ `invalidated` / `expired` / `cancelled`.

---

## 6. CONFIRMATION — two independent systems

**A. `confirmationHierarchy.evaluateConfirmation`** — inside the zone engine,
sets `entryReady`, which is what the unified gate requires:

| type | score | entryReady |
|---|---|---|
| `sweep_choch` | 2.5 | **true** |
| `ltf_choch` | 2.0 | **true** |
| `displacement` | 1.5 | **true** |
| `inducement` | 1.0 | **false** |
| sweep rejected, no CHoCH | 1.0 | **false** |
| none | 0 | false |

UI renders `(partial)` when `score > 0 && !entryReady` (`unifiedZoneEngine:648`).

**B. `zoneConfirmation.detectZoneConfirmation`** — Phase A only. Types:
`bullish/bearish_choch`, `*_choch_relaxed`, `*_reversal_pattern`. Config:
`confirmationTimeframe "5m"`, `minDisplacement 0.4`, `requireCloseBased true`,
`maxLookbackCandles 10`, `resetOnZoneExit true`, tiers 1–3 enabled.

---

## 7. GATE SCORE X/9 — `RankedPOI.totalScore`

`totalScore = fibScore + srConfirmed(+1) + ltfRefined(+1) + htfConfluenceScore`

| component | value |
|---|---|
| `fibScore` | 1.0/0.886/0.786/0.71 → **2**; 0.618 → 1.5; 0.5 → 1; 0.382 → 0 |
| `srConfirmed` | +1 (≥ `SR_MIN_TOUCHES` = 2 historical touches) |
| `ltfRefined` | +1 (LTF OB/FVG found inside; also yields `refinedEntry`/`refinedSL`) |
| `4H_OB` | +1 (not broken/mitigated, overlaps zone) |
| `4H_FVG` | +1 (not filled, overlaps) |
| `4H_BREAKER` | +1 (isActive, not broken, overlaps) |
| `HTF_FIB` / `D1_FIB` | + best fib score |
| `PD_ALIGNED` | +0.5 |

Gate: `totalScore >= minZoneScore` (default **4**). Passing it does **not**
authorise entry — it only admits the setup to the credit/confluence stages.

Zone selection floor: `zones.find(z => z.fibScore >= 1)` — a zone must be at
50% retracement or deeper to be eligible at all.

---

## 8. FIBONACCI

Levels checked: `FIB_LEVELS_BASE = [0.786, 0.71, 0.618, 0.5, 0.382]` plus
`extraLevels`. Tolerance `FIB_TOLERANCE_FRACTION = 0.03` of impulse range.
"OB @ Fib 71.0%" means the POI's price band falls within 3% of the impulse
range of the 0.71 retracement. The UI's 23.6/38.2/50/61.8/70.5/79 ladder
(`:167`) is a **separate display** list and is not the scoring set.

Fib contributes to scoring **and** rejection (`fibScore >= 1` floor).

---

## 9. LIQUIDITY / INDUCEMENT

`zoneLiquidity.findZoneLiquidity` → `nearbyPools[]` (relevance-ranked,
`entry_trigger` subset), `sweepEvent`, `inducement`, `liquidityScore`.
Inducement from `inducementDetection.detectInducements`, types `minor_swing |
equal_level | trendline | session_sweep`.

Quality is **out of 10**: displacement 3, confirmed reversal 2, dwell
(1 candle 2 / 2 candles 1), deep sweep 1, not-too-deep 1, recent swing 1.

"Inducement minor_swing, quality 6/10, 2 pools" = a minor swing high/low was
swept and reclaimed near the zone, scoring 6 of 10 on that ladder, with 2
liquidity pools within range. It contributes `score 1.0` and
**`entryReady: false`** — it can never authorise entry by itself.

---

## 10. SL / TP

`EntryStory.slPrice` / `tpPrice` are explicitly **not** what gets traded; the
engine's own comment says to use `executable`. `executable.slPrice` is floored
by `minSlPips`; `executable.tpPrice` is entry ± risk × `tpRatio`.

Scanner floors (:6827): two-layer `max(staticFloorPips, atrFloorPips)`.
`staticFloorPips` = `cfg.minStopPips` override else `MIN_SL_PIPS[pair]` else 15.
`ATR_SL_FLOOR_MULTIPLIER = 1.5`, but `atrForConsumers` is gated on
`atrDerivedFloorsEnabled === true` — **absent from live config, so the ATR
layer contributes zero and only the static floor binds.**

Route-specific overrides, applied in order: Impulse Zone SL (:6871),
Unified Zone SL (:6950), Cascade SL (:6976, swing only), Zone-Anchored Stop
(:7002, flag `zoneAnchoredStop`, default OFF).

---

## 11. CLOSED-BAR vs INTRABAR

`analysis.lastPrice = candles[candles.length - 1].close` (`smcAnalysis:2295`).
The last provider candle is the **forming** bar, so `lastPrice` is the forming
bar's running close — a scan-time value, not a closed-bar close.

Everything downstream that compares against price is therefore intrabar:
`priceAtZone`, `priceAtZoneStrict`, `sideOk`, Layer-3 buffer, market-fill.
Structure/BOS/CHoCH/impulse/OB/FVG are computed from the same array and so
include the forming bar.

`zoneConfirmation` is the exception: `requireCloseBased: true`.

---

## 12. PERSISTENCE

| state | where |
|---|---|
| pending order, its status, zone bounds, impulse | **DB** `pending_orders` |
| watchlisted setup | **DB** `staged_setups` (TTL, scalper capped 120 min) |
| game plan | **DB** `scan_logs`, cached per session + `gamePlanRefreshHours` |
| thesis conviction | `kv_cache` |
| scan inputs / decision provenance | `smc_scan_bars`, `_manifest`, `_context`, `_decision` |
| **zone identity, zone state, confirmation state, EntryStory, invalidation, previous touch** | **NOT PERSISTED — recomputed every scan** |

There are **zero** occurrences of `zone_id`/`zoneId` in `bot-scanner`. A zone
has no durable identity, and if the engine re-derives it next scan it is a new
object with no memory that it was ever invalidated.

The one exception: once a pending order exists, that order row freezes the
zone's geometry — `entry_zone_low/high`, `refined_zone_low/high`,
`frozen_strategy_context` — so Phase A hunts against a snapshot taken at
order-creation time, not against a freshly recomputed zone. Zone state is
therefore durable **only for the lifetime of a pending order**, and only as
bounds, never as identity.

---

# CLOSURE ADDENDUM — SMC_IMPULSE_ZONE_ARCHITECTURE_CLOSURE_V1

Closes the five paths left unresolved by the first audit.

## 13. CONFLUENCE — the fourth, separate score

`runConfluenceAnalysis(candles, dailyCandles, pairConfig, hourlyCandles, atMs?)`
— bot-scanner:4984, `_shared/confluenceScoring.ts:274`. Note it accepts an
`atMs` historical-evaluation parameter, so it is injectable for replay.

25 weighted factors, `DEFAULT_FACTOR_WEIGHTS` (:61), **32.5 raw points total**,
emitted as a **percentage**:

| factor | w | factor | w | factor | w |
|---|---|---|---|---|---|
| marketStructure | 2.5 | htfFibPdLiquidity | 2.5 | orderBlock | 2.0 |
| fairValueGap | 2.0 | premiumDiscountFib | 2.0 | htfPoiAlignment | 2.0 |
| sessionQuality | 1.5 | reversalCandle | 1.5 | liquiditySweep | 1.5 |
| unicornModel | 1.5 | currencyStrength | 1.5 | confluenceStack | 1.5 |
| sessionAffinity | 1.5 | pdPwLevels | 1.0 | displacement | 1.0 |
| breakerBlock | 1.0 | smtDivergence | 1.0 | amdPhase | 1.0 |
| dailyBias | 1.0 | gamePlanKeyLevel | 1.0 | judasSwing | 0.75 |
| volumeProfile | 0.75 | pullbackHealth | 0.5 | | |

### The FOUR scores are unrelated scales — do not conflate

| score | scale | source | gate |
|---|---|---|---|
| **Confluence Score** | **%** of 32.5 pts | `runConfluenceAnalysis` | `strategy.confluenceThreshold = 40` (live) |
| **Zone Story Score** | **/14** | `unifiedZoneEngine` `unifiedScore` | none directly; display + logs |
| **Gate Score** | **/9** | `RankedPOI.totalScore` | `minZoneScore = 4` |
| **Direction** | verdict + confidence % | `computeDirectionVerdict` | Gate 1 |

`effectiveScore = analysis.score + fotsiPenalty + impulseZonePenaltyVal`, then
compared against `minConfluence`. The zone scores feed it only through the
**credit** stages (:6204–6447), which add Tier-1 / P-D-Fib / stack / HTF-POI
points — they never gate directly.

## 14. THE 22 SAFETY GATES — `runSafetyGates` (:1384)

Execution order, with absolute lines. **Numbering is not execution order**:
Gate 22 runs before 19–21, and the label "Gate 4" is used twice.

| # | Gate | Line | Blocks | Stateful | Replayable |
|---|---|---|---|---|---|
| 1 | Direction Verdict | 1395 | YES | no | YES |
| 2 | Premium/Discount filter | 1454 | YES | no | YES |
| 3 | Structural Conviction | 1506 | YES | no | YES |
| 3b | Reaction Confirmation (ranging) | 1548 | YES | no | YES |
| 4a | Instrument enabled | 1578 | YES | config | YES |
| 4b | Max open positions | 1585 | YES | **YES** | NO |
| 5 | Max per symbol + same-direction dup | 1592 | YES | **YES** | NO |
| 6 | Portfolio heat | 1603 | YES | **YES** | NO |
| 7 | Daily loss limit | 1628 | YES | **YES** | NO |
| 8 | Max drawdown | 1646 | YES | **YES** | NO |
| 9 | Min confluence | 1661 | YES | no | YES |
| 9b | SMT Opposite Veto | 1668 | YES | no | YES |
| 10 | Min R:R (spread+commission adj) | 1678 | YES | broker | partial |
| 11 | Opening Range completion | 1704 | YES | clock | YES |
| 12 | Kill Zone Only | 1720 | YES | clock | YES |
| 13 | Cooldown | 1742 | YES | **YES** | NO |
| 14 | Max Consecutive Losses (+4h reset) | 1759 | YES | **YES** | NO |
| 15 | Dollar daily loss (net P&L) | 1788 | YES | **YES** | NO |
| 16 | News Event Filter | 1804 | YES | **YES** | NO |
| 17 | FOTSI OB/OS | 1843 | penalty | feed | partial |
| 18 | ATR Volatility Filter | 1873 | YES | no | YES |
| 22 | Correlation Filter | 1894 | YES | **YES** | NO |
| 19 | Tier 1 Minimum (≥2 core factors) | 2006 | YES | no | YES |
| 20 | Regime Alignment | 2018 | subsumed by G1 | no | YES |
| 21 | Spread Quality | 2032 | **NO — info only** | broker | no |

**13 of 24 are market-derivable and replayable; 10 require account/portfolio
state that is not persisted; 1 never blocks.**

## 15. PHASE A STATE MACHINE — proven transitions

| from | to | condition | line | price basis | reversible |
|---|---|---|---|---|---|
| `pending` | `awaiting_confirmation` | price touched zone | 3759 | forming | — |
| `awaiting_confirmation` | `cancelled` | `isImpulseBroken` | 3806 | forming | no |
| `awaiting_confirmation` | **`pending`** | `resetsHunt` — price left zone, `confirmation_attempts++` | 3854 | forming | **YES — the one reversal** |
| `awaiting_confirmation` | `cancelled` | tier gate / other | 3955 | forming | no |
| `awaiting_confirmation` | `filled` | `detectZoneConfirmation` returns a signal | 4087 | **closed** (`requireCloseBased`) | no |
| any | `invalidated` | SL breach | 3512 | **closed bar** via `lastClosedCandle` | no |
| any | `expired` | `expires_at` | — | clock | no |

`confirmation_attempts` counts **abandonments, not hunts** — the code says so
explicitly. Reading it as hunting activity inverts its meaning.

## 16. computeLimitEntryPrice IS DEAD IN PRODUCTION

Line 1 of the body: `if (!config.limitOrderEnabled) return null;`
Live `limitOrderEnabled` = **false** (default, not overridden). It returns
null on every live call. Proven by data flow, not inference.

**Consequence — the route tree collapses to a clean binary.** With legacy
always null, `limitEntry` comes only from the zone overrides, and with
`izGateMode="hard"` the midpoint fallback guarantees a non-null `limitEntry`
whenever a `bestZone` exists. So:

```
effectiveLimitEnabled = !useMarketFillAtZone && (false || (true && true))
                      = !useMarketFillAtZone
```

**Exactly two live routes. No third, no overlap, no dedup problem.**

## 17. PRICE-AT-ZONE — resolved, with data

```
priceInsideZone   = price >= zoneLow && price <= zoneHigh
priceAtZone       = insideZone || |price - edge| <= looseThreshold   (1.5x ATR)
sideOk            = true, unless price is beyond the far edge by > strictThreshold
priceAtZoneStrict = insideZone ? TRUE (unconditional, :1389-1391)
                               : (nearStrict && sideOk)              (0.3x ATR)
```

**`priceInsideZone` implies `priceAtZoneStrict`.** Measured over 513 real
historical zone observations across 7 pairs: **0 violations.**

| combination | share |
|---|---|
| inside=F strict=F loose=F sideOk=F | 56.3% |
| inside=F strict=F loose=T sideOk=F | 20.3% |
| inside=T strict=T loose=T sideOk=T | 11.5% |
| inside=F strict=T loose=T sideOk=T | 6.6% |
| inside=F strict=F loose=T sideOk=T | 2.9% |
| inside=F strict=F loose=F sideOk=T | 2.3% |

## 18. UI / EXECUTOR — the divergence is NOT where the first audit guessed

Badge condition is `priceInsideZone || priceAtZoneStrict`, which collapses to
`priceAtZoneStrict`. Market-fill arming is `priceAtZoneStrict && sideOk`.

| | share of 513 |
|---|---|
| BOTH_IDLE | 81.9% |
| BADGE_AND_EXEC_BOTH_ARMED | 18.1% |
| BADGE_ON_EXEC_OFF | **0** |
| BADGE_OFF_EXEC_ON | **0** |

**The badge and the executor agree 100% of the time.** The first audit
speculated they read different flags; they do not.

The real divergence is the **story line**: `EXEC_ARMED_BUT_ENTRY_STORY_NULL`
occurred in **39 of 513** observations = **41.9% of all armed cases**. In those,
the panel prints `Entry: Not yet` (EntryStory is null because state is
`at_zone`) while market fill is armed and will enter on the next scan.

So the misleading surfaces are: (a) the badge *wording* — "Hunting 5m CHoCH"
when the system is armed to enter **without** a CHoCH; and (b) `Entry: Not yet`
in 42% of armed cases.

## 19. FORMING-BAR SEMANTICS

`lastClosedCandle` exists and documents the problem precisely — but it has
**exactly ONE caller in all of production**: bot-scanner:3525, the pending-order
SL-invalidation check. `grep` for other callers returns nothing.

Everything else reads `candles[last]`, the **forming** bar:
impulse, zone, BOS/CHoCH, FVG, OB, `priceAtZone*`, `sideOk`, Layer 3,
confluence, and the market-fill price itself.

## 20. MARKET-FILL EXECUTION PRICE — frozen

```
bot-scanner:7664   const marketEntryPrice = analysis.lastPrice;
                   // "Market orders ALWAYS fill at current price"
```

`analysis.lastPrice = candles[last].close` = the **forming 5m bar's running
close at scan instant**.

**The unified `entry.entryPrice` does NOT set the market fill price.** It sets
the pending-order price only (`entry_price: limitEntry.price`, :7557). The two
routes therefore enter at different prices by construction.

| route | entry price |
|---|---|
| MARKET FILL AT ZONE | `analysis.lastPrice` (forming-bar close at scan) |
| PENDING LIMIT | `limitEntry.price` = unified `entry.entryPrice`, else zone refined entry, else zone midpoint |

## 21. FINAL ROUTE SPEC — exactly two

**ROUTE 1 — DIRECT MARKET FILL AT ZONE**
Condition `izGateMode==="hard" && priceAtZoneStrict && sideOk && Layer3 && marketFillAtZone`.
No confirmation, no CHoCH, no EntryStory required. Entry `analysis.lastPrice`.
SL/TP from scanner overrides. Order: market. No expiry. Invalidation: n/a (immediate).

**ROUTE 2 — PENDING LIMIT + PHASE-A CONFIRMATION**
Condition `!useMarketFillAtZone && limitEntry != null` (always true when a zone
exists under the hard gate). Entry `limitEntry.price`. Order: pending limit,
`stylePendingExpiryMinutes`. Confirmation **required** in Phase A
(`detectZoneConfirmation`, close-based). Invalidation: impulse break, zone exit
(→ reverts to `pending`), SL breach (closed-bar), expiry. **Persisted.**

Cascade is a third route in code but `swing_trader`-gated → inactive live.

## 22. REPLAYABILITY

| route / component | class | why |
|---|---|---|
| Zone, impulse, Fib, Gate/9, liquidity, confluence | **A — exactly replayable** | pure OHLC prefixes; `runConfluenceAnalysis` even takes `atMs` |
| `priceAtZone*`, `sideOk`, Layer 3 | **B — 1m proxy** | need the forming-bar close at scan instant; 1m approximates it |
| ROUTE 1 market fill | **B — 1m proxy** | entry is forming-bar close; exact value not persisted |
| ROUTE 2 pending lifecycle | **D — not replayable** | needs `pending_orders` history; statuses/timestamps not reconstructable |
| 10 stateful safety gates | **C — simulated state only** | balance, heat, cooldown, losses, news, correlation not persisted |
| Zone invalidation / previous touch | **D** | no zone identity (0 `zone_id`) |
