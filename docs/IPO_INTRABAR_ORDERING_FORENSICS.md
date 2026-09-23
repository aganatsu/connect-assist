# IPO intrabar execution-ordering — forensic report

**Investigation only. NO STRATEGY LOGIC WAS CHANGED.** No IPO rule, no
contraction rule, no entry/exit rule, no S2 rule, no sequencing rule, no SMC
code, no database result, no deployment, no break/retest logic. The only files
added are a diagnostic test suite, a read-only measurement script, and this
document. Dated 2026-09-23.

---

## 0. The finding, up front

**Half the IPO corpus is causally unsupported, and it carries more than the
entire portfolio profit.**

Replaying the unmodified live engine over the 3,764 bars currently persisted in
`ipo_engine_state`:

| | n | total R | avg R |
|---|---|---|---|
| causally supported | 82 | **−15.43** | −0.188 |
| not supported by OHLC | 82 | **+90.50** | +1.104 |
| **all** | **164** | **+75.07** | +0.458 |

Every trade in the unsupported half entered and exited on the same bar with a
target exit. **Nought of the 82 is flagged by `sameBarAmbiguous` today.**

This does not prove the 82 are losses. It proves the recorded outcome does not
follow from the evidence, and that the strategy's measured edge lives entirely
inside the part that cannot be verified at 1-hour resolution.

---

## 1. Root cause

Every execution path derives the entry from one extreme of a bar, then
immediately evaluates the new position against **the whole of that same bar**.
An OHLC bar carries four numbers and no path, so an extreme that occurred
*before* the entry touch can resolve a position that did not yet exist.

This is **not** inter-bar lookahead. The engines are strictly causal across
bars — that was established when the 2,113-trade batch result was retired. It is
**intrabar temporal ambiguity**: causal between bars, blind within one.

---

## 2. The exact code path

```
ipoLiveEngine.ts  LiveEngine.feed(bar)                             line 120
  ├─ reached = long ? bar.low <= entry : bar.high >= entry         line 149
  ├─ this.open = { entry, stop, target, … }                        line 162
  └─ const sameBar = this.manageOpen(k)          ← SAME BAR        line 170
       ipoLiveEngine.ts  LiveEngine.manageOpen(k)                  line 188
         ├─ hitTarget    = long ? c.high >= t.target : …           line 198
         ├─ closedBeyond = long ? c.close < t.stop  : …            line 199
         ├─ if (closedBeyond) → S2_CLOSE_INVALIDATION              line 202
         └─ if (hitTarget)    → close(k, t.target, 2 − costR)      line 206
```

`c.high` on line 198 is the high of the entire bar, including the portion that
preceded the entry touch on line 149.

Three further implementations repeat it independently:

| file | function | site |
|---|---|---|
| `ipoIncrementalEngine.ts` | `feed` → `manageOpen` | `const sameBar = this.manageOpen(K)` line 343; comparators line 462–463 |
| `ipoPaperContract.ts` | `stepPosition` | comparators line 301–303 |
| `ipoPaperRunner.ts` | `runPaper` | `stepPosition(pos, closedBars[entryIdx], 0)` line 428 |
| `ipoRawBacktest.ts` | `simulate` | `for (let k = setup.touchIndex; …)` line 114 |

Test `E1` asserts all four carry the same comparator shape, so none can be fixed
in isolation without the others silently disagreeing.

---

## 3. Stored candle evidence

Read back from `ipo_engine_state:ipo_cet:BTC/USD` (1,241 bars, updated
2026-09-23T19:00:01Z):

```
2026-09-23T13:00:00Z   O 85510.90  H 85878.01  L 85288.00  C 85778.63
2026-09-23T14:00:00Z   O 85792.01  H 85940.32  L 83864.07  C 84530.00   ← entry bar
2026-09-23T15:00:00Z   O 84534.00  H 84794.01  L 84020.00  C 84038.01
```

Setup: BTC/USD 1h, IPO candle 2026-09-21T10:00:00Z, long,
entry 84473.315, S2 84130.21, risk 343.105, target 85159.525.

The engine's reasoning on the entry bar:

