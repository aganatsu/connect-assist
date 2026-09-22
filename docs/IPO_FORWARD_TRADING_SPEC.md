# IPO Forward Trading Specification

**Version 1.1 — frozen 2026-09-21.**

*v1.1: the expected baseline in §11 is now the CAUSAL live-equivalent result. The
previous 2,113-trade / +0.690R batch figure is marked non-causal and superseded.
No rule changed.*

This is the complete live rule set. It is deliberately unambiguous: every number
here is either derived from the bar data or fixed below. There are no free
parameters, no optional steps and no "use judgement" clauses.

Research is closed. **Nothing in this document may be changed to improve a
result.** It may be changed only to correct a defect that makes the live system
disagree with this specification.

Backing evidence: `docs/IPO_RESEARCH_FREEZE.md` sections 10–17.

---

## 1. Instruments and eligibility

| instrument | timeframe | volatility gate |
|---|---|---|
| EUR/USD | 1H | none — trade all volatility states |
| USD/JPY | 30M | none — trade all volatility states |
| BTC/USD | 1H | **HIGH_VOL only** |

No other instrument trades. No other timeframe trades.

---

## 2. Signal — A1

A trade candidate exists when **all** of the following hold.

1. **A valid IPO exists**, per the frozen lifecycle (`ipoLifecycle.ts`):
   - candidate = the last opposite-colour candle immediately before the first
     directional candle of a move;
   - a candidate inside an **active** contraction is invalid (offset 0 counts as
     inside);
   - the candidate is promoted to VALID only when the trend **closes beyond the
     opposite side of the prior contraction**;
   - it has not been invalidated (see §5).
2. **An aligned FVG is present** within bars `[candidateIndex, candidateIndex+10]`
   — bullish FVG for a demand IPO, bearish for a supply IPO. This is the A1
   condition and it is **mandatory**.
3. Price **touches the IPO zone** (any overlap).
4. For BTC/USD only: the volatility bucket at the touch bar is `HIGH_VOL`.

**Nothing else gates a trade.** Not SR overlap, not trend alignment, not fib
position, not HTF parent, not touch number, not IPDA. Those are recorded, never
applied.

### Geometry (frozen)

For a **demand** IPO (bullish, from a bearish candle):
- `zoneHigh` = candle HIGH, `zoneLow` = midpoint of the candle's FULL WICK range
- `invalidationLevel` = candle LOW
- direction = LONG

For a **supply** IPO, mirrored: `zoneLow` = candle LOW, `zoneHigh` = midpoint,
`invalidationLevel` = candle HIGH, direction = SHORT.

---

## 3. Volatility classification (live-causal)

Module: `ipoLiveVolatility.ts`. Measure and thirds come from the frozen
`ipoRegimeDescriptors.ts`; only the reference distribution is restricted.

- **Measure**: `ATR(14) / close` at each closed bar. Period 14 is
  `DEFAULTS.slATRPeriod`.
- **Bucket**: percentile rank of that measure against **all strictly earlier
  bars of the same instrument**. `>= 2/3` → HIGH_VOL, `< 1/3` → LOW_VOL,
  otherwise MID_VOL.
- **Warmup**: fewer than `MIN_REFERENCE` (200) prior observations →
  `UNCLASSIFIED`.

**`UNCLASSIFIED` IS NOT ELIGIBLE.** For BTC it means no trade, exactly as
MID_VOL and LOW_VOL do. BTC therefore needs ≥ 200 closed 1H bars of warmup
before it can trade at all. Seed from history at startup.

**Only closed bars may be fed to the classifier.** An in-progress bar has no
final close; feeding it leaks a value that does not exist yet.

---

## 4. Entry — E2_50_PERCENT

Place a **limit** order at the 50% level of the IPO candle:

- LONG: limit BUY at `zoneLow` (the midpoint of the full wick range)
- SHORT: limit SELL at `zoneHigh`

If price does not reach that level, **there is no trade**. Do not chase, do not
enter at the zone edge, do not widen.

Validation fill behaviour: ~92% of ideal-model fills survive a spread-aware fill
test, and the expectancy cost of realistic fills is −0.03R to −0.07R (§9).

---

## 5. Stop — S2_CLOSE_INVALIDATION

The position closes only when a bar **CLOSES** beyond the original IPO candle's
far extreme.

- LONG: exit when `close < invalidationLevel`
- SHORT: exit when `close > invalidationLevel`

A wick through the level does **not** exit. Repeated touches of the zone do
**not** exit. The realized exit price is that bar's **close**.

> **This is not a 1R stop.** See §8. It is the single most important thing to
> understand before sizing a position.

---

## 6. Target — T_2R

Fixed limit at 2R from the fill, where `1R = |entry − invalidationLevel|`.

- LONG: `entry + 2 × R`
- SHORT: `entry − 2 × R`

No trailing, no partials, no break-even move, no time stop.

---

## 7. Position management

- **One open position per instrument.** A new candidate while a position is open
  on that instrument is logged with `noFillReason: POSITION_ALREADY_OPEN` and
  skipped. First come, first served.
