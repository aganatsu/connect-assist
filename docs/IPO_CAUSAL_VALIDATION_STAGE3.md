# IPO causal validation — stage 3

**Research only. No strategy logic changed. No baseline replaced. No deployment.
No database mutation. No SMC change.** Continues stage 2 (`d3b728c2`). Dated
2026-09-23.

---

## 0. Outcome of this stage, up front

**Stage 3's headline deliverable — remeasuring the locked 1,039-trade corpus —
is BLOCKED, and no metrics are published against a substitute population.**

The locked baseline says it came from *"replaying all 15 untouched validation
windows"*. **No file in the repository enumerates those 15 windows.** The
research freeze records several different window sets for different
validations, none labelled as the baseline's. The population therefore has to be
reconstructed and proven, and Part A requires exactly that proof before any
correction may be published.

The leading hypothesis was tested and **refuted** (§3). Rather than substitute a
different population — which Part A explicitly prohibits — this stage stops at
the blocker and reports it.

What stage 3 *did* complete:

- **Part 0**, the stage 2 accounting discrepancy: reconciled, documented, and
  now enforced by tests (§2).
- **Part R**, accounting invariants: implemented and passing (§2).
- **Part A**, population reconstruction: attempted with evidence, refuted, and
  the exact blocker identified (§3).
- **Part O**, API limits: measured, and materially worse than stage 2 suggested
  (§4).

Everything downstream of population identification — Parts B–K — is not
attempted, because every one of them would produce a number attached to the
wrong set of trades.

---

## 1. Locked baseline confirmation

Unchanged and not edited by this stage:

| instrument | n | expectancy |
|---|---|---|
| EUR/USD | 341 | +0.758R |
| USD/JPY | 558 | +0.550R |
| BTC/USD HIGH_VOL | 140 | +0.301R |
| **PORTFOLIO** | **1039** | **+0.585R**, win 72.6%, PF 2.02, maxDD 18.4R |

---

## 2. Stage 2 accounting reconciliation (Part 0)

Stage 2 reported `STILL_OPEN_AT_BAR_END = 26` and then, under a heading about
those trades, `29 eventual targets / 29 eventual S2 closes`. Those cannot both
describe 26 trades.

**The numbers were right; the label was wrong.** The 29/29 are totals across all
**58 resolved** trades, combining those resolved inside the entry bar with those
carried forward:

| | TARGET | S2_CLOSE | total |
|---|---|---|---|
| resolved INSIDE the entry bar | 18 | 14 | 32 |
| carried FORWARD from entry bar | 11 | 15 | **26** |
| **total resolved** | **29** | **29** | **58** |

### The carry-forward 26, partitioned exactly

| outcome | n |
|---|---|
| eventual `TARGET` | 11 |
| eventual `S2_CLOSE` | 15 |
| still open | 0 |
| later-bar ambiguous | 0 |
| missing data | 0 |
| **sum** | **26** |

No overlap. The stage 2 document has been corrected in place, with the
correction dated and the original wording quoted so the change is auditable.

### Invariants now enforced

`supabase/tests/_shared/ipoResearchInvariants.test.ts` adds `assertPartition`,
which fails when buckets do not sum to the population, when any bucket is
negative, or when any bucket exceeds the population. It pins the stage 2 figures
(87 same-bar, 58 resolved, 26 carry-forward, 164 corpus, 3,764 attribution) and
includes negative tests proving double-counting and lost trades are both caught.
The specific stage 2 error — outcome counts exceeding the input count — now
fails the run.

---

## 3. Population reconstruction: attempted, refuted (Part A)

### What is recoverable

The baseline's provenance sentence is the only record: `ipoLiveEngine.ts`
replaying "15 untouched validation windows". The research freeze contains:

| freeze section | windows | date ranges |
|---|---|---|
| §14, untouched A1 validation | 3 | 2023-09-01 → 2023-12-01 (JPY → 11-01) |
| §15, volatility validation | 12 | BTC+EUR 2022-04, 2025-01, 2025-04, 2025-08; JPY 2022-08 + the three 2025 |
| §16, alpha validation | 12 | 2021-09, 2023-02, 2024-11/09, 2026-01 |

### The hypothesis

§14 (3) + §15 (12) = 15 windows, and the locked table reports BTC as HIGH_VOL
only, which is §15's framing. Plausible enough to test; not assumed.

### The test, and its refutation

The candidate windows were fetched from Twelve Data and replayed through the
**unmodified** `ipoLiveEngine`. Seven of fifteen completed before the API
budget was exhausted (§4) — and seven were enough:

| instrument | windows replayed | trades so far | locked | verdict |
|---|---|---|---|---|
| EUR/USD | 3 of 5 | 277 | 341 | under, incomplete |
| USD/JPY | 1 of 5 | 127 | 558 | under, incomplete |
| **BTC/USD** | **3 of 5** | **165** | **140** | **already exceeds** |