```
low  83864.07 <= 84473.315  → entry reached
high 85940.32 >= 85159.525  → target reached
close 84530.00 >  84130.21  → not S2-invalidated
                            ⇒ TARGET_2R, gross 2R, realized 1.26089681R, $252.18
```

**The decisive number is the OPEN: 85792.01, already above the 85159.525
target.** The target was satisfied before the bar traded a single tick of the
entry. This is venue-independent — it comes from the stored bar itself, not from
any external reference.

Note also the **next** bar closes at 84038.01, below S2.

---

## 4. Lower-timeframe sequence (Bitstamp, supplied)

```
14:00  1m  H 85839  L 85754     entry not touched
14:13      first entry touch at 84473.315    ← the position begins here
14:14  1m  H 84880  L 84728     rebound peaks at 84880 < 85159.525 target
14:23      price touches S2 84130.21         ← touch only, NOT invalidation
14:30  1m  H 84097  L 83943     whole candle below S2; its CLOSE invalidates
```

Causal outcome: **S2 close invalidation**, not a 2R win. Post-entry MFE was
≈ (84880 − 84473.315) / 343.105 = **1.19R**, against the **4.28R** the engine
recorded (test `B3`).

---

## 5. Why TARGET_2R is not causally proven

The engine's claim requires the 85940.32 high to occur *after* 14:13. For that,
price would have to open at 85792, fall 1,319 points to the entry, rally 1,467
points to a new high, then fall 2,076 points to the low, then close at 84530 —
inside one hour. The 1-minute data says it did not: the post-entry rebound
stopped at 84880.

But the stored bar alone is already sufficient to withhold the claim: **a long
whose entry bar opens above its own target cannot have reached that target as a
post-entry move.**

---

## 6. Paper engine impact

The paper layer does **not** adopt the engine's result — it recomputes it
(`ipoPaperRunner.ts:428`). Event chain:

```
INTENT_CREATED  →  FILLED  →  stepPosition(entry bar)  →  CLOSED TARGET_2R
```

all four stamped `bar_time = 2026-09-23T14:00:00Z`, confirmed in
`ipo_execution_events`.

Two independent implementations of one wrong assumption **agree**, so the
divergence guard stays silent. Agreement is not correctness — the guard can only
catch the engines drifting apart, never both being wrong in the same way.

Reproduced by tests `B1`, `B2`, `E3`.

---

## 7. Live engine impact

Identical (§2). The live and incremental engines share `manageOpen` line for
line; the oracle-equivalence proof between them holds and is unaffected, because
both are wrong identically.

---

## 8. Raw backtest impact

`simulate()` scans exits from `k = setup.touchIndex` — the touch bar itself is
index 0 of the exit loop. Test `D1` shows the BTC setup exiting at
`exitIndex === touchIndex` with `grossR = 2`, `outcome = "WIN"`.

`ipoRawBacktest` already carries an `ambiguous` flag, but only for
`hitTarget && hitStopIntrabar` under `S1_HARD_EXTREME`. It is target-versus-stop
contention, not entry-versus-target ordering.

---

## 9. Blast radius

`local-runner/intrabar-audit.ts`, read-only, replays the unmodified
`ipoLiveEngine` over the persisted bars and classifies every trade:

| bucket | meaning | n | total R | avg R |
|---|---|---|---|---|
| `MULTI_BAR` | exited on a later bar; outcome unaffected | 77 | −21.65 | −0.281 |
| `ORDER_PROVEN_OPEN` | bar opened at/beyond entry, so entry is the first tick | 5 | +6.23 | +1.246 |
| `ORDER_PROVEN_CLOSE` | exited on the close, which is the bar's last event | 0 | 0 | — |
| `ORDER_UNRESOLVED` | opened between entry and target; OHLC cannot order them | 27 | +26.82 | +0.993 |
| `PRE_ENTRY_TARGET` | **opened already beyond target; outcome contradicted** | 55 | +63.67 | +1.158 |

Per instrument:

