# Phase 3 replay report — spec v2.0.2 (sha256 7d64282d…)
Labels: PHASE3_FINAL_PROVIDER_BARS, NEWS_GATE_NOT_REPLAYED. Dataset sha256 2cc0c4b3c5badf60b909759c083c40384cdef53b1d93bbd90c6a974ef679559f. Measured start M = 2026-09-27T21:00:00.000Z.

## Fidelity
Engine vs independent checker: 1314 events, 0 disagreements (100%). Owner review of the sample below pending.

## Frequency gate (§12.1c)
Complete eligible days: 10. Resolved window trades: 0. Projected trades/week = 0 / 10 × 5 = 0.00 → LOW_FREQUENCY_FAIL.
Open at the cutoff (excluded, reported only): 0.

## Window activity (descriptive)
Setup terminal events: {"ARMED":2,"INVALIDATED":1,"CONFIRMED":1,"STOP_TOO_WIDE":1}
POI terminal events: {"SPENT_SAME_BAR":16,"SPENT_OUTSIDE_WINDOW":18,"SPENT_DIRECTION":25,"LOOKBACK_EXPIRED":24,"ARMED":2}
POIs spent during warm-up (SPENT_WARMUP): 57

## Resolved trades

## Open at cutoff
none

## Owner review sample (mulberry32 seed 20261010, without replacement, 0 of 0)

## Funnel (diagnostic, window only)
| pair | 1H swings | 1H break events | legs | qualifying | POIs | direction LONG / SHORT / vetoed (share of in-window decision times) |
|---|---|---|---|---|---|---|
| EUR/USD | 63 | 46 | 24 | 10 | 14 | 24% / 38% / 39% |
| GBP/USD | 70 | 63 | 28 | 17 | 21 | 22% / 31% / 48% |
| USD/JPY | 69 | 58 | 25 | 15 | 16 | 37% / 21% / 42% |
| CHF/JPY | 69 | 58 | 29 | 10 | 5 | 19% / 33% / 49% |
| NZD/CAD | 75 | 62 | 27 | 12 | 5 | 27% / 36% / 37% |
| NZD/CHF | 70 | 59 | 25 | 12 | 13 | 29% / 29% / 42% |
74 POIs qualified in the window → 25 SPENT_DIRECTION, 18 SPENT_OUTSIDE_WINDOW, 16 SPENT_SAME_BAR, 24 LOOKBACK_EXPIRED untouched, 2 ARMED
(1 INVALIDATED, 1 CONFIRMED → STOP_TOO_WIDE). Spot checks: SPENT_DIRECTION cases trace to a 1H bias against the POI or a genuine 15m
opposite close-through within the last 10 15m bars.
Data: 0 MISSING intervals in all 18 series; TwelveData also returned bars for every closed-market hour (dropped by §1.2).
