# SMC Zone / Impulse engine — frozen baseline specification

**Stage 1 control document. Describes CURRENT PRODUCTION BEHAVIOUR ONLY.
Nothing in this programme has changed production; no rule below was written by
choice, every one was read out of the deployed code.**

| | |
|---|---|
| repository commit | `8530eef4` (branch point of `research/smc-zone-impulse-stage1`) |
| strategy version | none declared — the zone engine carries **no version constant** (§10) |
| production style observed | **`scalper`** — read from `scan_logs.activeStyle`, not assumed |
| candle provider observed | **Twelve Data, 100%** (`sourceBreakdown` metaapi 0 / polygon 0) |
| observation window | 2026-09-15 02:06Z → 2026-09-24 10:55Z, 2,997 scans, 12 pairs |

> **The brief's assumed configuration was wrong, and this is the first finding.**
> Daily bias → 4H structure → 1H confirmation is the `day_trader` path. Production
> runs `scalper`, so the zone engine's three slots are **1H / 15m / 5m** and the
> entry timeframe is **5m**. Every threshold below is evaluated on those series.

---

## 1. Execution graph — the real path

`supabase/functions/bot-scanner/index.ts`, per pair, per 5-minute cron tick.

| # | module · function | in | out | blocks? | scores? | TF |
|---|---|---|---|---|---|---|
| 1 | `candleSource.fetchCandlesWithFallback` | symbol, interval | candles + `source` | no | no | 5m·15m·1h·4h·1d·1w |
| 2 | `directionEngine.determineDirectionStyleAware` | 1H/15m/5m | `long`/`short`/`null` | **YES** — null direction ends the pair | no | 1H→15m→5m |
| 3 | `directionVerdict.computeDirectionVerdict` | 5 sources | verdict + confidence | **YES** — Gate 1 | yes | composite |
| 4 | `unifiedZoneEngine.findUnifiedZone` | 5m, 15m, 1H, dir, price | `UnifiedZoneResult` | no *(pure)* | yes | 1H/15m/5m |
| 4a | ↳ `impulseZoneEngine.findBestEntryZoneMultiTF` | per-slot candles | `MultiTFZoneResult` | no | yes | all three |
| 4b | ↳ `findImpulseLeg` → `validateImpulseFromBOS` | candles, dir | `ImpulseLeg\|null` | no | no | per slot |
| 4c | ↳ `mapImpulsePOIs` | candles, impulse | `ImpulsePOI[]` | no | no | per slot |
| 4d | ↳ `overlayFibOnPOIs` | impulse, POIs | `RankedPOI[]` | **filters** by Fib band | yes | per slot |
| 4e | ↳ `zoneLiquidity.analyzeZoneLiquidity` | zone, pools | score + sweep | no | yes | D+4H+1H pools |
| 4f | ↳ `zoneConfirmation.evaluateConfirmation` | 15m, 5m, zone | `entryReady` | **gates state** | yes | 15m/5m |
| 5 | **Unified gate** (scanner) | `state`, `entryReady` | pass/fail | **YES** | no | — |
| 6 | **Impulse Zone gate** (`hard`) | `hasZone`, `priceAtZone` | pass / watchlist / skip | **YES** | ±1.0 | — |
| 7 | **Zone Score gate** | `totalScore` vs `minZoneScore` | pass/skip | **YES** | no | — |
| 8 | `confluenceScoring.runConfluenceAnalysis` | everything | score, factors | **YES** (threshold) | yes | entry TF |
| 9 | `ictHTFIntegration.runICTHTFAnalysis` | weekly, daily | pass + adj | soft by default | yes | W/D |
| 10 | SL/TP + **Unified Zone SL Override** | zone entry story | sl, tp | no | no | — |
| 11 | `unifiedPositionSizing` · `propFirmGate` | risk | size / block | **YES** | no | — |
| 12 | paper-trading / broker execute | order | fill | **YES** | no | — |

**Zone-engine core = rows 4–7.** Rows 2–3 and 8–12 are downstream SMC filters.
That separation is the point of the programme: rows 4–7 are the thing under test.

