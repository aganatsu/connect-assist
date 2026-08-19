# Stop-loss consolidation — study and proposal

Status: **design agreed, not implemented.** Written 2026-08-19.

Read `CLAUDE.md` first. This is a consolidation, which in this repo means
**deleting implementations**, not adding a module that reconciles them.

---

## Why this exists

Six places decide or modify a stop, across two pipelines that share no code. The
only style-aware input is overruled by a style-blind one, with the result that
the configured `slMethod` has never actually set a stop in production.

---

## Current inventory

| # | site | behaviour |
|---|---|---|
| 1 | `smcAnalysis.ts:2115` `calculateSLTP` | base stop from `slMethod` — `structure` / `atr_based` / `fixed_pips` / `below_ob` |
| 2 | `bot-scanner:7712` | two-layer floor `max(MIN_SL_PIPS, ATR × 1.5)`, widens a tighter stop |
| 3 | `bot-scanner:7733` | Impulse Zone override → impulse origin ± buffer, capped |
| 4 | `bot-scanner:7767` | Unified Zone override → engine `slPrice`, capped `MIN_SL × 4` |
| 5 | `bot-scanner:7794` | Cascade override (swing only) → Daily zone origin, capped `MIN_SL × 6` |
| 6 | `pendingOrderPlan.ts` `resolvePreArmedPositionStop` | **separate pipeline** — `max(static, ATR, structural)`; 3–5 never apply |

Market fill can be overridden three times in sequence, each by a different
engine's answer to the same question. Pre-arm reaches none of them. The two
routes therefore produce different stops for the same setup.

Sites 3–5 exist because the base stop does not represent the actual invalidation
level, so each engine patches it afterwards. They are not extra features; they
are three workarounds for one missing input.

---

## One style-blind constant overrides the style-aware ones

The system **does** carry style-awareness. `tradingStyleConfig.ts` sets:

| style | `slBufferPips` | `breakEvenEnabled` | `breakEvenPips` | ATR timeframe |
|---|---|---|---|---|
| scalper | 1 | false | 8 | 5m |
| day_trader | 2 | true | 20 | 15m |
| swing | 5 | false | 40 | 1h |

What is **not** style-aware:

```
MIN_SL_PIPS               per-symbol only        GBP/USD = 25
ATR_SL_FLOOR_MULTIPLIER   constant 1.5
impulseSlCapMultiplier    config, 4 (6 cascade)
```

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
structuralStop = anchor  ± styleBuffer                      // slBufferPips, already style-aware
noiseStop      = entry   ± (k_style × ATR(confirmation TF, closed bars))
executionStop  = entry   ± max(brokerMinimumStopDistance,
                               liveSpread × safetyMultiplier,
                               oneTick)

finalStop = FARTHEST of the three from entry

if |finalStop - entry| > styleRiskCap:
    REJECT the setup
```

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
| discovery / pre-arm | **provisional** — computed from the entry-zone invalidation so the setup can be sized and gated |
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

### Effect on the measured case

```
anchorStop = 2.5 + buffer
noiseStop  = 1.5 × 4.1 = 6.2 pips      → farther, so it wins
finalStop  = 6.2 pips
R:R        = 13.7 / 6.2 = 2.2          → arms, with the configured structural target
```

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

1. The inflated stop understated R — fixed here (0.55R → 2.2R on the measured case).
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
