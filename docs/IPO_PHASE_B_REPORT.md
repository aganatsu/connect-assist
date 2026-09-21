# Phase B Report — Incremental Engine

**2026-09-21. Engine only.** No schema change, no migration applied, no
deployment, no cron, no frontend, no broker path, no SMC change. `ipoLiveEngine`
is unchanged and remains the reference oracle.

Deliverables: `supabase/functions/_shared/ipoIncrementalEngine.ts`,
`supabase/tests/_shared/ipoIncrementalEngine.test.ts` (12 tests), and one line
in the shadow-isolation guard (now 30 modules).

---

## 1. Equivalence — EXACT

| | |
|---|---|
| validation windows | **15 / 15** |
| oracle trades | **1,039** |
| oracle-only trades | **0** |
| incremental-only trades | **0** |
| field mismatches | **0** |
| realized R tolerance | **1e-9** |

Every field the strategy decides is compared, not only realized R: `entry`,
`stop`, `target`, `risk`, `direction`, `entryIndex`, `exitIndex`, `exitPrice`,
volatility bucket, `costR`, `mae`, `mfe`, and `netR` to 1e-9. A matching R with
a different exit bar would be two bugs cancelling, which is precisely what an
equivalence harness exists to refuse.

| window | bars | oracle | incremental | matched | mismatches |
|---|---|---|---|---|---|
| EUR w1–w5 | 1,024–1,464 | 69 / 44 / 44 / 91 / 93 | identical | all | 0 |
| JPY w1–w5 | 2,031–2,927 | 107 / 92 / 114 / 119 / 126 | identical | all | 0 |
| BTC w1–w5 | 1,400–1,465 | 41 / 40 / 17 / 27 / 15 | identical | all | 0 |

Covers the candidate set, entry times and prices, exit times and reasons,
realized R, sequential blocking, FVG eligibility, volatility eligibility and
first-touch sequencing.

## 2. Runtime

| measure | min | median | max |
|---|---|---|---|
| bootstrap (full window) | 17.1 s | 33.6 s | 184.0 s |
| per-new-bar | 21 ms | 66 ms | 191 ms |
| speedup vs oracle | 2.7× | ~5× | 7.7× |

**At the specified 1,200-bar size the requirement is met with wide margin.**
Nearest measured points: 1,464-bar windows bootstrap in **29.5 s, 35.0 s and
35.3 s**, with per-new-bar cost of 51–61 ms.

### Caveat — the 2,927-bar window

The largest window tested, USD/JPY w5 at 2,927 bars, bootstraps in **184 s,
which EXCEEDS the 150 s Edge budget** (oracle: 893 s). It is still exact.

This matters only if `HISTORY_BARS` is raised above 1,200. At the spec'd 1,200 it
is not a constraint. If a longer history is ever wanted, bootstrap must move out
of the request path — the per-new-bar cost (191 ms even there) is never the
problem.

## 3. Three bugs found and fixed — all in the new code

Each was found by the oracle disagreeing. **The oracle was never modified to
force agreement**, and a test asserts it does not depend on the engine meant to
check it.

**1 — suppression is not monotone.** A contraction detected later retroactively
suppresses an earlier candidate. Measured directly: candidate 109 was VALID at
prefix 110 and SUPPRESSED at prefix 115 once episode [107-115] appeared. The
first implementation fixed the episode context at candidate formation and so
took a trade the oracle refuses. Episode context is now compared every bar and
any change forces a full re-derivation of that candidate.

**2 — the touch window compares against the last RECORDED touch**, not the last
overlapping bar. The frozen rule reads `last = touches[touches.length-1]`. The
first implementation advanced its marker on every overlapping bar, which shifted
the window forward and swallowed genuine later visits: bar 147 overlapping hid
the real touch at 148.

**3 — `hasFvg` does not settle at k+10.** `fvgsNear(s, i)` slices `[i-5, i+21)`,
so scanning to `k+10` reads bars as far as `k+30`. An FVG *inside* the window is
therefore not *detectable* until those later bars exist — candidate 764 read
false at k+10 and true at k+17. Settling early silently dropped real setups. The
flag now settles at `k + 31`, or as soon as it reads true, since the scan is an
OR over a fixed window and can only gain detections.

## 4. Two exact optimisations, both measured before being built

**Episodes.** `segmentEpisodes` maps each episode independently through
`applyStateExit`, and `applyStateExit` recomputes `confirmedSwings`,
`directionalEvents` and `structureStalls` over the whole series on every call —
so a 20-episode list does that work 20 times. Measured separately over 640
prefixes: **0 episodes ever vanished, and every mutation had a lag of exactly 1
bar**, so an episode ending before `K-1` is frozen forever. Frozen episodes are
cached and only the tail is recomputed. Passing a subset is exact precisely
because the mapping is per-episode. A test asserts the cached list equals
`episodesFor` at **every** prefix, so if that stability property ever breaks it
fails before any trade does.

**Lifecycle.** `runLifecycle` rescans every candidate's forward history on every
bar; tracked candidates now advance one bar at a time.

`twoStageContractions` is deliberately **not** optimised — it is the cheaper half
and splitting it would mean reimplementing seed detection, which is the drift
this design exists to avoid.

## 5. Scope confirmation

- `ipoLiveEngine.ts` — **unchanged**
- no migration applied · no schema change · nothing deployed · no cron
- no frontend · no broker execution · no SMC file touched
- a test asserts the engine module references none of `paper_positions`,
  `pending_orders`, `paper_trade_history`, `paper_accounts`, `broker-execute`,
  `supabase` or `createClient`

Suite: **1,061 passed, 0 failed.**

---

**Phase B complete. Stop before Phase C.**
