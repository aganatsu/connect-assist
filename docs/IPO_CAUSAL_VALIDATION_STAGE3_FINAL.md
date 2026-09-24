# IPO causal validation — stage 3 final

**Research only. No strategy logic changed. The locked baseline is not edited.
No deployment, no database write, no schema, no cron, no SMC change.**
Dated 2026-09-24. Continues `a9b11aa6`.

---

## 0. The answer

**The measured edge does not survive causal correction.**

| | legacy (same population) | causal | delta |
|---|---|---|---|
| EUR/USD | +0.758R, PF 2.60 | **+0.142R, PF 1.17** | −0.616R |
| USD/JPY | +0.550R, PF 1.88 | **−0.095R, PF 0.91** | −0.645R |
| BTC HIGH_VOL | +0.193R, PF 1.28 | **−0.514R, PF 0.58** | −0.707R |
| **PORTFOLIO** | **+0.540R, PF 1.88** | **−0.067R, PF 0.93** | **−0.607R** |

Portfolio total R: **+512.4 → −63.4**. Max drawdown: **18.4R → 148.5R**.

Even if all 72 tick-required trades were full 2R wins — an upper bound that
cannot be achieved — the portfolio reaches **+26.9R over 1,021 trades, +0.026R
per trade**. Against a legacy +0.585R.

### Verdicts

| | |
|---|---|
| EUR/USD | `EDGE_SURVIVES_CAUSAL_CORRECTION` — marginally: +0.142R, PF 1.17 |
| USD/JPY | `EDGE_DOES_NOT_SURVIVE_CAUSAL_CORRECTION` |
| BTC/USD HIGH_VOL | `EDGE_DOES_NOT_SURVIVE_CAUSAL_CORRECTION` |
| **PORTFOLIO** | **`EDGE_DOES_NOT_SURVIVE_CAUSAL_CORRECTION`** |

---

## 1. Locked baseline — unchanged

EUR/USD 341 @ +0.758R PF 2.60 · USD/JPY 558 @ +0.550R PF 1.88 ·
BTC/USD HIGH_VOL 140 @ +0.301R PF 1.50 · **PORTFOLIO 1,039 @ +0.585R, win
72.6%, PF 2.02, maxDD 18.4R.** Not edited, not superseded by this document.

---

## 2. Population

The recovered Grade B design: five end-exclusive two-month periods
(2021-11, 2022-10, 2023-06, 2025-10, 2026-04) × EUR/USD 1h, USD/JPY 30min,
BTC/USD 1h. The unmodified replay reproduces EUR/USD **341 @ 0.758 PF 2.60** and
USD/JPY **558 @ 0.550 PF 1.88** exactly; BTC is 143 against 140 (§6).

Replayed population: **1,042 trades.**

---

## 3. Classification

| class | n |
|---|---|
| `NOT_INTRABAR_SENSITIVE` (multi-bar) | 570 |
| `1M_RESOLVED` | 398 |
| `TICK_REQUIRED` | 74 |
| **total** | **1,042** |

Invariant asserted in the runner: the classes partition the population exactly,
and the run aborts otherwise.

Provenance: HTF bars **and** minutes were both fetched from Twelve Data for this
corpus, so resolution is `SOURCE_MATCHED` by construction rather than by
comparison. Each trade additionally verifies that its minutes aggregate back to
their own HTF bar within 0.05%; no trade failed that check.

---

## 4. Results, with BTC 2023-06..08 excluded

| | n | win | expR | PF | totalR | maxDD |
|---|---|---|---|---|---|---|
| EUR/USD | 320 | 57.2% | **+0.142** | 1.17 | +45.4 | 32.0 |
| USD/JPY | 512 | 54.9% | **−0.095** | 0.91 | −48.7 | 90.1 |
| BTC HIGH_VOL (4 windows) | 117 | 55.6% | **−0.514** | 0.58 | −60.1 | 63.6 |
| **PORTFOLIO** | **949** | **55.7%** | **−0.067** | **0.93** | **−63.4** | **148.5** |
| *legacy, same 949* | 949 | 70.8% | +0.540 | 1.88 | +512.4 | 18.4 |

EUR/USD detail: W/L 183/137, avg win +1.68R, avg loss −1.92R, median win +1.72R,
median loss −1.68R, longest streaks +10 / −6.
USD/JPY: W/L 281/231, avg win +1.71R, avg loss −2.29R, streaks +11 / −12.

