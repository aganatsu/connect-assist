# IPO_ENTRY_QUALITY_TELEMETRY_V1

**Question.** Does the way price approaches, touches, penetrates, rejects and leaves
the IPO zone carry causal information about trade quality in the frozen
`IPO_BASELINE_1H_4H_CAUSAL_V1` control?

**Verdict: NO ROBUST ENTRY-QUALITY FILTER FOUND.** One cohort passed the frozen
numeric screen, but it fails Part 18's robustness and mechanism conditions (see O).
No unseen-data rule is proposed.

**More important than the verdict: the frozen baseline has a look-ahead (see B.3).**
The engine only enters on touch bars whose *close* stays inside the stop, but it
fills intrabar at the 50% level, before that close exists. 0 of 1,032 touch bars
close beyond the stop, while 163 of the next bars do. The live IPO paper runner
inherits the same selection. The effect is unmeasured and could be large.

Telemetry only: nothing was filtered, nothing deployed, and no production IPO logic or
baseline trade was changed.

| File | Contents |
|---|---|
| `local-runner/entryQuality.ts` | pure feature module + leakage firewall |
| `local-runner/ipo-entry-m1-fetch.ts` | 1m corpus, coverage manifest, OHLC repair |
| `local-runner/ipo-entry-quality-telemetry.ts` | gate, analysis, exports |
| `supabase/tests/_shared/entryQuality.test.ts` | 20 tests |
| `docs/exports/ipo_entry_quality_telemetry_v1.csv` | 1,032 trades × 135 columns: `pre__*` decision-time features, `post__*` outcomes |
| `docs/exports/ipo_entry_quality_cohorts_v1.csv` | frozen tests, deciles, management signals, post-hoc blocks |
| `docs/exports/ipo_entry_quality_stability_v1.csv` | every frozen test across 7 slices |
| `docs/exports/ipo_entry_quality_mae_mfe_v1.csv` | per-trade post-entry path |

---

## A. CONTROL

The frozen trades were tagged, not re-run (the accepted approach). The gate was
stricter than in the TTM and market-context studies. **1,032 of 1,032 trades pass:**

- **IPO candle:** byte-identical in the re-fetched 1H/4H series.
- **Zone:** equal to production `ipoGeometry()` (zone high/low, entry = 50% level, S2 = IPO extreme).
- **Entry bar:** present, reaches the entry price, after the IPO candle; fill minute inside the touch bar.
- **1m equivalence:** the re-fetched 1m stream re-derives every frozen 1m decision — the fill minute (= `m1_entry_time`), the S2 bar (= `s2_invalidation_time`), and the target minute (= `m1_target_time`), hence the exit reason.
- **Coverage:** every window a trade reads has no unproven hole (see Data quality).
- **No 1m glitch** in any window a trade reads.

| | n | WR | Expectancy | PF | Net | DD (file order) | DD (chronological) |
|---|---|---|---|---|---|---|---|
| Frozen | 1,032 | 61.5% | +0.202R | 1.25 | +208.3R | 41.3R | 45.6R |
| Reproduced | 1,032 | 61.5% | +0.202R | 1.25 | +208.3R | 41.3R | 45.6R |

All new drawdowns are chronological.

### Data quality

**1m corpus.** The `/tmp` 1m files are gone, so the corpus was rebuilt with 214
paced requests: 4h before each touch bar to 2h after each exit. It is cached in
`local-runner/.cache/ipo-m1/`. The key is shared with the production scanner; the
build drew three 429s and was slowed to 3/min, then 2/min.

**Coverage manifest.** Paging leaves holes between fetched stretches, and a hole
looks identical to market closure. So every page records the range it covered.
- A gap of more than 60 minutes is accepted only if it is an FX weekend or lies inside a covered range.
- The S2 window ends at the S2 bar's **close**. The export's `exit_time` for S2 rows is the bar's **open**.
- An off-by-one in the first version of this check made unproven gaps look unresolved. It was fixed before any analysis.

**OHLC repair.** The provider's EUR/USD 1m feed for Dec 2024–Mar 2025 has 1,151
bars whose open or close lies outside the bar's own high–low. The pattern is
precision loss: `1.0497` → `1.05`, even `1.1`.
- High and low are consistent in every such bar, so open/close are clamped into [low, high]. Residual error is bounded by the bar's own range.
- 126 trades have at least one clamped bar in their window (3,299 bars in total).