---

## 2. Impulse decision tree — `impulseZoneEngine.ts`

### 2.1 `findImpulseLeg(candles, direction, timeframe)` — L302

| # | condition | rule | threshold | effect | source |
|---|---|---|---|---|---|
| I1 | history | `candles.length < 20` → `null` | **20 bars** | hard reject | L307 |
| I2 | structure | `analyzeMarketStructure(candles)` over the whole array | — | input | L309 |
| I3 | break set | BOS ∪ CHoCH, **filtered to `b.type === direction`**, sorted newest-first | — | hard reject if empty | L311–319 |
| I4 | iteration | try each same-direction break newest→oldest until one validates | — | first valid wins | L323 |
| I5 | enrichment | sequence, fib levels, candle quality, span, dates | — | metadata only | L330–376 |

There is **no ATR threshold, no directional-candle-ratio gate, no body-dominance
gate, no path-efficiency gate and no overlap gate** anywhere in the accept/reject
path. Those quantities are *measured* (§2.3) and attached as metadata; not one of
them can reject a leg. Several were named in the brief as live rules. They are not.

### 2.2 `validateImpulseFromBOS(candles, bos, direction, swingPoints)` — L555

| # | condition | rule | threshold | effect | source |
|---|---|---|---|---|---|
| V1 | origin type | bullish → swing **low**; bearish → swing **high** | — | — | L566 |
| V2 | origin search | swings of that type with `index < bosIdx`, newest-first | — | reject if none | L569–577 |
| V3 | candidates tried | **first 5 only** | `slice(0, 5)` | silently caps | L580 |
| V4 | minimum span | `endIdx - startIdx < 3` → next candidate | **3 bars** | reject | L584 |
| V5 | geometry | high/low = extreme **wicks** over `[startIdx, endIdx]` | wick, not body | — | L587–594 |
| V6 | range | `impulseRange <= 0` → next candidate | — | reject | L597 |
| V7 | **origin not broken** | for `j = endIdx+1 … candles.length-1`: bullish rejects on `close < originPrice`, bearish on `close > originPrice` | **close-based** | `isValid=false` → reject unless `allowBrokenOrigin` | **L598–610** |

**V7 is the whole acceptance test, and it is the causal fault line.** It scans
from the BOS to the **end of the array**. Live that is "now"; in a whole-series
replay it is the future. See the audit, §1H.

`checkNoPullbackExceeds50` — the 50% internal-pullback rule — **was removed** and
the code says so at L631. Any description asserting it is out of date.

### 2.3 `measureLegDisplacement` — L496 (metadata only)

Baseline = the **20 bars before the leg**; needs ≥5 (`return undefined` otherwise).

```
displacement candle  :=  body/avgBody >= 2.0  AND  bodyRatio >= 0.7  AND  range/avgRange >= 1.5
displacementRatio    :=  displacementCandles / countedCandles
strength = "strong"   if displacementRatio >= 0.25 OR maxRangeMultiple >= 3.0
         = "moderate" if displacementRatio >= 0.10 OR maxRangeMultiple >= 2.0
         = "weak"     otherwise
```

Used for `sequence.displacementTrend` and reporting. **Never blocks.**

### 2.4 `enumerateImpulseLegs` — L407

Walks **every** BOS/CHoCH instead of stopping at the first valid leg, collapsing
breaks that share an origin. Used by the **V2 structural order-block engine only**
(shadow mode). Not on the live zone path.

---

## 3. Zone creation — `mapImpulsePOIs` L649

Requires `impulse.isValid`; returns `[]` otherwise. Slice = `[startIndex, endIndex]`.

| zone type | detected on | inclusion rule | geometry | source |
|---|---|---|---|---|
| **FVG** | the impulse slice only | `fvg.type === impulse.direction` **and** `state !== "filled"` | gap high/low | L666–693 |
| **OB** | `[start − 10, end]` — a 10-bar lookback | direction match, `state ∉ {broken, mitigated}`, index ≤ `endIndex`, price overlaps the impulse range | candle high/low, **full wick** | L670–716 |
| **origin OB** *(opt-in)* | ±5 bars around the origin | last opposing candle; searches backward first, then forward | candle high/low | L722–766 |