**Win rate falls from ~71% to ~56% across the board**, and average loss now
exceeds average win on every instrument — S2 exits price at the invalidating
close, which routinely sits beyond 1R.

### Unresolved bounds (72 tick-required)

| | portfolio total | per trade |
|---|---|---|
| optimistic (every unresolved = full 2R win) | **+26.9R** | +0.026R |
| pessimistic (every unresolved = −1R minus cost) | **−189.1R** | −0.185R |

The optimistic bound is unattainable and still lands at effectively zero. **The
conclusion does not depend on the unresolved trades.**

---

## 5. Where the legacy edge came from

| | n | legacy R |
|---|---|---|
| unaffected (multi-bar) | 570 | **−93.7** |
| intrabar-sensitive | 472 | **+686.9** |
| of those, causally resolved | 398 | +595.1 → **−972.3** |

The trades whose outcome OHLC could not order carried the entire legacy profit;
the trades it could order lost money. **149 of 398 resolved outcomes changed.**

(The −972.3 figure includes the corrupt BTC window; see §6. Excluding it the
direction is unchanged.)

---

## 6. Two data limitations, both mine to declare

### BTC 2023-06..08 is excluded — the 1m feed is corrupt in an undocumented way

Freeze §17 documents 64 HTF bars with `low` = price / 10000. My reconstructed
detector finds 62 (carried since `a9b11aa6`, never tuned).

The **1-minute** feed for that window carries a *different* corruption: **31
minutes where all four fields read ≈ 3.0 against a ~25,000 price** — a
whole-bar shift, not a low-only shift. The documented rule does not describe it
and my detector cannot catch it, because `min(open, close)` is already tiny.

Left in, it produced two BTC trades at **−489R each** and a BTC total of
−1,062.7R. That is a data artifact, not a strategy outcome.

**I did not invent a detector for it.** Per Part O the causal claim for that
window is refused: 21 BTC trades are reported `DATA_UNAVAILABLE` and excluded
from §4. BTC's causal result therefore rests on four of five windows.

### Treatment B was not validly implemented

Treatment B was to be the §17 repair alternative (`low = min(open, close)`). As
run it produced results **byte-identical to Treatment A**, and the reason is a
flaw in my harness, not a finding: the trade population is read from the
determinism checkpoint, which was generated under the DROP treatment. Only the
continuation bars changed, not which trades exist.

A valid Treatment B needs the engine re-run end to end under the repair
treatment — roughly 50 minutes of O(n²) replay. **It was not done, and no
Treatment B result should be quoted from this run.** The 62-vs-64 gap therefore
remains an open sensitivity.

---

## 7. Strategy survival

1. **EUR/USD positive?** Yes — +0.142R, PF 1.17. Survives, marginally.
2. **USD/JPY positive?** No — −0.095R, PF 0.91.
3. **BTC HIGH_VOL positive?** No — −0.514R, PF 0.58, and one window unmeasurable.
4. **Portfolio positive?** No — −0.067R, PF 0.93.
5. **PF > 1?** Only EUR/USD.
6. **Expectancy positive after costs?** Only EUR/USD.
7. **Drawdown materially worse?** Yes — 18.4R → 148.5R, eight-fold.
8. **Survives optimistic unresolved treatment?** The portfolio reaches +0.026R
   per trade under an unachievable best case. Not meaningfully.
9. **Any instrument survives alone?** EUR/USD only.
10. **Redesign or rejection?** The measurement says the recorded edge was
    substantially an artifact of unordered intrabar events. EUR/USD retains a
    small positive expectancy on 320 trades; that is a finding to investigate,
    not a system to deploy. This report makes no recommendation either way.

**No deployment recommendation is made. This is validation only.**

---

## 8. Runtime and API

Determinism replay 52.8 min; causal run 242.6 min including the 1m fetch.
192 requests, 753 minute-cache hits, 191 misses, 1 rate-limit, 1 retry, 0
errors. Minutes cached per instrument-day in `/tmp`; market data only, no
credential, nothing committed.

---

## 9. Statement

No IPO detection, lifecycle, contraction, FVG, direction, E2 entry, S2
invalidation, 2R target, re-entry, sequencing, volatility or cost rule was
changed. S2 remained close-confirmed at every resolution. No breaker/retest
logic was added — it stays deferred. No SMC, broker, cron, schema, deployment or
production code was touched, and no production module imports the research
resolver.

**The locked 1,039-trade baseline is preserved exactly as written.** The figures
here are a separate, versioned research result and do not replace it.