**Glitch rule.** An isolated spike more than 20× the typical range fails the gate.
"Typical" is the larger of the instrument's median range and the ±30-bar local median.
- The first version used the global median alone. It flagged 10 **real** events: BTC 2025-01-20, the 2025-10-10 crash, and the USD/JPY payrolls minute on 2025-02-07.
- It was replaced before any feature analysis. The 2023 BTC glitch class (lows of 2.58 against ~26,000) is still caught; there is a test for it.

**1H/4H closes.** The same EUR/USD era has a few corrupt 1H/4H closes,
e.g. 2024-11-28 11:00 `close 1.05` and 2025-01-14 15:00 `close 1.03`.
- Two frozen trades have one inside their life.
- In both, the corrupt close and the true close (bounded by the bar's high/low) sit on the same side of the stop.
- **No frozen decision is affected.**

## B. CAUSALITY / LEAKAGE

**1. Firewall.**
- `preEntryFeatures()` throws if handed any 1m bar at or after the fill minute, or any strategy-timeframe bar at or after the touch bar.
- Cohorts and trend tests are declared as data. `assertPreEntryOnly()` checks every key before any analysis.
- Cohorts are evaluated on `pickPre()`, a frozen projection that holds pre-entry keys only.
- Tests fail if an outcome (`mae_r`, `net_r`, `reached_1r`, …) is used in a pre-entry analysis, or if an outcome change can move a cohort.
- The trade CSV prefixes every column `pre__` or `post__`.

**2. Mutation proof.** Each planted bug was caught by at least one test:
- leaking the fill minute into the prefix;
- removing the firewall throw;
- adding `mae_r` to the trend list;
- counting occupancy as new touches;
- counting the fill minute's high in MFE;
- `pickPre` passing everything through;
- allowing unconfirmed swings in the sweep;
- off-by-one re-entries;
- dropping the local-volatility base from the glitch rule.

The first run of this list let the unconfirmed-swing plant through; a test was added for it.

**3. Baseline selection (outside this study's scope, reported because it matters most).**

`runLifecycle` (`ipoLifecycle.ts`) checks invalidation (a close beyond the IPO extreme)
*before* it records a touch. So a bar that reaches the 50% level and closes beyond the
stop is never a touch, and the engine never enters on it. The fill, however, is
intrabar (the 1m fill minute), so a resting order would already have filled before
that close existed.

| Evidence | Count |
|---|---|
| Touch bar closed beyond the stop | **0 / 1,032** |
| Next bar closed beyond the stop | 163 / 1,032 |
| S2 exits by bar offset from the touch bar | 0: **0**, 1: 134, 2: 64, 3: 44, 4: 31, 5: 21, 6+: 90 |

The touch bar is the bar deepest into the zone, so closes beyond the stop should be at
least as common there as on the next bar. Its total absence is the selection.

The missing trades would be immediate S2 losses of at least ~1R plus cost. Their number
and their effect on the slot sequence are **unmeasured**. Measuring them means
re-running the engine with the touch recorded before the invalidation check: a new
baseline, which needs your authorization.

`ipoPaperRunner.ts` opens paper positions from the same engine trades and fills them
retroactively inside the entry bar. **The live forward test carries the same survivor
selection.**

## C. ZONE PENETRATION (Part 1, Part 2, family A)

- **Degenerate by construction:**
  - The frozen fill is at the 50% level, so `fill_depth_pct_of_zone` = 100% for all 1,032 trades.
  - `zone_width_to_risk` = 1, `entry_depth_to_risk` = 1 and `planned_r` = 2 for every trade.
  - `ipo_range_atr` = 2 × `zone_width_atr`: one feature, not two.
- **What family A measures:** the deepest penetration reached by the *closed* 1m bars of the current visit before the fill.
- **Pre-fill depth >100% in 363 trades.** The engine often enters deep inside an ongoing visit:
  - The production touch rule compares against the last recorded touch, not the last in-zone bar, so during sustained occupancy every other bar is a new "touch".
  - Earlier bars of the same visit may also have been refused or skipped.
  - Price had already traded through the entry level before the fill.
- **Fill bar opened beyond the entry in 287 trades (28%).** The recorded fill at the 50% level is then worse than the price available at that minute's open: conservative for the trade in isolation.

| Depth bucket | n | WR | Expectancy | Δ vs rest | p | Holm | BH | Stability |
|---|---|---|---|---|---|---|---|---|
| 0–20% | 65 | 86.2% | +1.022 | **+0.875** | 0.002 | 0.068 | **0.035** | STABLE |
| 20–40% | 19 SMALL | 89.5% | +1.134 | +0.950 | 0.046 | 1.000 | 0.226 | TOO_SMALL |
| 40–60% | 54 | 72.2% | +0.563 | +0.381 | 0.188 | 1.000 | 0.487 | TOO_SMALL |
| 60–80% | 123 | 68.3% | +0.420 | +0.248 | 0.211 | 1.000 | 0.487 | STABLE |
| 80–100% | 408 | 58.3% | +0.029 | −0.286 | 0.029 | 0.885 | 0.172 | REVERSES |
| >100% | 363 | 55.4% | +0.073 | −0.199 | 0.135 | 1.000 | 0.431 | STABLE |

## D. TOUCH COUNT (Part 4, family B)

**Frozen definition** (fixed before results):
- A visit is a run of consecutive strategy-timeframe bars whose adverse extreme crosses the near edge, counted from the bar after the IPO candle. A bar that does not cross ends the visit.
- 1m re-entries are genuine exit-and-return events inside the touch bar, before the fill.

**Frozen definition is flawed.** It counted from the IPO candle, but production only
tracks a zone from `validAt`: the first close that clears the prior contraction. In
1,011 of 1,032 trades, an earlier strategy-timeframe bar since the IPO candle had
already traded through the entry level, either before validation or on a bar the
engine did not treat as an entry touch. So the frozen touch count mixes visits to a
zone that did not yet exist.

| | n | Expectancy | Δ vs rest | p | BH | Stability |
|---|---|---|---|---|---|---|
| FIRST TOUCH (frozen definition) | 72 | −0.088 | −0.311 | 0.223 | 0.487 | MIXED |
| FIRST TOUCH since validation *(post-hoc)* | 67 | +0.417 | +0.227 | 0.387 | — | not eligible |
| 3+ prior touches since validation *(post-hoc)* | 606 | +0.139 | −0.161 | 0.222 | — | not eligible |

**Post-hoc re-count** (production lifecycle record, its own touch list, strictly before
the touch bar):
- 1,023/1,032 trades have a record validated before the touch bar. Every one of those touch bars is in the engine's own touch list.
- A 30-trade prefix-stability sample matched 30/30.
- Prior-touch distribution: 0: 67 · 1: 174 · 2: 176 · 3: 153 · 4: 115 · 5+: 338.
- **No separation either way.**

1m re-entries inside the touch bar: 0 in 760 trades (+0.200R), 1 in 154 (+0.367R),
2 in 64 (+0.307R). Trend r ≈ 0.

## E. APPROACH QUALITY (Part 5, Part 6)

Over the last 3, 5 and 10 closed 1m bars, all stored raw: return, range, directional
bar ratio, body dominance, overlap, path efficiency, slope (ATR/bar), average body and
wick ratios, and 10-bar acceleration.

- **Labels:** no production rule for "grinding" exists, so the only label is IMPULSIVE: a production-rule displacement candle toward the zone in the last 5 bars (316 trades).
- **Rejection (last closed bar):** production rejection wick (>30%) in 282 trades, engulfing in 161, close back outside the zone in 67.
- **Frozen trend tests (10-bar window):** body dominance had raw p 0.005 and overlap 0.012, but both REVERSE across slices.
- **Post-hoc trend (cost-corrected):** every approach and rejection metric has |r| ≤ 0.06 and none is stable in sign.
- **Approach character carries no information.**

## F. SWEEP (Part 7, family C)

**Definition** (one version only): within the last 20 closed 1m bars, a bar trades
through the most recent swing (production `detectSwingPoints`, lookback 3) *confirmed
before that bar*, and closes back (production sweep rule).

The first draft took the "last confirmed swing" globally, which lets a sweeping wick
shadow the swing it swept. It was fixed before results, and a test covers it.

| | n | Expectancy | Δ | p | BH | Stability |
|---|---|---|---|---|---|---|
| SWEEP PRESENT | 386 | +0.336 | +0.215 | 0.109 | 0.381 | **REVERSES** (BTC −0.322, 4H −0.065) |

## G. MICRO CHoCH (Part 8, family D)

Production `analyzeMarketStructure` on the last 120 closed 1m bars. Present = a CHoCH
in the trade's direction whose index is at or after the visit start.

| | n | Expectancy | Δ | p | BH | Stability |
|---|---|---|---|---|---|---|
| ALIGNED CHoCH SINCE FIRST TOUCH | 260 | +0.079 | −0.164 | 0.266 | 0.499 | REVERSES |

Close-based for every CHoCH (production only emits close-confirmed breaks).

## H. DISPLACEMENT (Part 9, family E)

Production `detectDisplacement` (body ≥ 2× average, body/range ≥ 0.7, range ≥ 1.5×
average) on the last 60 closed 1m bars, direction relative to the trade.

| | n | Expectancy | Δ | p | BH | Stability |
|---|---|---|---|---|---|---|
| FAVORABLE DISPLACEMENT | 69 | +0.238 | +0.038 | 0.882 | 0.964 | REVERSES |
| ADVERSE DISPLACEMENT (impulsive approach) | 316 | +0.205 | +0.004 | 0.976 | 0.976 | REVERSES |

Strongest favorable reaction since first touch and reaction efficiency: post-hoc
r −0.063 and below, not significant.

## I. FILL QUALITY (Part 10, family G)

`intended_vs_actual_entry_difference` = **0 for all 1,032 trades**: the frozen runner
fills a limit at the intended price. This is not slippage, and no broker data exists to
measure slippage. Family G is a single bucket and is untestable (degenerate).

- Distance from the IPO candle's midpoint (the 50% level, which is also the zone's far edge) = 0.
- Distance from the zone's own midpoint = half the zone width = 0.5R.
- Remaining room to invalidation = exactly 1R.
- 287 fill minutes opened beyond the entry (see C).

## J. INITIAL RISK (Part 11)

Risk = zone width = half the IPO candle's range; planned R = 2 for every trade. Two
pre-entry quantities vary.

**1. Cost in R spans 0.008–3.0** (p10 0.07, p90 0.65). **13 trades hit the target and
still lost money** because cost exceeded 2R.

**2. Risk relative to volatility.** Post-hoc trend (not eligible): `risk_atr_1m`
r −0.175, negative in all 7 slices. `zone_width_atr` r −0.136, negative in all 7.

| `risk_atr_1m` decile | Expectancy |
|---|---|
| D1 | +1.07R |
| D2 | +0.64R |
| D3 | +0.37R |
| D9 | −0.31R |
| D10 | −0.32R |

Small zones relative to volatility do better. The frozen Spearman test missed this:
see N.

## K. MAE/MFE (Part 12)

From the fill to the exit instant (TARGET: the target minute; S2: the S2 bar's close).

| | n | Mean MAE | Median MAE | Mean MFE | Median minutes to MAE | Median minutes to MFE |
|---|---|---|---|---|---|---|
| Winners | 635 | 0.850R | 0.634R | 2.000R (capped at target) | 7 | 96 |
| Losers | 397 | 2.586R | 2.177R | 0.944R | 194 | 57 |

Losers reached +0.25R in 87.4%, +0.5R in 73.3%, +1R in 43.6%, +1.5R in 22.9%, +2R in
3.3% (the 13 net-negative targets).

Losses run far beyond 1R because S2 is a 1H/4H *close* beyond the IPO extreme, not a
resting stop.

**Window conventions:**
- The fill minute contributes its adverse extreme and its close, never its favorable extreme (which may precede the fill).
- 20 TARGET trades hit the target inside the fill minute. There the frozen runner's same-minute convention is taken as given and flagged.

## L. EARLY FAILURE SIGNATURES (Part 13)

| Horizon | Mean MAE (L / W) | Mean MFE (L / W) | Share reaching −0.5R (L / W) |
|---|---|---|---|
| 5m | 0.360 / 0.433 | 0.251 / 0.545 | 26.2% / 28.0% |
| 15m | 0.547 / 0.561 | 0.428 / 0.881 | 42.8% / 38.6% |
| 30m | 0.711 / 0.637 | 0.533 / 1.120 | 54.2% / 44.4% |

Early **adverse** excursion barely separates winners from losers. Early **favorable**
excursion does (see P).

## M. STABILITY (Part 15)

Slices: EUR/USD, USD/JPY, BTC/USD, 1H, 4H, older (2022 windows), newer (2025 windows).
The full table is in `ipo_entry_quality_stability_v1.csv`. Labels (frozen):
- **TOO_SMALL:** fewer than 4 slices with n ≥ 15.
- **REVERSES:** a slice with n ≥ 30 has the opposite sign.
- **STABLE:** no opposite sign in any evaluable slice.
- **MIXED:** otherwise.

| Feature | Combined | EUR/USD | USD/JPY | BTC/USD | 1H | 4H | Older | Newer | Label |
|---|---|---|---|---|---|---|---|---|---|
| DEPTH 0–20% | +0.875 (65) | +0.738 (28) | +1.332 (19) | +0.636 (18) | +0.915 (54) | +0.689 (11) | +0.823 (18) | +0.904 (47) | STABLE |
| TTF 0 min | +0.895 (49) | +0.758 (22) | +1.234 (15) | +0.720 (12) | +0.976 (39) | +0.580 (10) | +0.663 (15) | +1.011 (34) | STABLE |
| TTF 1–15 min | +0.251 (407) | +0.397 | +0.125 | +0.123 | +0.131 | +0.929 | +0.400 | +0.203 | STABLE |
| SWEEP PRESENT | +0.215 (386) | +0.309 | +0.341 | **−0.322** (64) | +0.291 | −0.065 | +0.145 | +0.212 | REVERSES |
| FIRST TOUCH | −0.311 (72) | −0.366 | +0.347 | −0.862 | −0.343 | −0.178 | +0.144 | −0.512 | MIXED |
| ALIGNED CHoCH | −0.164 (260) | −0.311 | +0.074 | 0.000 | −0.100 | −0.374 | −0.066 | −0.196 | REVERSES |
| FAV. DISPLACEMENT | +0.038 (69) | +0.364 | +0.732 | −0.378 | +0.119 | −0.420 | −0.497 | +0.417 | REVERSES |

DEPTH 0–20% and TTF 0 min are nearly the same trades: all 49 TTF-0 trades are in DEPTH 0–20%.

## N. MULTIPLE TESTING (Part 16)

**One family of 35 frozen pre-entry tests** (16 cohorts + 19 Spearman trend tests);
10,000-permutation p, Holm and BH; 5,000-sample bootstrap CIs. **Family G** is
degenerate and untested.

| Test | n | Effect | Raw p | Holm | BH | Stability |
|---|---|---|---|---|---|---|
| TREND cost_r | 1,032 | ρ −0.239 | 0.0001 | 0.003 | 0.003 | STABLE — **invalid**, see below |
| DEPTH 0–20% | 65 | +0.875R | 0.002 | 0.068 | 0.035 | STABLE |
| TTF 0 min | 49 | +0.895R | 0.0035 | 0.115 | 0.041 | STABLE |
| TREND approach10 body dominance | 1,005 | ρ −0.087 | 0.005 | 0.173 | 0.047 | REVERSES |
| TREND approach10 overlap | 1,005 | ρ +0.081 | 0.012 | 0.378 | 0.085 | REVERSES |
| everything else | | | ≥ 0.029 | ≥ 0.885 | ≥ 0.172 | |

**The frozen trend statistic is mechanically confounded.** Every TARGET trade nets
2 − cost_R, and cost_R spans 0.008–3.0. Ranking by net R therefore orders all 635
winners purely by cost, which tracks risk size. Consequences:
- `cost_r`'s "significant" ρ is circular: its Q5−Q1 expectancy difference is **+0.24R**, the opposite sign.
- `risk_atr_1m` shows ρ ≈ 0 although its deciles fall monotonically.

A post-hoc replacement, Pearson(rank(feature), net R) with permutation p, is in the
cohorts CSV. It is shown for completeness and **cannot create a candidate**. Its stable
signals:

| Feature | r | Sign across all 7 slices |
|---|---|---|
| `risk_atr_1m` | −0.175 | negative |
| `minutes_from_first_touch_to_fill` | −0.145 | negative |
| `zone_width_atr` | −0.136 | negative |
| `max_penetration_before_fill` | −0.092 | negative |

These describe one mechanism: small zones relative to volatility fill fast and win
often.

## O. ENTRY CANDIDATES (Part 18)

**DEPTH 0–20% passed the frozen numeric screen:** n ≥ 60, |Δ| ≥ 0.15R, STABLE,
BH ≤ 0.10 (Holm 0.068). It does not qualify, for three reasons.

1. **Execution ambiguity.**
   - 17 of its 65 members are among the 20 trades that hit the target *inside the fill minute*.
   - For a fill on the visit's first minute, that minute came from outside the zone, so its target-touching extreme most likely came *before* the fill.
   - The frozen runner counts these as wins.
   - Without them: +0.842R vs +0.145R, Δ +0.697, p 0.023, **n = 48, below the frozen n ≥ 60 bar**.
2. **Survivor population (condition 1, causal before entry).** The cohort is measured on a baseline selected with post-fill information (B.3). A fast slice into the zone is exactly the move most likely to continue and close through the stop on the touch bar, and those failures are not in the data.
3. **Mechanism (condition 6).** Much of the cohort is the zone-size effect, not a touch-quality effect.
   - Members sit in small zones relative to 1m volatility: median `risk_atr_1m` 1.90 vs 4.08 for the rest; 25 of 65 in decile 1.
   - Within deciles 1–2 the gap shrinks to +0.41R (n = 37).

TTF 0 min (BH 0.041, n = 49) is the same trades and fails n ≥ 60 outright. Nothing else
comes close.

**NO ROBUST ENTRY-QUALITY FILTER FOUND.** No unseen-data rule is proposed. A future
test of "fast first contact" or zone-size-versus-volatility would first need a baseline
without the B.3 selection.

## P. MANAGEMENT RESEARCH SIGNALS (Part 19)

**MANAGEMENT RESEARCH SIGNAL ONLY. These use post-entry information and are not entry
evidence.** No counterfactual exit was simulated, so none of these is a measured
management improvement.

| Signal | Group A | Group B | p |
|---|---|---|---|
| Failed to reach +0.25R within 5m | −0.107R (n 518) | +0.513R reached (n 514) | 0.0001 |
| Failed to reach +0.25R within 15m | **−0.310R** (n 333) | +0.445R (n 699) | 0.0001 |
| Failed to reach +0.25R within 30m | **−0.505R** (n 244) | +0.421R (n 788) | 0.0001 |
| Early MAE ≥ 0.5R within 15m | −0.022R (n 415) | +0.353R (n 617) | 0.005 |
| Early MAE ≥ 0.5R within 30m | −0.067R (n 497) | +0.451R (n 535) | 0.0003 |
| Losers that first reached +0.5R / +1R / +1.5R | 73.3% / 43.6% / 22.9% | — | |
| Recovered to target after early MAE ≥ 0.5R within 15m | 61.7% | 63.5% rest of book | |

Takeaways:
- **No early progress is the clearest failure signature.** A quarter of trades have not reached +0.25R after 30 minutes and average −0.5R.
- **Give-back is large.** 44% of losers were up 1R first; with a close-based stop their median MAE reaches 2.2R. This matches the open question in memory: the trail gives back ~0.5R.
- **"Most losers reach −0.5R within 15 minutes" is not true.** 43% of losers do, against 39% of winners.

## Q. FINAL VERDICT

**NO ROBUST ENTRY-QUALITY FILTER FOUND.** Touch depth, touch count, re-entry,
approach character, rejection, sweep, micro CHoCH and displacement do not separate
the frozen IPO trades robustly.
- The one cohort that passed the numeric screen is partly execution ambiguity, partly zone size, and measured on a survivor population.
- What does vary stably is zone size relative to volatility. That is not an entry-quality feature, and it is exposed to the same selection.

**Priority, outside this study: audit the baseline's touch-bar look-ahead (B.3)** before
any further IPO filter research or trust in paper results. It needs authorization
because it means re-running the engine with a corrected touch rule.

### Deviation log (for the record)

**Before any result** (each fixing a defect found while building):
- sweep swing must be confirmed before the sweep bar;
- strategy-timeframe causality by series order (the provider's early 4H history is irregularly spaced);
- S2 windows end at the S2 bar's close;
- coverage manifest;
- OHLC clamp;
- glitch rule scaled by local volatility.

**After the first run** (all labelled post-hoc and barred from creating candidates):
- robustness re-test without same-minute targets;
- cost-free trend statistic;
- touch count from validation.

The frozen results are reported unchanged alongside them.
