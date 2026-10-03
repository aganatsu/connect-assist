# IPO_BASELINE_1H_4H_CAUSAL_V2

**Question.** What are the true historical IPO results when entry and invalidation are
ordered causally?

**Answer: historically unprofitable under corrected causal execution.**

| | Trades | WR | Expectancy | PF | Net | Chronological DD |
|---|---|---|---|---|---|---|
| V1 (frozen, superseded) | 1,032 | 61.5% | +0.202R | 1.25 | +208.3R | 45.6R |
| **V2 (corrected)** | **928** | **53.1%** | **−0.171R** | **0.84** | **−158.4R** | **171.7R** |
| V2 strict (also removes the zone-selection look-ahead) | 1,045 | 50.2% | −0.377R | 0.69 | −393.4R | 405.1R |

No instrument or timeframe is profitable in either variant. USD/JPY is the closest, at break-even in V2 (−0.008R, 1H −0.000R); EUR/USD (−0.166R) and BTC/USD (−0.402R) are clearly negative. Per the decision rule,
this is frozen as the corrected baseline outcome, and no filter or rescue was searched.

**What drives it.** The repaired defect alone recovers 102 trades the old engine
erased, worth −225.5R. Most of those trades fill the 50% level and then close through
S2 on the same bar: 91 same-bar S2 losses totalling −237.5R.

Research only. Nothing was deployed, and no production file was modified. V1 is not
overwritten.

---

## 1. What was rebuilt, and how

**Inputs: exactly V1's, proven.**
- V1's 1m files, which defined its decision spans, were gone.
- `ipo-v2-m1-fetch.ts` repeated V1's backward 1m paging request for request: 219 requests, 12 windows, no provider errors.
- That recovered every decision start exactly.
- An exact copy of V1's ARM C loop and 1m resolver, run on the rebuilt inputs, reproduces the frozen export **1,032 / 1,032, every outcome and R identical, 0 extra**.
- V2 therefore runs on V1's strategy bars, V1's decision spans and V1's 1m tape.