- **Proximal / distal edges are not separately modelled.** A zone is `{high, low}`;
  which edge is proximal is decided later by direction in `buildEntryStory`.
- **OB lifecycle is frozen at the impulse end.** `detectOrderBlocks` runs on
  `candles.slice(obStart, endIndex+1)`, so mitigation or breakage occurring
  *after* the impulse is never applied. This is the opposite of lookahead — the
  engine under-reads later information — and is recorded in the audit.

### 3.1 Fib filter — `overlayFibOnPOIs` L785

The only structural filter between POI and zone: a POI must sit in the
retracement band **0.5 → `fibMaxRetracement` (default 0.786)**, with the
`originOBRetest` option widening it. Fib is anchored to the impulse **wicks**
(high = 1, low = 0). Depth drives the score.

### 3.2 Zone score (0–9) and selection

`rankAndSelectBestZone` L1205 picks the highest `totalScore`. Contributors:
Fib depth, S/R confirmation (`checkHistoricalSR`), HTF confluence layers
(`checkHTFConfluence`), LTF refinement (`refineLowerTF`).

`findBestEntryZoneMultiTF` L1503 runs all three slots and selects across them.
Observed selection: **1H 3,184 · 15m 355 · 5m 308 · D 3** of 3,850.

---

## 4. Zone lifecycle — the production state machine

There is **no persistent zone object and no stored zone lifecycle.** The engine
is *stateless and recomputed from scratch every scan*. The only states that exist
are the six values of `UnifiedState` (`unifiedZoneEngine.ts` L80), derived fresh
each tick:

| state | trigger | source |
|---|---|---|
| `no_impulse` | no valid leg on any slot | L455 |
| `no_zone` | leg exists, no POI survives the Fib band | `buildNoZoneResult` |
| `watching` | zone exists, `!bestZone.priceAtZone` | L396 |
| `at_zone` | `priceAtZone` **and** (`!confirmation.entryReady`) **and** `requireConfirmation` | L398 |
| `confirmed` | `entryReady` and **not** `priceAtZoneStrict` | L400 |
| `triggered` | `entryReady` **and** `priceAtZoneStrict` | L400 |

**Every transition is reversible**, because nothing is stored: a zone that was
`triggered` last tick and whose origin has since been closed through simply
ceases to exist on the next scan, with no `INVALIDATED` event recorded anywhere.

Consequences, all of them findings rather than criticisms:

- **There is no `DETECTED`, `MITIGATED`, `FILLED`, `BROKEN`, `EXPIRED` or
  `TRADED` state.** The brief's candidate list does not exist in production.
- **There is no max-age or expiry rule** on a zone.
- **Mitigation and invalidation are not tracked.** A zone's survival is re-derived
  each scan from `originBroken` (§2.2 V7) and the OB/FVG `state` frozen at
  impulse end (§3).
- `staged_setups` (`setup_type: "impulse_zone_watch"`, TTL 60 min default, style
  scaled) is the **only** persistence, and it stores a watchlist entry, not a zone.

### 4.1 Proximity — `findBestEntryZone` L1350

```
priceInsideZone   : low <= price <= high
priceAtZone       : inside OR within looseThreshold of either edge
sideOk            : long  -> price above high only if within strictThreshold
                    short -> price below low   only if within strictThreshold
priceAtZoneStrict : inside OR (within strictThreshold AND sideOk)
strictThreshold   = strictATRMult (default 0.3) x ATR
```

---

## 5. Entry, stop, target — `buildEntryStory` L460

Built **only** when state is `confirmed` or `triggered`.

