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

## Nothing is style-aware except by accident

```
MIN_SL_PIPS              per-symbol, style-blind        GBP/USD = 25
ATR_SL_FLOOR_MULTIPLIER  constant 1.5, style-blind
breakEvenPips            constant 20, style-blind
```

Zero style references across all three. The **only** style-aware term is that
ATR is measured on a per-style timeframe — and it is dominated by the
style-blind static floor.

### Measured, GBP/USD 2026-08-18

```
structural invalidation   2.5 pips     (staged_inherited)
ATR floor                 6.1 pips     (15m ATR 4.1 × 1.5)   ← style-aware
MIN_SL_PIPS              25.0 pips                            ← binding
actual stop              25.0 pips     exactly the static floor
```

The stop landing exactly on `MIN_SL_PIPS` proves the other two terms never
bound. Structure at 2.5 pips cannot bind at any plausible floor, so
`slMethod = "structure"` is honoured in name and inert in practice.

### What that cost

```
nearest structural target   13.7 pips
stop                        25.0 pips
R:R                          0.55      → rejected against a 1.0 floor
```

The setup was correct — zone found, touch detected, bullish reaction confirmed,
price reached the target. It was refused because the stop was 6× the 15m ATR.

---

## Proposal — one owner, one formula

```
anchorStop = structuralAnchor ± dynamicBuffer
noiseStop  = entry ± (k_style × ATR(confirmation timeframe, closed bars))

finalStop  = whichever is FARTHER from entry

if |finalStop - entry| > styleRiskCap:
    REJECT the setup
```

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
the first target rather than the full potential. That is an exit-management
change through `_shared/exitEvaluation.ts` and belongs after this one.

Related: `breakEvenPips: 20` is also style-blind. On a Scalper setup with a
13.7-pip target it can never trigger before TP, so break-even is dead on that
style today.

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
