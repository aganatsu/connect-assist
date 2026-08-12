# Pre-arm gate audit — bot-scanner ~6752 to ~8538

Prerequisite for step 5 of `PENDING_ORDER_PREARMING_PLAN.md`. Classifies every
decision point between the hard Impulse Zone Gate's `continue` and pending-order
placement, so pre-arming can be an **explicit route** rather than an accidental
fallthrough.

## Classes

- **Discovery** — valid before zone touch. Safe to evaluate when pre-arming.
- **Touch** — requires price at the zone. Must NOT run before arrival.
- **Confirmation** — requires post-touch evidence.
- **Final safety** — must be re-run immediately before entry.
- **Diagnostic** — never blocks.

---

## Classification

| Line | Block | Class | Reason |
|---|---|---|---|
| 6760 | Zone Score Gate | Discovery | zone quality, fixed at detection |
| 6769 | Standalone Sweep Gate | Discovery | canonical local sweep state, already occurred |
| 7082 | Zone-local confluence | Discovery | zone property |
| 7096 | Cross-timeframe authority | Discovery | structural lineage |
| 7355 | Staged confirming (min cycles) | Discovery | staging-route bookkeeping |
| 7529 | Bidirectional conflict counter | Discovery | scoring |
| 7541 | HTF alignment | Discovery | historical structure |
| 7552 | ICT MSS | Discovery | historical structure |
| 7562 | ICT Judas | Discovery | historical sweep |
| 7572 | ICT FVG invalidation | Discovery | historical structure |
| 7582 | ICT Kill Zone | **Final safety** | session/time dependent |
| 7592 | ICT risk | **Final safety** | account exposure |
| 7623 | Game Plan + Direction Verdict alignment | Discovery | direction; re-checked by #319 |
| 7640 | News Impact alignment | **Final safety** | time dependent |
| 8164 | Single-ownership scan outcome | Discovery | claim/ownership at detection |
| 8394 | Minimum TP distance | Discovery | pure geometry |
| 8446 | Unified position sizing | **Recompute at authorization** | see below |

### runSafetyGates (line 490, called at 7614)

| Gate | Class | Reason |
|---|---|---|
| 1 Direction Verdict | Discovery | direction |
| **2 Premium/Discount** | **Touch** | reads `analysis.lastPrice` |
| 3 Structural Conviction | Discovery | fractal structure |
| **3b Reaction Confirmation** | **Touch** | "prove price RESPONDED at the level, not just arrived" |
| 4 Instrument enabled / max open positions | Final safety | account state |
| 5 Same-direction duplicate / max per symbol | Final safety | account state |
| 6 Portfolio heat | Final safety | account state |
| 7 Daily loss limit | Final safety | account state + time |
| 8 Max drawdown | Final safety | account state |
| 9 Min confluence | Discovery | score |
| 9b SMT opposite veto | Discovery | divergence |
| 10 Min R:R | Discovery geometry + **final** | ratio frozen; spread must be re-read |
| 11 Opening Range | Final safety | time |
| 12 Kill Zone only | Final safety | session |
| 13 Cooldown | Final safety | time |
| 14 Max consecutive losses | Final safety | account state + time |
| 15 Dollar daily loss | Final safety | account state |
| 16 News event filter | Final safety | time |
| 17 FOTSI overbought/oversold | Discovery | score penalty |
| 18 ATR volatility | Final safety | market state drifts |
| 19 Tier 1 minimum | Discovery | factor count |
| 20 Regime alignment | Discovery | subsumed by Gate 1 |
| **21 Spread quality** | **Diagnostic** | info-only, never rejects |
| 22 Correlation filter | Final safety | account state |

---

## Findings that constrain the design

### Gate 2 is price-dependent and must not run at discovery

```js
// Gate 2: Premium/Discount zone filter
const pdZone = analysis.pd.currentZone;
const curPrice = analysis.lastPrice;
```

At discovery price is away from the zone — 60–89 pips in the observed watchlist
cases. Evaluating P/D there judges a price the trade will never enter at.

`CLAUDE.md` independently flags this gate: *"uses a rolling entry-TF swing
envelope rather than the frozen impulse dealing range"*. Both reasons point the
same way — it belongs after touch.

### Gate 3b is a touch gate by its own definition

> "Reaction factors prove that price RESPONDED at the level, not just arrived
> there."

Cannot be known before arrival.

### Position size must not be frozen

Discovery may precede entry by hours. A size computed then embeds a stale
equity, exposure and prop-firm snapshot. On a funded account that is a limit
breach, not a rounding error.

The shared order-plan builder must therefore return entry, structural
invalidation, target and candidate identity — and deliberately **not** a size.
Size is computed during final fill authorization from current state.

### Gate 10 splits

The R:R *ratio* follows from frozen entry/SL/TP and is a discovery concern. The
*spread* it is adjusted by is live and must be re-read at entry. Freezing the
whole gate would let a setup that no longer clears R:R enter on stale spread.

---

