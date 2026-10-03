# IPO_24_TRADE_CAUSAL_AUDIT_V1

> **Correction (2026-10-03).** This audit used the engine's bar-level zone selection
> (oldest zone touched anywhere in the bar). IPO_BASELINE_1H_4H_CAUSAL_V2 §6 later found
> that rule is itself a look-ahead: a newer zone that already filled can be erased by an
> older zone touched later in the same bar. Under the causal form of the rule (touch
> order), 5 of these 24 trades would not exist and 19 other trades would; the period
> total becomes −5.579R. The findings below remain correct under the bar-level rule.

**Question.** Are the 24 recorded forward-paper IPO trades causally valid under correct
intrabar event ordering?

**Answer: yes — A. ALL 24 TRADES CAUSALLY VALID.** Every trade's existence and recorded
result hold up when each decision uses only information available at the fill minute.
None of the 24 benefited from the touch-bar look-ahead.

**The look-ahead did act on this period, by omission.** Two further entries should
have existed and were suppressed because their touch bars closed beyond S2. Both lose
(−1.403R and −6.004R). They are reported separately below and are not mixed into the
24-trade totals.

Audit only. No production code was patched, nothing was deployed, and no row,
position or baseline was changed. Database access was read-only.

| File | Contents |
|---|---|
| `docs/exports/ipo_24_trade_causal_audit_v1.csv` | one row per trade: event timeline, checks, classification |
| `docs/exports/ipo_24_trade_suppressed_candidates_v1.csv` | the two suppressed entries |
| `local-runner/ipo-24-trade-causal-audit.ts` | the audit (imports production code unchanged) |
| `local-runner/ipo-24-audit-fetch.ts` | the 1m tape (9 requests at 2/min) |

## 1. Source

| | |
|---|---|
| Table | `ipo_paper_trade_history` on the live project `rvouzhacxqlbetwcttoe` (written by `ipo-paper-runner`) |
| Selection | `causal_execution_version = '1m-ordering-v1'`: **exactly 24 rows** |
| strategy_version | `spec-1.1` (all 24) |
| Date range | entries 2026-09-24 18:32 → 2026-10-02 12:56; last exit 2026-10-02 13:15 |
| Instruments / timeframes | USD/JPY 30min (13) · EUR/USD 1h (10) · BTC/USD 1h (1) |
| Identifiers | all 24 have `setup_id`, `intent_id` and `ipo_candle_time` |
| Fill timestamps | 18 of 24 have `entry_minute_time`. The other 6 were booked `HTF_UNAMBIGUOUS` without a minute; their fill minute is taken from the 1m tape |
| 1m data | present for every touch bar: 30 of 30 (USD/JPY) or 60 of 60 (EUR/USD, BTC) minutes, and for every holding period |

**Not in scope.**
- **11 earlier rows** (2026-09-22 → 09-24 17:30) have `causal_execution_version` null; they predate the 1m-ordering fix.
- **1 open position**, USD/JPY filled 10-01 15:38 with status `ordering_ambiguous`, is not one of the 24. See §6.2.

## 2. Method

1. **Engine inputs.** The persisted engine snapshots (`kv_cache` →
   `ipo_engine_state:ipo_cet:<symbol>`) contain the exact strategy bars the live
   engine processed: 1,747 USD/JPY 30min bars, 1,472 EUR/USD 1h and 1,473 BTC 1h.
2. **Replay equivalence.** Replaying those bars through the production
   `IncrementalEngine` from bar 0 reproduces the persisted engine trade lists
   **exactly**: 100/100, 75/75 and 32/32 trades, with identical entry, exit and net R.
3. **Pre-bar state.** For each touch bar K the audit reads the engine's state *after
   bar K−1*: everything an intrabar fill inside K could know. It then asks whether the
   candidate was valid, unsuppressed, carrying its FVG, a new touch, first in line, and
   (BTC) volatility-eligible. The engine's own state after K is compared to find any
   check that only passed because of bar K.