**Engine: production lifecycle, causal decision layer** (`local-runner/ipoCausalV2.ts`).
- **Lifecycle:** candidate generation, geometry, validation, FVG requirement, contraction suppression, touch rule, S2 level and 2R target all come from the unchanged production `IncrementalEngine`.
- **Decision time:** V2 decides bar K on the engine's state after bar K−1 (`inspect()` before `feed()`), i.e. at K's open. The trade then exists at its first 1m fill minute.
- **Execution:** the unchanged production resolver `resolveBar` (`1m-ordering-v1`, the live runner's) runs from the fill on. A close beyond S2 later in the same bar exits the active trade.
- **Slot:** one slot per instrument shared by 1H and 4H, ordered by fill time. Within a timeframe the frozen `touchIndex > previousExitIndex` rule applies; across timeframes, a fill must come after the exit instant.
- **Ambiguity:** a same-minute entry/target is AMBIGUOUS and excluded from stats, and its open branch holds the slot (the live runner's rule).
- **Costs:** unchanged model, priced at the entry exactly as V1 priced them. Warm-up: 400 bars, as V1.

**Look-aheads removed** (all from the same closed-bar evaluation):

| Look-ahead in the frozen engine | Effect on V1 trades |
|---|---|
| Invalidation checked before the touch: a bar that fills and then closes beyond S2 erases the trade | **102 trades recovered** |
| A zone validated by the touch bar's own close could be entered on that bar | 5 removed |
| An FVG completed by the touch bar | 4 removed |
| BTC volatility bucket computed with the touch bar's own ATR/close | 26 removed |
| Contraction context changed by the touch bar | 0 |

**V1 sequencing defect, also removed.** 202 of V1's 1,032 trades (20%) were opened
while the previous V1 trade on the same instrument was still open on 1m. That breaks
one-trade-at-a-time, in two ways:
- **Cross-timeframe backdating:** a 4H entry only became known at the 4H close and was backdated into a 1H trade's life (and vice versa).
- **Whole-bar exits:** V1 freed its slot on the engine's whole-bar exit, so a pre-fill target on the entry bar released the slot while the 1m trade was still running.

V2's fill-time slot makes overlap impossible.

**Resolver differences from V1** (V2 uses the frozen live resolver):
- **Same-minute entry and target:** AMBIGUOUS. V1 counted them as wins; this is 14 V1 trades.
- **Target in the S2 bar's final minute:** counted as a target, because a close is the bar's last event. V1 discarded these; at most 6 V2 trades are affected.

## 2. Corrected baseline: IPO_BASELINE_1H_4H_CAUSAL_V2

950 trades are in scope: 928 resolvable, 18 AMBIGUOUS (all same-minute entry/target)
and 4 open at the end of data. A further 281 warm-up trades kept the slot continuous
and are not counted. Instrument-months: 31.49.

### Combined 1H + 4H
| n | wins | losses | WR | avg win R | avg loss R | expectancy R | PF | net R | chron. max DD R | trades/month |
|---|---|---|---|---|---|---|---|---|---|---|
| 928 | 493 | 435 | 53.1% | +1.676 | -2.264 | -0.171 | 0.84 | -158.394 | 171.7 | 29.5 |

### By timeframe
| TF | n | wins | losses | WR | avg win R | avg loss R | expectancy R | PF | net R | chron. max DD R | trades/month |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1h | 748 | 408 | 340 | 54.5% | +1.652 | -2.293 | -0.141 | 0.86 | -105.265 | 121.3 | 23.8 |
| 4h | 180 | 85 | 95 | 47.2% | +1.792 | -2.162 | -0.295 | 0.74 | -53.129 | 58.0 | 5.7 |

### By instrument
| instrument | n | wins | losses | WR | avg win R | avg loss R | expectancy R | PF | net R | chron. max DD R | trades/month |
|---|---|---|---|---|---|---|---|---|---|---|---|
| EUR/USD | 490 | 254 | 236 | 51.8% | +1.778 | -2.259 | -0.166 | 0.85 | -81.518 | 91.7 | 34.2 |
| USD/JPY | 252 | 133 | 119 | 52.8% | +1.856 | -2.092 | -0.008 | 0.99 | -2.078 | 23.8 | 35.3 |
| BTC/USD | 186 | 106 | 80 | 57.0% | +1.207 | -2.535 | -0.402 | 0.63 | -74.799 | 78.1 | 18.5 |

### By instrument × timeframe
| instrument | TF | n | wins | losses | WR | avg win R | avg loss R | expectancy R | PF | net R | chron. max DD R | trades/month |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| EUR/USD | 1h | 389 | 208 | 181 | 53.5% | +1.759 | -2.247 | -0.105 | 0.90 | -40.853 | 51.7 | 27.2 |
| EUR/USD | 4h | 101 | 46 | 55 | 45.5% | +1.864 | -2.299 | -0.403 | 0.68 | -40.665 | 43.1 | 7.1 |
| USD/JPY | 1h | 206 | 110 | 96 | 53.4% | +1.841 | -2.110 | -0.000 | 1.00 | -0.013 | 28.0 | 28.9 |
| USD/JPY | 4h | 46 | 23 | 23 | 50.0% | +1.927 | -2.017 | -0.045 | 0.96 | -2.065 | 18.6 | 6.5 |
| BTC/USD | 1h | 153 | 90 | 63 | 58.8% | +1.175 | -2.701 | -0.421 | 0.62 | -64.399 | 66.9 | 15.2 |
| BTC/USD | 4h | 33 | 16 | 17 | 48.5% | +1.388 | -1.918 | -0.315 | 0.68 | -10.400 | 14.9 | 3.3 |

### By period
| period | n | wins | losses | WR | avg win R | avg loss R | expectancy R | PF | net R | chron. max DD R | trades/month |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2022 windows | 240 | 124 | 116 | 51.7% | +1.691 | -2.394 | -0.283 | 0.76 | -67.932 | 79.5 | 7.6 |
| 2025 windows | 688 | 369 | 319 | 53.6% | +1.671 | -2.217 | -0.131 | 0.87 | -90.462 | 113.9 | 21.9 |

## 3. V1 vs V2

| Metric | V1 Old | V2 Corrected | Difference |
|---|---:|---:|---:|
| Trades | 1032 | 928 | −104 |
| WR | 61.5% | 53.1% | −8.4 pp |
| Expectancy | +0.202R | −0.171R | −0.372R |
| PF | 1.25 | 0.84 | −0.41 |
| Net R | +208.3R | −158.4R | −366.6R |
| Chronological DD | 45.6R | 171.7R | +126.2R |
| Trades/month | 32.8 | 29.5 | −3.3 |

| Count | V2 |
|---|---|
| Suppressed trades recovered | **102**, combined **−225.5R** (100 resolvable, 2 ambiguous/open) |
| Old trades removed | 234 (198 slot occupied, 34 look-ahead dependency, 2 other zone taken on the bar) |
| Old trades shifted (same zone, different bar) | 28 |
| Old trades with outcome changed | 14 (all now AMBIGUOUS: same-minute entry/target) |
| Same-bar S2 losses | **91**, −237.5R |
| Same-minute ambiguous trades | 18 |

**Waterfall, V1 → V2 (closes exactly):**

| Step | Net R |
|---|---|
| V1 | +208.3 |
| Removed V1 trades | −79.8 |
| Shifted (V1 +7.3 → V2 −18.5) | −25.8 |
| Outcome changed (now ambiguous, excluded) | −20.7 |
| Recovered suppressed trades | −225.5 |
| New from sequence changes (50 trades) | −14.9 |
| **V2** | **−158.4** |

Unchanged trades (756) contribute +100.4R in V2 against +100.5R in V1.

**Ambiguity range.** In 16 of the 18 ambiguous trades both branches end at target.
Counting all 18 at the target branch would add +21.2R (V2 = −137.2R). Still negative.

## 4. Reconciliation (`ipo_baseline_causal_v2_reconciliation.csv`)

Every V1 trade: **SAME 756 · SHIFTED 28 · REMOVED 234 · OUTCOME_CHANGED 14** = 1,032.

Every new V2 trade: **NEW_SUPPRESSED_TRADE_RECOVERED 102 · NEW_DUE_TO_SEQUENCE_CHANGE 50**.

Check: 756 + 14 + 28 + 102 + 50 = 950 in-scope V2 trades.

**Why the counts differ:**
- **Recovered trades:** they occupy the slot only until their own close (mostly the same bar), so they rarely block anything. 12 V1 trades were blocked by one.
- **Most removals (180)** are V1 trades that only existed because V1 let positions overlap (§1).
- **Look-ahead removals (34)** are V1 trades whose existence needed the touch bar's own data; 26 are BTC volatility.
- **Sequence changes:** once the slot is held for the right length of time, 50 different trades become reachable (net −14.9R).

Each row carries its cause.

## 5. Live-period check: PASS

The V2 engine, run on the live engines' own persisted bars and the audit's 1m tape
(2026-09-24 → 10-02, each instrument at its live timeframe, flat at the start), gives:

| | V2 | Audit |
|---|---|---|
| Entries | 27 | 24 recorded + 2 suppressed + 1 open ambiguous |
| Recorded set | 24 / 24, **+4.2619R** | +4.263R |
| USD/JPY short 09-30 20:00 | same-bar S2, **−1.4032R** | |
| USD/JPY long 10-01 11:30 | same-bar S2, **−6.0040R** | |
| Suppressed total | −7.4072R | −7.407R |
| **Corrected period total** | **−3.1453R** | −3.144R |

- The only difference, 0.0011R, is BTC #6's cost: the live engine prices cost at the touch bar's close, V2 at the entry.
- The open USD/JPY ambiguous position resolves AMBIGUOUS with both branches at target.

## 6. A second look-ahead, not in the original defect list

The frozen engine picks its zone at the bar's close. It takes the lowest-k (oldest)
zone touched anywhere in the bar, and refuses the bar if that zone misses its 50%
level. A newer zone that **already filled** earlier in the bar is erased if an older
zone is touched later.

Example: EUR/USD 2026-09-25 06:00.
- The newer zone filled at 06:02.
- The older zone was first touched at 06:16 and never reached 50%.
- Production refused the bar; the real trade was an S2 loss (−2.96R).

**V2 as specified keeps this rule**, because the live-period gate's expected −3.144R
was computed under it. **V2 strict** replaces it with its causal form: at each minute,
the hit is the lowest-k zone touched so far. Results:

| | V2 strict |
|---|---|
| Combined | n 1,045, expectancy −0.377R, PF 0.69, net −393.4R, DD 405.1R |
| Live-period gate | **FAIL by construction**: 41 entries, −5.579R |
| Reconciliation | SAME 670 · SHIFTED 68 · REMOVED 282 · OUTCOME_CHANGED 12 · NEW_SUPPRESSED_TRADE_RECOVERED 171 · NEW_SELECTION_LOOKAHEAD_RECOVERED 100 · NEW_DUE_TO_SEQUENCE_CHANGE 55 |

The third class name is the one addition, needed because those trades are neither
touch-bar recoveries nor slot effects.

| instrument | n | wins | losses | WR | avg win R | avg loss R | expectancy R | PF | net R | chron. max DD R | trades/month |
|---|---|---|---|---|---|---|---|---|---|---|---|
| EUR/USD | 559 | 279 | 280 | 49.9% | +1.771 | -2.431 | -0.334 | 0.73 | -186.659 | 196.3 | 39.1 |
| USD/JPY | 275 | 136 | 139 | 49.5% | +1.857 | -2.181 | -0.184 | 0.83 | -50.698 | 62.1 | 38.6 |
| BTC/USD | 211 | 110 | 101 | 52.1% | +1.250 | -2.907 | -0.740 | 0.47 | -156.091 | 157.3 | 21.0 |

**This also corrects IPO_24_TRADE_CAUSAL_AUDIT_V1.** Its "24 trades causally valid"
holds only under the bar-level selection rule. Under touch order, 5 of the 24 would
not exist and 19 other trades would.

## 7. Does V2 qualify as a causal backtest?

| Criterion | V2 | V2 strict |
|---|---|---|
| Intrabar ordering correct (fill timed on 1m, close never erases an earlier fill) | yes | yes |
| Costs included | yes | yes |
| Ambiguity handled conservatively (excluded; open branch holds slot; range reported) | yes | yes |
| No look-ahead remains | **no** (bar-level zone selection) | yes, to my knowledge |
| Strategy parity (frozen lifecycle, geometry, S2, target, costs, universe, windows) | yes | yes, apart from the causal translation of zone selection |

So:
- **V2 is a corrected research baseline, not a fully causal backtest.**
- **V2 strict meets the causal-backtest criteria.** Both are negative, so the conclusion does not depend on which one is used.
- **Neither is live-ready evidence.**

## 8. Data integrity (`ipo_baseline_causal_v2_data_integrity.csv`)

| Finding | Count | Repair | Dependence |
|---|---|---|---|
| 1m open/close outside the bar's high–low | 1,405 bars, all EUR/USD Dec 2024–Mar 2025 (179 / 254 / 348 / 369 / 255 per month) | **none applied.** Each bar is logged with source values and what a clamp would give | **none**: entry timing, zone touches and `resolveBar` read 1m high/low only. 83 V2 trades have such a minute in their window (net −28.7R), but no decision reads those fields |
| 1m isolated spikes (local-median rule) | 0 | none | none |
| 1m gaps > 60 min outside FX weekends | 16 provider gaps (holiday/rollover) inside contiguous page chains | none | 3 V2 trades span one (net +2.6R) |
| 1H/4H open/close outside range | 8 (1H) + 4 (4H) | **none**: V1 and V2 both consume the provider strategy bars | 36 V2 trades have one in their life (net +12.9R). Excluding them, V2 = −171.3R |

**No result depends materially on repaired or corrupt provider data.** Excluding every
flagged trade makes V2 more negative, not less.

## 9. Files, tests, results

New files only; no production file was changed.

| File | Purpose |
|---|---|
| `local-runner/ipoCausalV2.ts` | causal decision layer: pre-bar eligibility, selection rules, `resolveTrade` (production `resolveBar`), shared-slot simulation, lifecycle feed |
| `local-runner/ipo-v2-m1-fetch.ts` | V1-exact 1m paging, resumable |
| `local-runner/ipo-baseline-causal-v2.ts` | per-window rebuild: V1 parity control, V2 scan and simulation, data audit |
| `local-runner/ipo-baseline-causal-v2-report.ts` | aggregation, reconciliation, exports |
| `local-runner/ipo-v2-live-check.ts` | live-period gate |
| `supabase/tests/_shared/ipoCausalV2.test.ts` | 14 causality tests |

**Tests (14, all pass):**
1. The bar's later close never decides whether the earlier fill existed.
2. Rewriting everything after the fill minute leaves the entry untouched.
3. LONG: entry touched, same bar closes below S2 → trade exists and exits at S2.
4. SHORT: entry touched, same bar closes above S2 → trade exists and exits at S2.
5. Entry and target inside one minute → AMBIGUOUS, no R, and the open branch keeps the slot.
6. A recovered same-bar-S2 trade blocks fills until its close, then frees the slot.
7. Same timeframe: no re-entry on the exit bar (frozen rule).
8. Rewriting everything after a trade's exit leaves that trade identical.
9. Real production engine: the state V2 reads at K does not depend on bar K or later.
10. Real production engine: rewriting an entry bar's close (through the stop) and all later bars leaves that entry identical.
11. A zone is enterable only if invalidation, validation, suppression, FVG, touch and BTC volatility were settled before the bar.
12. TOUCH_ORDER selection, case 1.
13. TOUCH_ORDER selection, case 2.
14. Frozen geometry levels.

**Mutation check.** Eight planted bugs, each caught:
- deciding on the post-bar state;
- reinstating the close-beyond-S2 suppression;
- dropping same-minute ambiguity;
- ignoring the occupied slot;
- dropping the same-TF exit-bar rule;
- touch order replaced by earliest fill;
- HTF target exit timed at bar close;
- ignoring invalidation before the bar.

**Full suite:** `deno test supabase/tests/ supabase/functions/` → **3,158 passed, 0 failed**.
`deno check` is clean on every new file.

**Committed** on branch `research/ipo-causal-v2` (with the TTM, market-context, entry-quality and 24-trade-audit studies it builds on). Not merged, not deployed.

## 10. Decision

V2 is negative, so per the decision rule:
- **"historically unprofitable under corrected causal execution"** — frozen as the corrected baseline outcome;
- **no filters or rescue parameters were searched;**
- **V1 (+0.202R) is superseded as profitability evidence.** Its edge came from erased same-bar S2 losses, overlapping positions, same-minute targets counted as wins and touch-bar look-aheads.

The live IPO paper runner uses the same engine, so its forward results carry the same
two look-aheads (touch-bar and zone selection).