```
zoneWidth = zone.high - zone.low
depth     = entryDepth if 0..1 else 1          // DEFAULT 1 = far edge

LONG   entry = zone.high - zoneWidth * depth   // depth 1 -> zone.low
       sl    = zone.low  - zoneWidth * 0.5     // capped at impulse.low
SHORT  entry = zone.low  + zoneWidth * depth   // depth 1 -> zone.high
       sl    = zone.high + zoneWidth * 0.5     // capped at impulse.high

tp        = impulse.bosPrice                   // the BOS level, NOT an R multiple
rrRatio   = |entry-tp| / |entry-sl|
if rrRatio < minRR  ->  return null            // no entry object at all
```

The comment at L466–498 records the measurement behind `entryDepth`: over 7 days
of `scan_logs`, price was at the BTC/USD zone in **390 of 444 evaluations (88%)**
yet only **1 of 36** pending orders came near its entry, and **25 of 899** orders
across all pairs ever recorded a touch. Default remains `1` (far edge).

### 5.1 What execution actually places

The zone engine's SL/TP are **advisory**. `bot-scanner` L7040 overrides:

```
if unifiedGatePassed and entry.slPrice:
    unifiedSlPips within [effectiveMinSlPips, staticMinSlPips * impulseSlCapMultiplier(4)]
       -> sl = unified SL,  tp = price ± |price-sl| * config.tpRatio     <- TP REPLACED
    unifiedSlPips > max  -> zone SL discarded, structural SL kept
```

So the **2R-style target is a generic `tpRatio` applied to the overridden stop**,
and the zone engine's BOS target survives only in the narrative panel.
No break-even, no trailing, no partials and no time exit exist on this path.

---

## 6. Timeframes

| slot | scalper *(production)* | day_trader | swing |
|---|---|---|---|
| top | **1H** | Daily | Weekly |
| mid | **15m** | 4H | Daily |
| low | **5m** | 1H | 4H |
| entry | **5m** | 15m | 1H |
| confirmation | **15m** (fallback 5m) | 4H or 1H | Daily or 4H |
| ltf confirmation | **5m** | 1H or 15m | 4H |

Source: `bot-scanner` L5546–5574. Depth is `DEFAULT_CANDLE_LIMIT = 300` for every
interval except 4H (`800`, sliced to `LEGACY_H4_WINDOW = 300`).

---

## 7. Downstream gates (NOT the zone engine)

Direction verdict (Gate 1) · premium/discount · unified gate · impulse-zone hard
gate · **zone score ≥ `minZoneScore` (default 4)** · confluence threshold · Tier-1
factor minimum · ICT HTF (soft default) · session · correlation ·
`maxOpenPositions` **(default 3, portfolio-wide — there is no one-position-per-
instrument rule here, unlike IPO)** · prop-firm gate · position sizing.

---

## 8. Costs

The zone engine models **no spread, commission or slippage**. Cost enters only at
execution sizing. Any Stage-2 profitability figure must add a cost model
explicitly; there is none to inherit.

---

## 9. Observed production funnel (2026-09-15 → 09-24)

| stage | n |
|---|---|
| scan details with a `unifiedZone` verdict | 6,049 |
| `no_impulse` | 2,166 |
| `no_zone` (impulse but no POI in the Fib band) | 33 |
| **zone exists** | **3,850** |
| ↳ `watching` (price not at zone) | 2,462 |
| ↳ `at_zone` (price there, unconfirmed) | 949 |
| ↳ `confirmed` | 225 |
| ↳ `triggered` | 214 |
| scanner status `skipped_no_impulse_zone` | 2,197 |
| scanner status `skipped_weak_zone` (score gate) | 367 |
| scanner status `trade_placed_at_zone` | **17** |

**17 trades placed from 3,850 zone observations.** The dominant attrition is
price never reaching the zone (2,462) and no impulse existing at all (2,166).

---

## 10. Gaps this specification must record

1. **No strategy version constant.** Nothing in the zone path declares a version,
   so a change cannot be attributed and a baseline cannot be pinned by anything
   other than a git commit.
2. **No cost model.**
3. **No zone persistence**, therefore no lifecycle history and no way to ask
   "what happened to the zones we saw" from stored data alone.
4. **`scan_candle_snapshots` is empty** — the table designed to make replay
   possible has never been written to. This is what blocks determinism (audit §M).