- EUR/USD, USD/JPY and BTC/USD may be open **simultaneously**. Maximum 3
  concurrent positions.
- Equal fixed risk per trade. No compounding during the forward test.

---

## 8. Risk reality — read before sizing

`1R` is the nominal IPO geometry distance. Under S2 it is **not** the loss.
Measured across validation:

| | EUR/USD | USD/JPY | BTC HIGH_VOL | portfolio |
|---|---|---|---|---|
| median losing trade | 1.71R | 1.71R | 1.98R | **1.75R** |
| p90 | 3.24R | 3.38R | 3.55R | 3.38R |
| p95 | 4.17R | 4.71R | 4.86R | 4.35R |
| p99 | 6.42R | 13.34R | 8.08R | 8.26R |
| worst | 8.26R | **17.33R** | 8.08R | **17.33R** |

Percentage of **losing** trades exceeding a given loss:

| | >1R | >1.5R | >2R | >3R | >5R |
|---|---|---|---|---|---|
| EUR/USD | 98.1% | 66.7% | 35.3% | 12.8% | 1.9% |
| USD/JPY | 99.6% | 69.7% | 36.1% | 13.9% | 4.7% |
| BTC HIGH_VOL | 86.1% | 81.9% | 48.6% | 25.0% | 4.2% |
| **portfolio** | **97.2%** | **70.5%** | **37.6%** | **15.1%** | **3.8%** |

**Sizing "1% risk" off nominal R would risk ~1.75% on the median loser, ~4.4% at
p95 and 17% on the worst observed trade.** Average MAE is 1.34R — the typical
trade travels further against the position than its own nominal stop.

Size against observed loss distribution, not nominal R. This specification does
not prescribe a position size; that decision is explicitly outstanding.

### Cost-dominated setups — outstanding decision

Round-trip cost expressed in R (`2 × perSide / risk`):

| | median | p90 | max | >0.5R | >1R | >2R (a 2R win still loses) |
|---|---|---|---|---|---|---|
| EUR/USD | 0.29 | 0.63 | 4.00 | 16.5% | 4.7% | 1.3% |
| USD/JPY | 0.27 | 0.64 | 3.52 | 14.7% | 3.2% | 0.8% |
| **BTC/USD** | **0.72** | **1.64** | 4.11 | **74.6%** | **28.9%** | **4.9%** |

On BTC the fee is proportional to price while 1R is the candle's wick span, so
small-risk setups are structurally uneconomic: 32 validation trades reached the
2R target and still finished net negative (−32.4R combined).

A minimum risk-to-cost requirement would fix this. **It is not in this
specification, because adding it would be a new filter and research is closed.**
It must be decided explicitly before live capital is committed.

---

## 9. Execution assumptions

Declared before testing, not fitted:

| | EUR/USD | USD/JPY | BTC/USD |
|---|---|---|---|
| spread (per side, already in costs) | 0.8 pip | 0.8 pip | 0.15% |
| assumed adverse slippage on S2 exit | 0.5 pip | 0.5 pip | 0.10% |

Portfolio expectancy across fill models, measured on the NON-CAUSAL batch set:
ideal +0.690R, spread-aware +0.657R, with exit slippage +0.622R, through-fill
+0.660R — a haircut of -0.03R to -0.07R, with ~92% of ideal fills surviving a
spread-aware test.

**These are relative haircuts, not planning figures.** The absolute baseline is
the causal one in §11 (+0.585R). Applying the harshest haircut to it gives a
conservative planning figure of roughly **+0.52R**. The fill models have not been
re-measured on the causal trade set.

---

## 10. Event ledger

**SUPERSEDED 2026-09-21 by Phase D.** This section originally specified an
append-only JSONL ledger written by `ipoForwardLedger.ts` into a single
`ipo_paper_ledger` table. That path was retired at the D.2 checkpoint: it had
never been deployed and its migration had never been applied, and keeping it
would have put a fourth IPO table into production schema for no reason. The
research it produced stands — 16,169 rows over the validation windows with
`auditLedger()` returning zero violations, recorded in
`docs/IPO_RESEARCH_FREEZE.md` — and the code remains in git history.

The forward record now lives in three IPO-owned tables, created by
`20260921140000_ipo_paper_state.sql`:

| table | holds |
|---|---|
| `ipo_execution_events` | append-only audit, **one row per decision including refusals** — the property §10 existed to guarantee. `strategy_decision` and `account_decision` are recorded separately and never collapsed. |
| `ipo_paper_positions` | open state, one row per live paper position |
| `ipo_paper_trade_history` | closed results; `realized_r` canonical, `realized_pnl_usd` a view of it under the sizing stored on the row |

The old `noFillReason` set is now `reason_codes` on a `REFUSED` event, and the
old `exitReason` values `OPEN` and `NOT_FILLED` no longer exist: an open
position is a row in `ipo_paper_positions`, and a candidate that did not fill is
a `REFUSED` event rather than a history row with empty columns.