| instrument | bars | trades | MULTI | PROVEN_OPEN | UNRESOLVED | PRE_ENTRY | all R | supported R | unsupported R |
|---|---|---|---|---|---|---|---|---|---|
| EUR/USD | 1240 | 60 | 20 | 4 | 13 | 23 | +46.96 | −3.42 | +50.38 |
| USD/JPY | 1283 | 73 | 40 | 0 | 11 | 22 | +32.74 | +3.79 | +28.95 |
| BTC/USD | 1241 | 31 | 17 | 1 | 3 | 10 | −4.62 | −15.79 | +11.17 |
| **portfolio** | **3764** | **164** | **77** | **5** | **27** | **55** | **+75.07** | **−15.43** | **+90.50** |

- Unsupported share of trades: **50.0%**
- Unsupported share of total R: **120.5%**
- Trades opening already beyond target: **55**
- Same-bar S2 close exits: **0**

**Telemetry gap, measured:** of the 82 unsupported trades, **0** are
`sameBarAmbiguous = true` and **82** are `false`. The flag is
`hitTarget && closedBeyond`; it has no concept of entry ordering, so it misses
the entire population. Test `C1` pins this; `C2` shows the flag still works for
the case it was built for.

**Why so common:** the 2R target sits at twice the risk distance, and IPO risk
distances are small relative to an hour's range. EUR/USD 2026-09-01T07:00:00Z had
risk of 3.95 pips — a target only 7.9 pips from entry. Any ordinary hourly bar
straddles both levels.

I am **not** claiming these 82 are losses. `ORDER_UNRESOLVED` genuinely could go
either way, and some `PRE_ENTRY_TARGET` trades might still have reached target
again after entry. The claim is narrower and firmer: the recorded outcome does
not follow from the recorded evidence.

---

## 10. Locked 1,039-trade baseline

`docs/IPO_FORWARD_TRADING_SPEC.md` §11 states the baseline came from
*"`ipoLiveEngine.ts` replaying all 15 untouched validation windows one closed bar
at a time"* — **the exact engine audited here**. The baseline therefore carries
the same exposure.

**The locked table is NOT modified, and no replacement expectancy is published.**

Measuring it directly requires re-fetching the 15 validation windows; those
candles are not stored locally and the research path needs a provider key this
investigation did not use. What can be said:

- The 164-trade sample above is drawn from the same engine on the same
  instruments and is the best available estimator: **50% of trades unsupported,
  carrying 120% of total R**.
- If that rate holds, roughly **520 of the 1,039** baseline trades are
  intrabar-order-dependent, and the **+607.7R** headline rests substantially on
  them.
- `local-runner/intrabar-audit.ts` will measure the baseline exactly, unchanged,
  as soon as it is pointed at the validation windows. Any corrected figure must
  be published as a **separate, versioned research result**, never as an edit to
  the locked table.

---

## 11. Provider and feed findings

The IPO runner fetches through `fetchCandlesWithFallback`, a three-provider
chain: **MetaAPI → TwelveData → Polygon**.

| provider | BTC symbol | nature |
|---|---|---|
| MetaAPI | broker symbol | broker CFD price, venue = the broker |
| TwelveData | `BTC/USD` | composite crypto price, not a single venue |
| Polygon | `X:BTCUSD` | crypto aggregate across exchanges |

**None of these is Bitstamp.** The manual validation reference and the stored
candle come from different venues, and which of the three served any given bar
is not recorded. Cross-venue BTC drift is typically under 0.1%, but on this trade
risk is 343 points on an 85,000 price — 0.4% — so 0.1% of drift is **0.25R**.
That does not weaken §3 (the open-above-target evidence is internal to the stored
bar) but it does mean the 1-minute timings in §4 should be treated as strong
corroboration rather than as the same tape.

**Timezone and alignment.** `candleSource.ts:595` requests
`timezone=UTC` explicitly, and the comment at line 590 records why: TwelveData
defaults to exchange timezone and `mapTwelveDataValues` appends `"Z"` to whatever
comes back. That fault was found and fixed on 2026-09-08. Bar alignment is
therefore UTC hour boundaries on both sides, matching the stored
`2026-09-23T14:00:00Z`.

**Observability gap.** `fetchCandlesWithFallback` returns `{ candles, source }`.
`ipo-paper-runner/index.ts:303` destructures **`const { candles } = …`** and
discards the source. No IPO table has a provider, venue or feed column —
`evidence_source` and `source_family` exist only on the research corpus tables.
So for any stored IPO trade it is currently impossible to say which provider
produced the bar that resolved it. **Schema not modified.** Recording the source
would be one field on the position row plus one word at the destructure.