4. **Geometry.** Production `ipoGeometry()` on the IPO candle from the engine's bars.
5. **Intrabar ordering.** On the TwelveData 1m tape (the runner's own source), in time
   order: first zone touch → entry-level touch (the fill) → target touch → S2 close.
   - S2 is the first strategy bar at or after the fill whose close is beyond the IPO
     extreme, taken at the close instant. A wick never counts.
   - A target is accepted only if its minute ends before that instant. If it falls in
     the fill minute itself, it counts only when the minute opened at or through the
     entry (fill at the open precedes every later print).
   - Otherwise the trade is AMBIGUOUS. There is no tick feed:
     `TICK_RESOLVED` is declared in `ipoCausalOrdering.ts` but unreachable.

## 3. Per-trade audit

Fill = the first 1m bar inside the strategy bar that reached the 50% entry. Valid from
= the close of the bar that validated the IPO.

| # | Pair | TF | Dir | IPO time | Valid from | Fill (1m) | Entry | Target | S2 | Recorded | Causal (1m tape) | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | USD/JPY | 30min | long | 09-24 16:00 | 09-24 17:00 | 09-24 18:32 | 158.81097 | 159.15309 | 158.63991 | S2 -1.223R | S2 close 09-25 02:00 (-1.223R) | VALID |
| 2 | USD/JPY | 30min | long | 09-24 07:30 | 09-24 08:30 | 09-25 05:11 | 158.230745 | 158.534235 | 158.079 | S2 -1.745R | S2 close 09-25 07:00 (-1.745R) | VALID |
| 3 | EUR/USD | 1h | short | 09-24 16:00 | 09-24 18:00 | 09-25 07:00 | 1.1380750000000002 | 1.135525 | 1.13935 | S2 -1.463R | S2 close 09-25 11:00 (-1.463R) | VALID |
| 4 | USD/JPY | 30min | long | 09-23 10:00 | 09-23 11:00 | 09-25 10:17 | 157.820175 | 157.898745 | 157.78089 | TARGET +1.593R | TARGET 09-25 10:21 (+1.593R) | VALID |
| 5 | USD/JPY | 30min | long | 09-23 04:00 | 09-23 05:00 | 09-25 11:10 | 157.61124999999998 | 157.74547 | 157.54414 | TARGET +1.762R | TARGET 09-25 12:36 (+1.762R) | VALID |
| 6 | BTC/USD | 1h | long | 09-24 14:00 | 09-25 11:00 | 09-25 20:00 | 84165.66500000001 | 85719.235 | 83388.88 | S2 -1.397R | S2 close 09-28 04:00 (-1.397R) | VALID |
| 7 | USD/JPY | 30min | long | 09-22 08:30 | 09-22 16:30 | 09-25 20:30 | 157.32720999999998 | 158.19641 | 156.89261 | S2 -1.395R | S2 close 09-28 08:30 (-1.395R) | VALID |
| 8 | EUR/USD | 1h | short | 09-25 11:00 | 09-25 13:00 | 09-27 13:00 | 1.140345 | 1.139095 | 1.14097 | TARGET +1.744R | TARGET 09-27 13:17 (+1.744R) | VALID |
| 9 | EUR/USD | 1h | short | 09-25 11:00 | 09-25 13:00 | 09-27 15:02 | 1.140345 | 1.139095 | 1.14097 | TARGET +1.744R | TARGET 09-27 17:01 (+1.744R) | VALID |
| 10 | EUR/USD | 1h | short | 09-28 02:00 | 09-28 06:00 | 09-28 08:03 | 1.138905 | 1.138555 | 1.13908 | TARGET +1.086R | TARGET 09-28 08:04 (+1.086R) | VALID |
| 11 | USD/JPY | 30min | long | 09-18 06:30 | 09-18 07:30 | 09-28 09:00 | 156.9596 | 157.696 | 156.5914 | TARGET +1.956R | TARGET 09-29 09:59 (+1.956R) | VALID |
| 12 | EUR/USD | 1h | short | 09-27 21:00 | 09-27 23:00 | 09-28 16:28 | 1.1386150000000002 | 1.136905 | 1.13947 | TARGET +1.813R | TARGET 09-28 17:11 (+1.813R) | VALID |
| 13 | USD/JPY | 30min | long | 09-18 06:30 | 09-18 07:30 | 09-30 01:19 | 156.9596 | 157.696 | 156.5914 | S2 -1.478R | S2 close 09-30 02:30 (-1.478R) | VALID |
| 14 | EUR/USD | 1h | short | 09-29 21:00 | 09-29 23:00 | 09-30 05:58 | 1.13425 | 1.13353 | 1.13461 | S2 -3.556R | S2 close 09-30 07:00 (-3.556R) | VALID |
| 15 | EUR/USD | 1h | short | 09-29 06:00 | 09-29 08:00 | 09-30 10:02 | 1.136125 | 1.135115 | 1.13663 | TARGET +1.683R | TARGET 09-30 11:57 (+1.683R) | VALID |
| 16 | USD/JPY | 30min | long | 09-30 16:30 | 09-30 17:30 | 09-30 18:31 | 157.316885 | 157.389195 | 157.28073 | TARGET +1.558R | TARGET 09-30 19:42 (+1.558R) | VALID |
| 17 | USD/JPY | 30min | short | 09-29 16:30 | 09-30 01:00 | 09-30 20:30 | 157.45586500000002 | 157.329995 | 157.5188 | S2 -1.983R | S2 close 10-01 00:00 (-1.983R) | VALID |
| 18 | USD/JPY | 30min | short | 09-25 05:30 | 09-25 06:30 | 10-01 01:54 | 158.20495499999998 | 158.060545 | 158.27716 | S2 -1.482R | S2 close 10-01 04:30 (-1.482R) | VALID |
| 19 | EUR/USD | 1h | short | 10-01 03:00 | 10-01 05:00 | 10-01 06:03 | 1.13253 | 1.13177 | 1.13291 | TARGET +1.579R | TARGET 10-01 06:40 (+1.579R) | VALID |
| 20 | USD/JPY | 30min | long | 10-01 03:30 | 10-01 04:30 | 10-01 06:45 | 158.140665 | 158.233755 | 158.09412 | TARGET +1.656R | TARGET 10-01 07:04 (+1.656R) | VALID |
| 21 | USD/JPY | 30min | long | 10-01 03:30 | 10-01 04:30 | 10-01 10:51 | 158.140665 | 158.233755 | 158.09412 | TARGET +1.656R | TARGET 10-01 11:21 (+1.656R) | VALID |
| 22 | USD/JPY | 30min | long | 10-01 23:30 | 10-02 00:30 | 10-02 05:30 | 157.895325 | 158.054155 | 157.81591 | S2 -3.428R | S2 close 10-02 06:30 (-3.428R) | VALID |
| 23 | USD/JPY | 30min | long | 10-01 16:00 | 10-01 17:00 | 10-02 07:56 | 157.628485 | 157.829295 | 157.52808 | TARGET +1.841R | TARGET 10-02 12:30 (+1.841R) | VALID |
| 24 | EUR/USD | 1h | short | 10-02 07:00 | 10-02 12:00 | 10-02 12:56 | 1.126 | 1.12476 | 1.12662 | TARGET +1.742R | TARGET 10-02 13:15 (+1.742R) | VALID |

**Extra columns, every trade** (full detail in the CSV):

| Column | Value |
|---|---|
| same_strategy_bar_entry_and_invalidation | false ×24 |
| same_1m_entry_and_target | false ×24 |
| same_1m_entry_and_adverse_extreme (fill minute wicks to S2) | false ×24 |
| tick_resolution_used | false ×24 |
| corrected_exit_if_needed / corrected_R_if_needed | none |

**Pre-bar checks.** On the K−1 state, every trade was:
- validated at least one bar before its touch bar;
- unsuppressed and not invalidated;
- carrying its FVG;
- a new touch under the production rule;
- the first eligible candidate;
- for BTC #6, already HIGH_VOL.

The engine's post-bar state agrees in every case.

**Agreement with the runner.**
- All 18 recorded fill minutes and all 7 recorded target minutes match the tape exactly.
- Trades #5, #23 and #24, flagged `same_bar_ambiguous` by the runner, have exit bars that both touched the target and closed beyond S2. The tape puts the target first in each: 12:36 vs a 13:00 close, 12:30 vs 13:00, and 13:15 vs 14:00.

**Data notes (no result changes).**
- **#11 exit time:** the tape reaches the target at 09-29 09:59 (the 09:30 bar). The runner booked it on the 10:00 bar, whose high it used. The provider's 30min high and its 1m highs differ slightly. R is unchanged.
- **Bar ranges:** six touch bars show small high/low differences between the strategy bar and the 1m aggregate (e.g. #14: 1.13436 vs 1.13457). None moves a fill, target or S2 decision.
- **Weekends:** the provider's tape runs through weekends (e.g. #8 filled on Sunday 09-27). The engine traded on those bars, so the audit uses them as-is.

## 4. Summary

| | |
|---|---|
| Total trades | **24** |
| VALID | **24** |
| VALID_OUTCOME_CORRECTION | 0 |
| AMBIGUOUS | 0 |
| INVALID_LOOKAHEAD_AFFECTED | 0 |
| INVALID_OTHER | 0 |
| Recorded wins / losses | 14 / 10 (58.3%) |
| Corrected wins / losses (resolvable) | 14 / 10 |
| Recorded net R | **+4.263R** (avg win +1.672R, avg loss −1.915R) |
| Corrected net R | **+4.263R** |
| Trades whose P/L changes | 0 |
| Affected by same-bar lifecycle ordering | 0 |
| Affected by same-minute ambiguity | 0 |

**One immaterial cost-basis note.** BTC #6's cost is proportional to price, and the
engine prices it off the touch bar's *close* (`costPerSide(bar.close)`), not the fill.
At the entry price the cost is 0.32505R instead of 0.32394R, a difference of 0.0011R.
FX costs are fixed, so the other 23 trades are unaffected.

These figures describe these 24 trades only and are not extrapolated to the historical
baseline.

## 5. Look-ahead specific check

**"Did any of these 24 trades benefit from the known touch-bar look-ahead?" No.**
- None of the 24 touch bars closed beyond S2. Each entry would exist whatever its bar's close.
- None depended on the four other places the engine reads the touch bar's completed OHLC:
  - validation by the touch bar's own close;
  - an FVG revealed only by the touch bar;
  - a contraction context changed by the touch bar;
  - BTC volatility ranked with the touch bar's ATR.

**"Would any additional trades have existed in this period but were suppressed?" Yes, two.**

### SUPPRESSED_TRADE_CHECK

**Walk.** The period from the 2026-09-24 18:00 bar to the 2026-10-02 13:00 bar was
re-walked bar by bar. All three instruments were flat at the start; the first
1m-ordering-v1 event was at 19:00:05. An entry exists when:
- on the K−1 state, the first valid, unsuppressed, FVG-carrying candidate is touched by bar K;
- price reaches its 50% level intrabar;
- the slot is free under the frozen `touchIndex > previousExitIndex` rule;
- for BTC, the volatility bucket known before the bar is HIGH_VOL.

The bar's later close is ignored.

**Calibration.** The walk produces 27 entries.
- **25 match recorded entries:** all 24 audited trades plus the open ambiguous position.
- **0 recorded trades are missed by the walk.**
- **2 are new:**

| Pair | Bar | IPO | Dir | Entry / Target / S2 | Fill (1m) | Why it was suppressed | Causal outcome |
|---|---|---|---|---|---|---|---|
| USD/JPY 30min | 09-30 20:00 | 09-29 23:30 | short | 157.407185 / 157.298055 / 157.46175 | 09-30 20:00 | touch bar **closed beyond S2** → lifecycle invalidated the zone before recording the touch | S2 close 20:30, **−1.403R** |
| USD/JPY 30min | 10-01 11:30 | 10-01 03:30 | long | 158.140665 / 158.233755 / 158.09412 | 10-01 11:35 | touch bar **closed beyond S2** (same zone as #20 and #21, its third visit) | S2 close 12:00, **−6.004R** |

**Total of the suppressed entries: −7.407R across 2 losers.** Neither costR exceeds 2,
so neither would have been execution-blocked. Both exit at the close of their own
touch bar, so neither would have blocked a later recorded trade.

For context only (not an audit total): adding these two to the 24 would move the
period from +4.263R to −3.144R.

## 6. Other findings

### 6.1 Where the deployed engine reads a bar it has not seen close

At the touch bar K, `IncrementalEngine.feed` evaluates candidates using bar K's
completed OHLC. All of the following were checked per trade, and none affected the 24:

| Location | What reads bar K's close or full range | Effect here |
|---|---|---|
| `step()`: invalidation checked before touch | a touch bar closing beyond S2 is never a touch | **2 suppressed entries** (§5) |
| `step()`: `validAt = j` then touch on the same `j` | a zone validated by bar K's close could be entered on K | none |
| `computeFvg` over bars ≤ K | the touch bar could supply the FVG | none |
| `refreshEpisodes` with bar K | suppression / prior contraction could change on K | none |
| `LiveVolatility.push(bar K)` → ATR over `slice(0, K+1)` / `close[K]` | BTC eligibility ranks the touch bar itself | none (#6 HIGH_VOL either way) |
| `costPerSide(bar.close)` | BTC cost priced at the close | 0.0011R on #6 |

### 6.2 Production defect: an ORDERING_AMBIGUOUS position is never reloaded

`ipo-paper-runner/index.ts` loads the open position with

```ts
.in("status", ["open", "data_gap_suspended"])
```

so a position in `ordering_ambiguous` is invisible to every later run. Consequences:
- Its open branch is never managed.
- The instrument is treated as flat, contradicting the runner's own rule ("the position slot stays HELD — one branch still has this trade running").

**Live instance.** The USD/JPY position filled 10-01 15:38 (`int_a4beaecd…`).
- Entry and target fell in the same minute.
- Its row has not been touched since 10-01 16:00 (`last_managed_bar_time` = 15:30), and it still shows as open.
- USD/JPY trades #22 and #23 were then opened while it was nominally held.

**Effect in this instance: none on the 24.** On the tape, the open branch reaches its
target at 15:41, before any S2 close (the first is 10-02 12:30). So both branches end
as a target by the 15:30 bar, and #22 and #23 exist under either branch. The position
itself is resolvable (TARGET in both branches), but the ledger will show it open
indefinitely. The same defect could remove a held slot in future. Not fixed, as this
is an audit.

## 7. Final verdict

**A. ALL 24 TRADES CAUSALLY VALID.**

The 24 trades **can be trusted as currently recorded**: entries, exits, wins/losses and
the +4.263R net are all supported by correct intrabar ordering.

**The paper record for this period is not complete, though.** The touch-bar look-ahead
suppressed two losing entries (−7.407R), and the ambiguous USD/JPY position is stuck
open by a production defect. The 24 are valid; the period is not fully represented by
them.