## Consequence for step 5

Raw fallthrough (letting the pre-arm route continue past 6752) would have
evaluated **Gate 2 and Gate 3b against pre-arrival state**. Both are silent
failures: they return a verdict, just about the wrong moment.

Duplicating the entry/SL/TP preparation in the watchlist branch would create a
second implementation of sizing and target logic — the drift pattern that
`CLAUDE.md` identifies as this repo's largest source of bugs.

So neither. Extract one shared **order-plan builder** covering the discovery
concerns, call it from both the arrival route and the pre-arm route, and keep
touch/confirmation/final-safety gates on their existing side of the boundary.

## Route composition

```
Pre-arm route (price away from zone)
  discovery gates → order plan (entry, invalidation, target, identity)
  → pending_orders row, status 'pending'

Touch (existing Branch A, bot-scanner ~2704 — already implemented)
  candle high/low vs entry → zone_touch_time → awaiting_confirmation

Confirmation
  frozen CHoCH / reversal contract, attempt limits

Final authorization (immediately before entry)
  touch gates (2, 3b) + all final-safety gates + fresh spread
  + position size computed from CURRENT equity, exposure and prop-firm limits
```

**Step 8 of the plan is already built.** Branch A at `bot-scanner:2704` reads
`lastCandle.low/high` against the entry, from `cachedFetch`, over
`status IN ('pending','awaiting_confirmation')` — candle high/low, not close,
off cached bars, exactly as specified.

---

## Corrections after review

Four issues the first pass missed. All verified in source.

### 1. Pre-touch SL cancellation — blocks pre-arming outright

`bot-scanner:2588`, inside the pending-order loop, runs for **any** row with
status `pending` — touched or not:

```js
const slLevel = parseFloat(pending.stop_loss);
// Check SL invalidation: if price has blown past the SL, cancel the order
if (pending.direction === "long" && currentPrice < slLevel) { ... status: "invalidated" ... }
```

For a pre-armed order this makes the **position** stop — sized for after entry —
the pre-arrival invalidation boundary. Observed GBP/CHF watchlist entry:
invalidation 1.08597 against a zone floor of 1.08617, ~2 pips. A pre-armed order
there dies on any overshoot before it can fill.

Pre-touch invalidation must use the **frozen impulse/zone structural boundary**,
which is a different value with a different purpose. The two must be separate
columns, not one reused field, or the distinction will collapse again the first
time someone reads `stop_loss` and assumes it means one thing.

### 2. Touch detection inspects only the last candle

```js
const lastCandle = pendingCandles[pendingCandles.length - 1];
const filled = pending.direction === "long"
  ? lastCandle.low <= entryPrice : lastCandle.high >= entryPrice;
```

Correct on shape — candle high/low, off cached bars — but it samples a single
bar. If a scan is delayed, throttled, or the cron skips, an earlier candle can
wick into the zone and never be seen. The tighter the zone, the likelier the
miss.

Must scan every candle since the previous check and use the **earliest** touch,
because `zone_touch_time` anchors the CHoCH search window: a late timestamp
silently truncates it.

Revises the earlier claim that step 8 was already built. Its **shape** is right;
its **coverage** is not.

### 3. FOTSI holds two conflicting authorities

| where | treatment |
|---|---|
| Gate 17 (placement) | "softened from hard veto to heavy score penalty" |
| `thesisValidator` Check 1 (post-placement) | hard cancel |

Same inconsistency #319 removed for Game Plan: an input deliberately downgraded
at placement retains an unconditional veto afterwards. Classifying Gate 17 as
"discovery" was incomplete — FOTSI is discovery **and** an active post-placement
canceller, and pre-arming lengthens the window in which that veto can fire.

Resolve the ownership before pre-arming, or a longer-lived order simply gives
FOTSI more opportunities to kill it.

### 4. Premium/Discount needs the frozen range, not just a later evaluation

Moving Gate 2 after touch is necessary but not sufficient. It currently compares
`analysis.lastPrice` against a rolling entry-TF swing envelope. At final
authorization it should compare the **planned or fill price** against the
**frozen canonical impulse dealing range** captured with the candidate.

`CLAUDE.md` lists this as Priority 1 in
`docs/UNRESOLVED_SYSTEM_AUDIT_2026-08-03.md` independently of pre-arming.

---

## Revised route composition

```
Pre-arm route (price away from zone)
  discovery gates → order plan (entry, STRUCTURAL invalidation, target, identity)
  → pending_orders row, status 'pending'
  NOTE: structural invalidation ≠ position stop loss

Pre-touch monitoring
  every candle since last check, earliest touch wins
  invalidate on FROZEN STRUCTURAL BOUNDARY only

Touch → zone_touch_time → awaiting_confirmation

Confirmation
  frozen CHoCH / reversal contract, attempt limits

Final authorization
  touch gates (2 against the frozen range, 3b) + final-safety gates
  + fresh spread for Gate 10
  + position size from CURRENT equity, exposure, prop-firm limits
```
