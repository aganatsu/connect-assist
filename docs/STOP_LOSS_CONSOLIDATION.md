# Stop-loss consolidation — study and proposal

Status: **design agreed, not implemented.** Written 2026-08-19.

Read `CLAUDE.md` first. This is a consolidation, which in this repo means
**deleting implementations**, not adding a module that reconciles them.

---

## Why this exists

At least twelve places decide or modify a stop, across four pipelines that share
no code: entry, pre-arm, management and backtest. Two independent static floor
tables exist. On the one setup measured here, the style-blind entry floor
dominated every style-aware term — that is a scoped observation about one row,
not a claim about all production setups.

---

## Current inventory

### Entry path

| # | site | behaviour | disposition |
|---|---|---|---|
| 1 | `smcAnalysis:2115` `calculateSLTP` | base stop from `slMethod` | **keep — becomes the single owner** |
| 2 | `bot-scanner:4216` | recalc when direction was null | keep — already delegates to (1) |
| 3 | `bot-scanner:7712` | `max(MIN_SL_PIPS, ATR × 1.5)` | delete; folded into (1) |
| 4 | `bot-scanner:7733` | Impulse Zone override | delete; anchor feeds (1) |
| 5 | `bot-scanner:7767` | Unified Zone override | delete; anchor feeds (1) |
| 6 | `bot-scanner:7794` | Cascade override (swing) | delete; anchor feeds (1) |
| 7 | `unifiedZoneEngine:742` | produces `slPrice` = `poi.high + 0.5 × height` | becomes an **anchor input** to (1), not a stop |
| 8 | `pendingOrderPlan` `resolvePreArmedPositionStop` | separate pre-arm pipeline | delete; call (1) |

### Backtest — duplicated, not shared

| # | site | behaviour | disposition |
|---|---|---|---|
| 9 | `backtest-engine:4074/4077` | its own floor enforcement | delete; call (1) |
| 10 | `backtest-engine:4099` | its own impulse override | delete; call (1) |

Backtest holds private copies of (3) and (4). Parity is currently maintained by
duplication, so deleting the entry-path copies alone would silently diverge live
from backtest — the failure `CLAUDE.md` names explicitly.

### Management path — separate concern, must not be merged

| # | site | behaviour | disposition |
|---|---|---|---|
| 11 | `computeManagementDecision:102,339` | `MGMT_SL_FLOOR_PIPS`, **second** static floor table, default 10 | out of scope here; see below |
| 12 | `paper-trading:954` | trailing ratchet `newSL` | out of scope |
| 13 | `paper-trading:1197` | `adjustedSL` | out of scope |

Sites 11–13 move a stop on an **open position**. That is a different concept
from placing the initial stop, and merging them would repeat the
structural-invalidation-versus-position-stop conflation fixed in #325.