`exit_reason` is now {`TARGET_2R`, `S2_CLOSE_INVALIDATION`, `DATA_GAP_ABORTED`},
the third being a data-quality failure that carries no exit price and no R and
is `excluded_from_stats` at the column level.

The audit `auditLedger()` performed in TypeScript is now enforced by the
database: see the `ipo_paper_history_outcome_coherent` CHECK.

---

## 11. What "working" looks like — CAUSAL BASELINE

**This is the official expected baseline.** It comes from `ipoLiveEngine.ts`
replaying all 15 untouched validation windows one closed bar at a time, using
only information available at each bar. It is what a live system can actually
reproduce.

| instrument | n | win% | expR | PF | maxDD | streak | totalR | MAE | trades/mo |
|---|---|---|---|---|---|---|---|---|---|
| EUR/USD | 341 | 74.5 | **+0.758** | 2.60 | 8.2 | 3 | +258.5 | 1.18 | 34.3 |
| USD/JPY | 558 | 70.6 | **+0.550** | 1.88 | 18.4 | 4 | +307.1 | 1.48 | 56.0 |
| BTC/USD HIGH_VOL | 140 | 75.7 | **+0.301** | 1.50 | 14.4 | 3 | +42.1 | 1.16 | 14.0 |
| **PORTFOLIO** | **1039** | **72.6** | **+0.585** | **2.02** | **18.4** | **4** | **+607.7** | 1.34 | **103.7** |

Forward results materially below this — particularly a portfolio win rate under
~62% or a drawdown beyond ~40R — indicate the forward environment differs from
validation. That is information, **not** a reason to adjust the rules.

### SUPERSEDED: the 2,113-trade / +0.690R batch result is NON-CAUSAL

The figure previously carried here — 2,113 trades at +0.690R, PF 2.33 — **must
not be used.** It came from evaluating whole series at once, which let the
backtest see bars a live system would not have had.

**Cause, isolated and singular.** `runLifecycle` establishes `hasFvg` by scanning
`[candidateIndex, candidateIndex + 10]`. When a touch occurs within 10 bars of
the IPO candle, the batch admitted the trade on **an FVG that had not formed
yet**. Measured on EUR/USD window 1: of 142 batch trades, 81 were knowable in
time, **61 (43%) only became knowable after their own entry bar**, and 0 were
never knowable. Lateness was median 3 bars and **maximum exactly 10** — the scan
window, which is what identifies the cause rather than merely suggesting it.

The rules are sound; the evaluation was not. **The FVG rule is NOT changed and
those trades are NOT recovered.** A live system simply takes about half of them:

| | batch (non-causal) | causal live | kept |
|---|---|---|---|
| EUR/USD | 678 @ +0.793 | 341 @ +0.758 | 50.3% |
| USD/JPY | 1151 @ +0.726 | 558 @ +0.550 | 48.5% |
| BTC/USD | 284 @ +0.296 | 140 @ +0.301 | 49.3% |
| **portfolio** | **2113 @ +0.690** | **1039 @ +0.585** | **49.2%** |

Expectancy per trade holds on EUR/USD and BTC and degrades on USD/JPY. All three
remain positive. On every trade both paths take, they agree on realized R to
1e-9, so this is a difference in which trades are taken, not in how they are
valued.

**Also superseded:** an earlier live figure of 1,109 trades at +0.619R. That came
from a version of the engine with two bugs since fixed — cost priced off the exit
bar rather than the entry bar, and same-bar re-entry permitted where the frozen
`sequential()` requires `touchIndex > previousExitIndex`. The table at the top of
this section is the corrected result.

### Consequences for planning

- Expect roughly **half** the trade frequency of section 17: ~104 portfolio
  trades/month, not ~180.
- Plan on **+0.585R**, or lower still if the §9 execution haircut is applied on
  top. The most conservative combination tested remains the right planning
  figure, not the most favourable.

## 12. Standing prohibitions

- No new filters, confluence, or ranking.
- No target, stop or entry optimisation.
- No instrument added or removed on the basis of forward results.
- No re-fitting of the volatility thirds, the ATR period, or the FVG window.
- No change to this document to make a result look better.

---

## 13. Known open items (all pre-existing, none resolved here)

1. **Position sizing is undecided** — §8 is the input, not the answer.
2. **Cost-dominated BTC setups are unaddressed** — §8.
3. **S2 permits unbounded adverse excursion** — no catastrophic stop exists.
4. **Trade frequency is high** (~180 portfolio trades/month) and every entry
   assumes a resting limit fill.
5. **Validation spans five windows, not five years of continuous history.**
6. **The IPO anchor is a contributor, not a carrier** — it adds ~+0.2R over an
   equivalent random zone with the same FVG filter (section 16). FVG and
   volatility state do more of the work.

---

**Production changed: only where required to make the frozen candidate causal
and observable** — `ipoLiveVolatility.ts` and `ipoForwardLedger.ts` were added.
(The latter was retired at D.2; see section 10.)
No frozen rule was modified. No new research rule was introduced.