**BTC/USD is decisive.** 165 HIGH_VOL trades from three of its five candidate
windows, against a locked total of 140. A superset cannot be the population, and
adding the two missing windows can only make it larger. **The candidate window
set is refuted.**

Per-window detail, for whoever picks this up:

```
EUR/USD 2023-09-01..2023-12-01  [s14]  1558 bars ->  84 trades
BTC/USD 2023-09-01..2023-12-01  [s14]  2185 bars ->  42 trades
USD/JPY 2023-09-01..2023-11-01  [s14]  2064 bars -> 127 trades
BTC/USD 2022-04-01..2022-07-01  [s15]  2184 bars ->  71 trades
EUR/USD 2022-04-01..2022-07-01  [s15]  1569 bars -> 103 trades
BTC/USD 2025-01-01..2025-04-01  [s15]  2161 bars ->  52 trades
EUR/USD 2025-01-01..2025-04-01  [s15]  1511 bars ->  90 trades
```

### One thing that did validate

Bar counts reproduce the freeze document almost exactly: EUR/USD 2023-09→12
returned **1,558 bars against a documented 1,558**, and USD/JPY returned **2,064
against a documented 2,064**. BTC returned 2,185 against a documented 2,180 — a
five-bar difference, worth noting but not material here.

So the *fetch method* faithfully reproduces the original data. What is missing is
only the list of windows. That is an encouraging blocker: it is a lookup, not a
data problem.

### What would unblock it

One of:

1. **The window list**, from wherever the original research runner was executed —
   a script, a notebook, a shell history, or your own record.
2. **The original per-trade output** of the 1,039-trade run, if it was saved
   anywhere. Trade timestamps alone would identify the windows.
3. **A search over candidate window sets** until one reproduces 341/558/140
   exactly. Possible in principle, but it is a fitting exercise, and a set that
   happens to hit three numbers is not thereby the original set. I would not
   trust it and do not recommend it.

Option 1 or 2 makes stage 3 a short task. Option 3 does not really solve it.

---

## 4. API limits, measured (Part O)

Materially tighter than stage 2 implied. Stage 2 used 47 small requests and saw
zero throttling. Stage 3 used `outputsize=5000`, and **Twelve Data bills credits
by response size, not by request**:

```
"You have run out of API credits for the current minute.
 60 API credits were used, with the current limit being ..."
```

Observed on the plan in use: a single 5,000-bar request consumes on the order of
**8 credits**, so the per-minute budget is exhausted after roughly seven large
requests. With 65-second backoff the throughput is about **one window per 85
seconds**, and a 15-window fetch takes roughly 25 minutes of wall clock.

Consequence for the next attempt: budget ~25 minutes for the HTF fetch alone,
and considerably more for 1-minute data, which at one instrument-day per request
would need hundreds of calls for a multi-month corpus. **This is the practical
constraint on stage 3, not the method.**

Secret handling: the key was read from the existing gitignored
`local-runner/.env.local`, never printed, never written to any output, and does
not appear anywhere in the repository — verified against the staged diff.

---

## 5. What is NOT claimed

- No corrected expectancy, win rate, profit factor or drawdown for the 1,039
  corpus. Parts B–K are not attempted.
- No optimistic/pessimistic bounds (Part G), because bounds over an
  unidentified population are meaningless.
- No strategy-survival conclusion (Part K). Stage 2's provisional result over a
  164-trade replay stands as what it was: provisional, and over a different
  population.
- No strategy rule added, removed or tuned (Part L). Break/retest remains
  deferred (Part M).

---

## 6. Quality gates

```
deno supabase/tests      1341 passed   0 failed
deno supabase/functions  1569 passed   0 failed
deno check               clean
vitest                    262 passed
tsc --noEmit             clean
npm run build            clean
```

Confirmed: no schema change, no cron change, no deployment config, no SMC
change, no broker change, no live-runner change, no paper-behaviour change, no
production import of any research module, no API secret committed.

---

## 7. Statement

No IPO detection, lifecycle, contraction, FVG, direction, E2 entry, S2
invalidation, 2R target, re-entry, sequencing, volatility or cost rule was
changed. S2 remains close-confirmed. Nothing was deployed and no production
database row was written or altered.

**The locked 1,039-trade baseline is preserved exactly as written** — EUR/USD 341
@ +0.758R, USD/JPY 558 @ +0.550R, BTC/USD HIGH_VOL 140 @ +0.301R, portfolio 1,039
@ +0.585R, win 72.6%, PF 2.02, maxDD 18.4R — and nothing in this stage replaces,
edits or supersedes it.