They are listed because `MGMT_SL_FLOOR_PIPS` is a second style-blind static
floor table (default 10, against the entry table's 25), and a consolidation that
removes one while leaving the other has only half-solved the problem. Its
disposition needs its own decision, not silent inheritance.

Sites checked and found **not** to produce stops: `manualImpulse.ts`,
`gamePlan.ts`.

Market fill can be overridden three times in sequence, each by a different
engine's answer to the same question. Pre-arm reaches none of them. The two
routes therefore produce different stops for the same setup.

Sites 3–5 exist because the base stop does not represent the actual invalidation
level, so each engine patches it afterwards. They are not extra features; they
are three workarounds for one missing input.

---

## One style-blind constant overrides the style-aware ones

The system **does** carry style-awareness. `tradingStyleConfig.ts` sets:

| style | `slBufferPips` | `breakEvenEnabled` | `breakEvenPips` | ATR timeframe | `impulseSlCapMultiplier` |
|---|---|---|---|---|---|
| scalper | 1 | false | 8 | 5m | 1.5 |
| day_trader | 2 | true | 20 | 15m | 4 (default) |
| swing | 5 | false | 40 | 1h | 6 |

What is **not** style-aware:

```
MIN_SL_PIPS               per-symbol only, no style dimension   GBP/USD = 25
MGMT_SL_FLOOR_PIPS        per-symbol only, no style dimension   default 10
ATR_SL_FLOOR_MULTIPLIER   constant 1.5
```

`impulseSlCapMultiplier` **is** style-aware — scalper 1.5, swing 6, day_trader
falling through to the `?? 4` default — and an earlier revision wrongly listed it
as style-blind.

The problem is not an absence of style-awareness. It is that one style-blind
constant sits in a `max()` above terms that are correctly style-scaled, and
therefore decides the stop whenever it is the largest — which, on the measured
case below, it was by a factor of four.

> An earlier revision of this document claimed nothing was style-aware and that
> `breakEvenPips: 20` was a global constant. Both were wrong: 20 is the
> **day_trader** value and also the `RUNTIME_DEFAULTS` fallback, and the fallback
> was mistaken for the only value.

### Measured, GBP/USD 2026-08-18

```
structural invalidation   2.5 pips     (staged_inherited)
ATR floor                 6.1 pips     (15m ATR 4.1 x 1.5)
MIN_SL_PIPS              25.0 pips     <- binding
actual stop              25.0 pips     exactly the static floor
```

The stop landing exactly on `MIN_SL_PIPS` shows the other two terms did not bind
**on this setup**. That is one row. It does not establish that structural stops
never dominate anywhere, and this document should not be read as claiming so —
the scope of the measurement is a single order.

The 6.1-pip figure is **15m** ATR. The Scalper contract proposed below requires
**5m** ATR, which was omitted from the export by a faulty `LIMIT` clause. The
correct 5m figure has not been measured, so every number derived from 6.1 is
illustrative rather than evidential.

### What it would have cost — counterfactual, not history

```
nearest structural target   13.7 pips
stop                        25.0 pips
R:R                          0.55      -> below a 1.0 floor
```

**This setup was not historically rejected by the R:R gate.** It expired waiting
for a post-CHoCH retracement that never arrived. The 0.55R figure is what the
gate *would* compute under #372, once the configured `next_level` target replaces
the ratio-substituted one — it is a projection about future behaviour, not a
recorded rejection.

The setup itself was correct: zone found, touch detected, bullish reaction
confirmed, price reached the target. What is measured is the stop; what is
projected is the consequence.

## Proposal — one owner, one formula

```
structuralStop = bufferedInvalidation                       // buffer ALREADY applied — see below
noiseStop      = entry   ± (k_style × ATR(confirmation TF, closed bars))
executionStop  = entry   ± max(brokerMinimumStopDistance,
                               liveSpread × safetyMultiplier,
                               oneTick)

finalStop = FARTHEST of the three from entry

if |finalStop - entry| > styleRiskCap:
    REJECT the setup
```

**Do not add the buffer again.** `deriveWatchlistInvalidation` already returns a
buffered level:

```js
const level = direction === "long" ? zone.low - bufferPrice : zone.high + bufferPrice;
```

and `bufferPrice` is `adjustedSlBuffer × pipSize`, which resolves from the
style-aware `slBufferPips`. The persisted `structural_invalidation` is therefore
**post-buffer**. An earlier revision wrote `anchor ± styleBuffer`, which would
have applied it twice.

Pick one and state it at the call site: either a **raw** zone/pivot anchor with
the buffer applied here, or the **persisted buffered invalidation** consumed
unchanged. The second is preferable — it is what the row already stores, and it
keeps one owner for the buffer.

All three terms enter the same comparison. An earlier revision chose only
between the structural and ATR stops and described the execution floor
separately, so it never reached `finalStop` — a stop inside the broker minimum
is not placeable regardless of how sound the thesis is.

### Never clamp inward

If the required stop exceeds the cap, **reject**. Moving the stop inside the
invalidation level produces a stop that no longer represents the thesis — a
trade that can be stopped out while its premise is still intact. Same principle
as `frozen_target_already_reached` on the target side: when geometry says there
is no trade, say so rather than manufacture one.

### The anchor is phase-dependent, and must be named

| phase | structural anchor |
|---|---|
| before confirmation | selected entry-zone structural invalidation |
| after CHoCH/MSS | frozen confirmation **protected pivot** |
| post-CHoCH retracement | the **same protected pivot** — never the retracement box |

The retracement OB/FVG determines *entry*. The protected pivot determines where
the reversal thesis *fails*. Anchoring the stop to the retracement box produces
a stop tight enough to be swept while the thesis is still valid.

### When the stop freezes

The anchor changes by phase, but the plan freezes **once**. Those are not in
tension only if the sequence is stated:

| stage | stop |
|---|---|
| discovery / pre-arm | **provisional** — computed from the entry-zone invalidation so geometry and R:R can be evaluated. **Not** for sizing: pre-armed `size` is deliberately `null` and position size is computed at final authorization from current equity and exposure (#334) |
| confirmation (CHoCH/MSS) | provisional anchor is **replaced** by the frozen protected pivot |
| immediately before final authorization | **frozen** — this is the plan of record |
| authorization, sizing, broker execution, management, backtest | all consume that frozen plan; none recompute |

The target freezes at discovery and never moves (see
`PENDING_ORDER_PREARMING_PLAN.md`). The stop freezes later, at confirmation,
because the protected pivot does not exist until the reversal has formed.

**A broker constraint discovered after freezing rejects the order. It must never
silently widen the stop** — a stop widened after sizing invalidates the position
size that was computed against it, which is how a risk-percent breach happens
without anything appearing to fail.

### ATR on the confirmation timeframe

| style | confirmation TF |
|---|---|
| scalper | 5m |
| day_trader | 15m |
| swing | 1h |

The confirming bar is the one the stop must survive, so the noise it must clear
is measured on that timeframe. Take closed bars only — `CLAUDE.md` forbids
detection on a forming bar, and a moving high/low would make the stop flicker.

Note this is deliberately the **confirmation role** from `stylePolicy`, not
`config.entryTimeframe`. They coincide today; `entryTimeframe` is user-editable
and can drift out of the style.

### Execution floor — no universal pip constant

A fixed pip floor is wrong across asset classes. `SPECS` already carries the
data per instrument:

```
EUR/USD  typicalSpread 1.0   maxSpread  2
XAU/USD  typicalSpread 3.0   maxSpread  5
BTC/USD  typicalSpread 20.0  maxSpread 50
```

```
executionFloor = max(
    broker minimum stop distance,
    live spread × safety multiplier,     // fall back to SPECS.typicalSpread
    one tick
)
```

An earlier draft of this document proposed "≈3 pips", which is meaningless on
gold, oil, indices and crypto — the same class of error as the Manual Impulse
pip-size bug fixed in #300.

### Starting parameters — require replay evidence before enforcing

| style | k (ATR mult) | risk cap |
|---|---|---|
| scalper | 1.5 | 4 × ATR |
| day_trader | 1.5 | 4 × ATR |
| swing | 1.5 | 6 × ATR |

`k` is constant on purpose. Style-awareness comes from the timeframe ATR is
measured on, not from a second static table — a per-style pip table would be
correct today and wrong the next time conditions change, which is how the 25 got
there.

### Illustrative effect — not a measured result

```
structuralStop = 2.5 pips (already buffered)
noiseStop      = 1.5 × 4.1 = 6.2 pips        <- 15m ATR, NOT the Scalper 5m the contract requires
executionStop  = not measured (broker minimum / live spread unknown)
finalStop      = 6.2 pips  [provisional]
R:R            = 13.7 / 6.2 = 2.2            [provisional]
```

**Two of the three terms are unmeasured.** The 5m ATR the Scalper contract keys
on was omitted from the export by a faulty `LIMIT`, and the execution floor
needs broker minimum stop distance and live spread. This example shows the shape
of the calculation, not its outcome. Do not cite 2.2R as evidence.

---

## What gets deleted

- **`MIN_SL_PIPS` as a volatility floor.** ATR does volatility, and already
  knows the style. What remains is the execution floor above.
- **Sites 3, 4 and 5.** With the correct structural anchor fed in, there is
  nothing left to override.
- **The second pipeline.** `resolvePreArmedPositionStop` and the market-fill
  path become one call. Market fill, pre-arm, confirmation, paper, live, Game
  Plan and backtest all consume the same frozen stop plan.
- Add the resulting owner to `SINGLE_OWNER` in
  `supabase/tests/_shared/singleConceptOwnership.test.ts` so it cannot be
  duplicated again.

**No new authority module.** Modify `calculateSLTP`.

---

## What this does not fix

The "0.5R that turned into 4–5R" complaint has two causes and this addresses one.

1. The inflated stop understated R — addressed here. The 0.55R → 2.2R figure is
   illustrative and rests on unmeasured inputs; the direction is sound, the
   magnitude is not established.
2. `next_level` selects the **nearest** qualifying structural target, so a fixed
   TP cannot express a 5R run — **not** fixed here.

Capturing the rest needs partial profit plus a runner, with the R:R gate judging
the first target rather than the full potential.

That belongs in **trade management**, not `exitEvaluation.ts`. That module
decides *whether a bar closed a position and at what price* — fill
determination. Partial-and-runner is exit *policy*: how much to take off, where
to trail, when to let the remainder run. Putting policy inside the fill
evaluator would give one module two concepts, which is the pattern this
consolidation exists to remove.

Break-even is already style-scaled — 8 / 20 / 40 pips — and Scalper has it
**disabled by default** (`breakEvenEnabled: false`). An earlier revision claimed
it was a style-blind 20 and therefore dead on Scalper; both halves were wrong.
Whether an 8-pip trigger is right for a 13.7-pip target is a separate question
and needs its own evidence.

---

## Evidence before enforcement

This changes every stop in the system, so per `CLAUDE.md` it needs its own PR
with evidence against historical setups.

The cheap version needs no fills: for every stored setup, compute both stops —
current pipeline versus proposed formula — and report how many rejected setups
would have cleared the R:R floor, and how many currently-armed ones would newly
exceed the risk cap and be rejected.

Both directions matter. The change should admit setups like the GBP/USD case
**and** reject setups whose invalidation is genuinely too far away. A result
showing only the first is a sign the cap is not binding anywhere and needs
review before it ships.

---

## Addendum — 2026-09-02: second measurement, still not implemented

This file was removed by the 2026-09-01 revert to the July 10 baseline and
restored unchanged from `88257de9`. The analysis above is untouched; only this
section is new.

The proposal remains **not implemented**. `MIN_SL_PIPS` is still a `max()` term
in the entry path at `bot-scanner`, and the override site the proposal calls
Site 3 is still there — the block commented "Recalculate SL with correct pip
size" replaces the stop with a structural anchor regardless of `slMethod`,
then the floor widens it.

The single GBP/USD row above now has company. Fourteen trades closed between
2026-08-26 and 2026-09-02, and every stop landed exactly on the per-symbol
static floor:

```
EUR/USD   20.0 pips     MIN_SL_PIPS 20
USD/JPY   25.0 pips     MIN_SL_PIPS 25
GBP/JPY   35.0 pips     MIN_SL_PIPS 35
XAU/USD   ~5.94         above static 50 — the ATR floor bound here instead
```

Fourteen of fourteen on the static floor for FX. That is no longer one row, and
it supports the document's central claim: the style-blind constant decides the
stop. It does not establish the counterfactual — what these stops *should* have
been is still unmeasured, and the replay study this document requires has not
been run.

Two things that were confounding the picture at the time of writing have since
been removed, which makes that study cleaner to run now:

- `tpRatio` resolved to 1, so every take profit sat at exactly 1x the stop and
  no R:R figure meant anything. Fixed 2026-09-02; raw R:R now reads 2.00-2.22.
- Gate 1 reported the Direction Verdict without comparing it to the entry
  direction, so setups traded against their own verdict. Fixed the same day.

Neither touches the stop. Both were inflating the noise any stop study would
have had to see through.

**Still required before any stop moves:** the cheap replay described above —
both stops computed per stored setup, reported in both directions. Nothing in
this addendum substitutes for it.


---

## Addendum — 2026-09-03: gold has been the ATR-only experiment

Relevant to "What gets deleted", which proposes removing `MIN_SL_PIPS` as a
volatility floor on the grounds that ATR does volatility and already knows the
style.

Gold has effectively been running that way already. `MIN_SL_PIPS["XAU/USD"]` was
50 pips at `pipSize` 0.01 — $0.50 on a ~$4,400 instrument, 0.011% of price,
against 0.16-0.31% for every forex pair. The static floor never bound, so gold's
stop came from the ATR floor alone.

Measured across five gold trades on 2026-09-02/03:

```
three real stop-outs   stops $3.03-$3.96   closed after 6, 7 and 9 minutes
two winners            same stop range     ran 13 and 126 minutes
net                    -733                the only net-negative symbol
```

Losses resolving in under ten minutes are stops sitting inside ordinary gold
noise, not the market disproving the setup.

Five trades proves nothing on its own. But it is a data point *against* removing
the static floor, and the replay study this document requires should treat
"ATR alone is sufficient" as a claim to test rather than a premise. Gold is the
one instrument where it has already been tried.

Raised to 700 pips ($7.00, 0.159%, matching GBP/JPY) as an interim measure, with
`supabase/tests/_shared/minStopFloorPct.test.ts` asserting every floor sits in a
comparable percentage band. That test encodes the principle this section argues
for — floors should be comparable across asset classes — without making the
unit change itself, which still needs the replay evidence described above.