---

## 12. Level immutability (verified)

Tests `G1` and `G2`. `stepPosition` is pure: it spreads into a new object and
never writes to its input. Across a step, exactly three fields change —
`maeR`, `mfeR`, `lastManagedBarTime`. `entryPrice`, `targetPrice`,
`s2InvalidationLevel`, `nominalRiskDistance`, `costR` and `ipoCandleTime` are
byte-identical before and after, and the BTC values held at
84473.315 / 85159.525 / 84130.21 / 343.105 through the lifecycle.

No recalculation path can mutate a live paper trade's levels.

---

## 13. P&L derivation

```
stepPosition, hitTarget branch:
  gross      = |targetPrice − entryPrice| / nominalRiskDistance   → 2 (to 1e-12)
  exitPrice  = pos.targetPrice                                    ← the LEVEL
  realizedR  = grossR − costR       = 2 − 0.73910319 = 1.26089681
  realizedPnlUsd = realizedR × nominalRiskUsd = 1.26089681 × 200 = 252.179362
```

Reproduced exactly by test `B1` from the stored bar.

**There is no independently observed execution price.** The moment `hitTarget`
is true the intended target becomes the synthetic exit, so `grossR` is 2 by
construction — it is an assumption restated, not a measurement. Test `B2` pins
this. Consequently a target exit can never record slippage, partial fill, or a
fill worse than the level, and in this incident it records a fill at a price the
position may never have traded at post-entry.

---

## 14. Proposed lower-timeframe resolution architecture (design only)

Not implemented. Not recommended yet.

```
1h / 30m   IPO detection, lifecycle, validity, suppression, clearance   UNCHANGED
1m         execution sequencing within the entry bar and the exit bars
tick       fallback only when one 1m candle itself straddles entry and target
```

For an HTF trade, the 1-minute series over the HTF bar reconstructs:

| quantity | rule at 1m |
|---|---|
| entry timestamp | first 1m bar where `low <= entry` (long) |
| post-entry MFE | max `high` over 1m bars **at or after** the entry bar |
| target touch | first 1m bar at/after entry where `high >= target` |
| S2 touch | first 1m bar at/after entry where `low <= S2` — **informational only** |
| S2 close invalidation | first 1m bar at/after entry whose **close** `< S2` |

**S2 stays close-confirmed.** The distinction the BTC case turns on — 14:23 touch
versus 14:30 completed close — must survive the resolution change. Test `F1`
pins that a wick through S2 is not an exit, so a future implementation cannot
quietly convert S2 into a touch rule while fixing ordering.

Residual ambiguity: a single 1m candle that contains both entry and target. In
the BTC hour that is 60 candles instead of 1, so the ambiguous window shrinks by
roughly 60×, but it does not vanish — hence the tick fallback.

**What this is not.** It is not "ignore the entry bar's target". Doing that would
delete the 5 `ORDER_PROVEN_OPEN` trades, which are legitimate same-hour wins, and
would replace one unsupported assumption with another. The point is to establish
order from finer evidence.

Cost sketch: 1m bars for one HTF bar = 60 rows per resolved trade; at 164 trades
over ~52 days that is a backfill, not a live feed. Live resolution is the
expensive part — see §15.

---

## 15. Operational implications for real money

Current IPO cadence is `*/15`. Under 1-minute execution resolution that is
insufficient for three separate reasons:

1. **Detection latency.** An entry touched at 14:13 is not seen until 14:15 at
   best — and today, not until the 1h bar closes at 15:00.
2. **Ordering evidence is only available after the fact.** A 15-minute poll can
   reconstruct the past, which is enough for honest *measurement*, but not enough
   to *act* at the moment of entry.
3. **S2 close confirmation** needs each completed 1m bar; a 15-minute poll
   collapses fifteen of them into one observation and cannot say which closed
   first.

Split-architecture sketch, **not a recommendation**:

| | HTF strategy runner | active execution monitor |
|---|---|---|
| cadence | `*/15`, unchanged | per minute, or streaming |
| job | detection, lifecycle, validity | entry/exit sequencing on live positions |
| data | 1h / 30m closed bars | completed 1m bars (+ quotes for touch) |
| runs when | always | only while a position is open or armed |

Polling 1m every minute vs streaming:

| | 1m polling | streaming quotes + closed 1m bars |
|---|---|---|
| correctness | good for close-confirmed S2; misses intra-minute touch order | best available short of tick |
| latency | up to 60s | sub-second for touch |
| API cost | 1 req/min/instrument ≈ 4,320/day for 3 | connection-based, but the fallback chain has no streaming path today |
| complexity | reuses the existing fetch chain | new transport, reconnect/gap handling, and the market-data audit already declined WebSocket once |

I am **not** making a recommendation. The honest sequence is: measure the
baseline with 1m backfill first (cheap, offline, answers whether the edge
survives), and only then decide whether live 1m resolution is worth building. If
the edge does not survive the measurement, the execution question is moot.

---

## 16. Code and functions affected (none modified)

| file | function | role in the defect |
|---|---|---|
| `_shared/ipoLiveEngine.ts` | `feed`, `manageOpen` | origin; entry bar managed on entry |
| `_shared/ipoIncrementalEngine.ts` | `feed`, `manageOpen` | identical copy |
| `_shared/ipoPaperContract.ts` | `stepPosition` | independent reimplementation; `sameBarAmbiguous` gap |
| `_shared/ipoPaperRunner.ts` | `runPaper` | explicit entry-bar step |
| `_shared/ipoRawBacktest.ts` | `simulate` | exit scan starts at `touchIndex` |
| `ipo-paper-runner/index.ts` | fetch block | discards `source` (observability gap) |

---

## 17. Tests and tools added

`supabase/tests/_shared/ipoIntrabarOrdering.test.ts` — 16 tests, all green. They
assert **current** behaviour deliberately: a red test would break CI and prove
nothing extra, and these become the regression guard when a fix lands.

```
A1  entry, target and S2 conditions on the stored bar
A2  the bar OPENED above target — target extreme is pre-entry
A3  the 1h close rule masks a 1m close that did invalidate
B1  stepPosition books TARGET_2R, reproducing the stored row exactly
B2  the exit price is the intended level, never an observed fill
B3  MFE inflated to 4.28R against a real post-entry 1.19R
C1  sameBarAmbiguous is FALSE on this trade — the semantic gap
C2  the flag still fires for target-vs-S2, the case it was built for
D1  simulate() exits on the touch bar itself
D2  the following 1h bar closes below S2
E1  all four implementations share the comparator shape
E2  both engines manage the entry bar explicitly
E3  the paper runner recomputes rather than adopts
F1  a wick through S2 is not invalidation
G1  levels immutable across a step
G2  only maeR, mfeR and lastManagedBarTime advance
```

`local-runner/intrabar-audit.ts` — read-only classifier (§9). Replays the
unmodified engine; writes only to `/tmp`.

**Suite results after adding them:**

```
deno  supabase/tests       1301 passed   0 failed
deno  supabase/functions   1569 passed   0 failed
deno check (edge, all)     clean
vitest                      262 passed  (19 files)
tsc --noEmit                clean
npm run build               clean
```

---

## 18. Deferred research note — break/retest (NOT IMPLEMENTED)

After this BTC IPO invalidated, price returned into the original IPO zone and the
trader observed bearish break/retest behaviour. Recorded intent, for a future and
separately specified piece of work:

> an invalidated demand IPO may become a bearish breaker/retest candidate, and a
> short entry must occur **inside the original IPO zone**.

No lifecycle state, rule, or trading logic exists for this. Nothing in this
investigation implements, prepares or presumes it.

---

## 19. Statement

**No strategy logic was changed by this investigation.** No IPO detection,
lifecycle, contraction, FVG, direction, E2 entry, S2 invalidation, 2R target,
re-entry, sequencing, volatility or cost rule was modified. No SMC code, no
broker execution, no LIVE/CANARY behaviour. No database row was written or
altered. No schema change. Nothing was deployed. The locked 1,039-trade baseline
is untouched and no replacement expectancy is published here.
