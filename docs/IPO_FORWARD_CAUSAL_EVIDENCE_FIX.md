# IPO forward-evidence containment — causal event ordering

**Measurement hygiene only. No strategy rule changed: IPO detection, lifecycle,
contraction, FVG, E2 entry, S2 price, HTF close-confirmed invalidation, the 2R
target, re-entry, one-position-per-instrument, volatility and costs are all
untouched. No SMC change, no broker change, no live execution, no cron change.**
Branch `fix/ipo-forward-causal-ordering`. Dated 2026-09-24.

---

## 1. The bug, exactly

Every IPO execution path derived the entry from one extreme of an HTF bar and
then evaluated the brand-new position against the **whole** of that same bar. An
OHLC bar carries no path ordering, so an extreme that occurred **before** the
entry touch could resolve a position that did not yet exist.

The recorded instance, read back from `ipo_engine_state:ipo_cet:BTC/USD`:

```
BTC/USD 1h   IPO candle 2026-09-21T10:00Z   long
entry 84473.315   S2 84130.21   target 85159.525
entry bar 2026-09-23T14:00Z   O 85792.01  H 85940.32  L 83864.07  C 84530.00
```

The bar **opens at 85792.01 — already above the 85159.525 target**. The target
was satisfied before the bar had traded a single tick of the entry, and the
runner booked `TARGET_2R` at +2R gross. One-minute data for the same hour gives
the real path: entry first touched ~14:13, the post-entry rebound reached only
~84880, and the position was still running when the hour ended.

This is not inter-bar lookahead — the engines are strictly causal across bars. It
is intrabar temporal ambiguity inside one bar, and it made same-bar forward
outcomes untrustworthy.

A second, narrower defect sat next to it: the **blanket stop-first convention**.
When a bar both reached the target and closed beyond S2, the loss was taken by
convention. That convention exists because HTF data cannot order the two events —
but when a minute tape can, guessing is no longer necessary.

---

## 2. Affected code path

| file | what it did |
|---|---|
| `_shared/ipoPaperContract.ts` `stepPosition` | tested `bar.close < s2` then `bar.high >= target` over the whole bar, stop-first |
| `_shared/ipoPaperRunner.ts` | `stepPosition(pos, closedBars[entryIdx], 0)` — the fill bar stepped with its entire OHLC |
| `ipo-paper-runner/index.ts` | wrote whatever that produced |

The frozen research engines (`ipoLiveEngine`, `ipoIncrementalEngine`,
`ipoRawBacktest`) contain the same pattern and are **deliberately left alone** —
changing them would silently move every validated historical figure. A test pins
that they still behave as they always did.

---

## 3. The corrected event-ordering model

One pure module, `_shared/ipoCausalOrdering.ts`, answers one question per HTF
bar: *given the bar, whether it is the fill bar, and whatever lower-timeframe
tape exists, which of target / S2-close / neither actually happened first after
the entry?* It computes no prices, no R and no levels.

**The one ordering rule.** Within a single HTF bar the close is, by definition,
the last event. So a target reached at any post-entry moment inside the bar
happened **before** that bar's close. That is not optimism; it is what "close"
means.

```
bars AFTER the fill — the position held the whole bar
  neither event            -> HOLD       HTF_UNAMBIGUOUS
  target only              -> TARGET     HTF_UNAMBIGUOUS
  S2 close only            -> S2_CLOSE   HTF_UNAMBIGUOUS
  both                     -> walk the minutes; first minute reaching target wins
                              -> TARGET / S2_CLOSE   ONE_MINUTE_RESOLVED

the FILL bar — nothing before the entry instant may resolve it
  neither event            -> HOLD       HTF_UNAMBIGUOUS   (no tape needed)
  S2 close, no target      -> S2_CLOSE   HTF_UNAMBIGUOUS   (a close post-dates any
                                          intrabar entry, so ordering is free)
  target side touched      -> requires the tape
     entry minute found, target later     -> TARGET      ONE_MINUTE_RESOLVED
     entry minute found, no post-entry target, bar closes beyond S2
                                          -> S2_CLOSE    ONE_MINUTE_RESOLVED
     entry minute found, nothing after it -> HOLD        ONE_MINUTE_RESOLVED
     entry and target in the SAME minute  -> AMBIGUOUS_OPEN_OR_CLOSED   (slot HELD, §5)
     no minute reaches E2 (feeds disagree)-> AMBIGUOUS_OPEN_OR_CLOSED   (slot HELD, §5)
```

Excursions follow the same rule: on a tape-resolved fill bar, MAE and MFE are
computed from the entry minute onward, so a pre-entry extreme can no longer leak
into a position's recorded excursion.

Most runs never need a tape. A bar that resolves nothing, or resolves exactly
one thing after the fill, is unambiguous and costs no extra fetch.

---

## 4. Lower-timeframe data source

**1-minute bars, from the existing `fetchCandlesWithFallback` layer** — the same
MetaAPI → Twelve Data → Polygon ladder everything else uses. No new provider, no
new client.

Fetched **only on demand**: the runner plans once with no tape, and the plan
comes back listing exactly the bar spans it could not settle. A single page is
then requested, covering from the earliest unsettled bar to now, capped at
`MINUTE_PAGE_LIMIT = 1500` minutes. On a fifteen-minute cadence over 1h and 30min
instruments that is at most a couple of hours.

**Tick data: none exists.** `TICK_RESOLVED` is declared in the type and is
currently unreachable. It is written down rather than pretended away, so the gap
is visible in the enum instead of buried in a comment. Until a tick feed exists,
same-minute ordering is terminal.

---

## 5. Unresolved behaviour — and why it must not close the position

### The mistake an earlier draft made

The first version of this fix closed the position on every unresolvable
ordering: `ORDERING_UNRESOLVED`, no R, excluded from statistics. That is wrong,
and wrong in a way that spreads.

When entry and target fall inside one minute there are **two viable paths**:

```
entry then target  ->  the trade closed at +2R gross on its fill bar
target then entry  ->  the target was PRE-ENTRY and the trade is STILL OPEN
```

OHLC cannot separate them. Closing picks the first branch, frees the
one-position-per-instrument slot, and admits later IPOs that exist **only in
that branch**. The unresolved trade would have been excluded from statistics
while silently contaminating every trade after it — the same class of error the
whole fix exists to remove, moved one step downstream.

### The state model

Two distinct verdicts, because two genuinely different situations were being
collapsed into one:

| resolver kind | meaning | slot |
|---|---|---|
| `UNRESOLVED_TERMINAL` | order unknown, but **every** branch exits on this bar | **freed** |
| `AMBIGUOUS_OPEN_OR_CLOSED` | order unknown and **a branch leaves it open** | **held** |

`UNRESOLVED_TERMINAL` is the later-bar case — a bar carrying both a target and an
S2 close for a position already running. Whichever came first, the position
exits on that bar, so only the outcome is unknown. It closes with no R.

`AMBIGUOUS_OPEN_OR_CLOSED` becomes a real position in a third status:

```
status      ordering_ambiguous          <- an OCCUPIED slot
ambiguity   { kind, atTime, altBranch, altExitTime, altExitPrice,
              altNetR, altFreedAtBarTime, detail }
```

**The open branch IS the position** — it is managed by later bars under the
ordinary rules, because that branch simply is an open position. The other branch
is frozen beside it. Three kinds reach this state:

| kind | the other branch says |
|---|---|
| `ENTRY_VS_TARGET_SAME_MINUTE` | `CLOSED_AT_TARGET` — entry came first, +2R on the fill bar |
| `ENTRY_BAR_TARGET_TOUCH_NO_TAPE` | `CLOSED_AT_TARGET` — same, with no tape to check |
| `ENTRY_NOT_PROVEN_IN_TAPE` | `NO_POSITION` — the minutes never reach E2, so on that reading the fill never happened |

### How the slot is handled

Held, at three levels, because this is the requirement that was broken:

1. The fill loop breaks on `if (live)` and an ambiguous position **is** `live`.
2. The paper layer now enforces the frozen `touchIndex > previousExitIndex`
   sequencing itself (§5.1) rather than inheriting it from the engine's list.
3. The database partial unique index covers `ordering_ambiguous`, so a second
   row for the instrument is refused by Postgres, not only by code.

### How later bars resolve it

The open branch is managed normally. When it terminates, the branches reconcile:

| open branch ends | other branch | resolution | result |
|---|---|---|---|
| `TARGET` | `CLOSED_AT_TARGET` | `CONVERGED_SAME_OUTCOME` | **a real +2R result, counted** |
| `S2_CLOSE` | `CLOSED_AT_TARGET` | `DIVERGED_TERMINAL` | `ORDERING_UNRESOLVED`, no R, excluded |
| `UNRESOLVED_TERMINAL` | `CLOSED_AT_TARGET` | `DIVERGED_TERMINAL` | no R, excluded |
| anything | `NO_POSITION` | `EXISTENCE_UNPROVEN` | no R, excluded |
| data gap | any | abort | no R, excluded, branches recorded |

The convergence case is real, not a convenience: the target price, entry price,
risk and cost are all fixed at entry, so both branches are `2 − costR` to the
last bit. **The R is provable; only the exit timestamp is not.** The row carries
`exit_time_ambiguous = true` and both candidate times.

### 5.1 The sequence fork, and how far contamination actually reaches

Even a converged *outcome* can leave a forked *future*: the two branches freed
the slot on different bars, so they were free to trade at different times.

```
fork  iff  altFreedAtBarTime != the open branch's exit bar
           AND the other branch took a trade in that gap
```

The second clause is a genuine convergence test, not a hedge. **The frozen
engine's own trajectory IS the alternative branch** — it books the whole-bar
target and frees the slot early — so if it took no trade in the gap, both
branches are flat at the same bar having seen the same bars, and their futures
re-converge. An `AMBIGUITY_RESOLVED` event records that. Only when it did take
one is a `SEQUENCE_FORKED` event emitted.

After a real fork, every later trade on that instrument has its **outcome**
measured but its **existence** conditional. Those rows carry
`sequence_contaminated = true`, are reported under their own heading, and are
kept out of the validated forward population. The flag is persisted in the
runtime state, so it survives across invocations and is not re-derived.

This is bounded, not complete: the unbounded-correct answer is to simulate every
branch, which costs 2^n states. Holding the slot conservatively and labelling the
conditional tail is what is implemented, and §13 says so.

## 6. S2 semantics — preserved exactly

**S2 is still HTF close-confirmed. A wick through S2 is not an exit at any
resolution.** No 1m S2, no 5m S2, no hard 1R stop. Experiment 1 measured what
lower-timeframe S2 confirmation costs (−0.127R per trade at 5m, −0.246R at 1m)
and this change does not go near it.

Two tests pin it:

- `3 — a wick through S2 is not invalidation, with or without a tape` — a bar
  wicking to 83900 against S2 84130.21 and closing back at 84400 holds, whether
  minutes are supplied or not, and on both the fill bar and later bars.
- `10b` greps the ordering module: invalidation is only ever tested as
  `bar.close < s2 : bar.close > s2`, and no minute-level or wick-level S2 test
  exists anywhere in it.

The lower timeframe supplies **order, not levels**.

---

## 7. Provider provenance

`fetchCandlesWithFallback` already returned `source` and it was being discarded.
It is now persisted:

| column | table | meaning |
|---|---|---|
| `htf_source` | positions, history | feed that supplied the setup bars |
| `minute_source` | positions, history | feed that supplied the ordering tape |

Both are also written into the `FILLED` and `CLOSED` event payloads. Previous
research showed venue mismatches change intrabar answers — Stage 1 resolved
Twelve Data HTF bars against Bitstamp minutes and had to label the result
`VENUE_SPECIFIC` rather than proof — so a forward record that cannot say which
feed ordered it is a forward record that cannot be audited later.

The Daily context fetch records its source too, in the run response.

---

## 8. Forward evidence versioning

```
CAUSAL_EXECUTION_VERSION = "1m-ordering-v1"
```

Stamped on every position and every history row the corrected runner creates.

- **NULL = legacy**, pre-fix forward evidence. Nothing is rewritten, nothing is
  deleted, and no backfill default is applied.
- A position that **entered** before the fix keeps `NULL` even if it exits after
  it, because its fill bar was resolved under the old model. That is the honest
  attribution.
- `ipo-paper-state` now returns an `evidence` block splitting the two
  populations, and the UI shows a **MIXED EVIDENCE** banner whenever legacy rows
  are present. The pre-existing `summary` field keeps its old meaning so no
  reader silently changes what it is showing; `evidence.causal` is the population
  any forward performance claim should be made from.

Two indexes support the boundary: one on causally-ordered clean rows, one on
`ORDERING_UNRESOLVED`.

### Where the engine and the paper record now legitimately differ

When the tape refuses an exit whole-bar OHLC would have booked, the paper
position outlives the frozen engine's trade. From then on the engine's slot has
freed early and its sequence diverges. That is the correction working, not drift,
so it is made explicit rather than discovered:

- `engine_exit_overridden` / `engine_exit_bar_time` on the position
- a `CAUSAL_OVERRIDE` audit event at the moment it happens
- `htf_would_have_booked` on the history row where the two answers differ
- the runner's engine/paper agreement check permits **only** this case, **only**
  while the flag is set. Every other disagreement still refuses to write.

---

## 9. FORWARD_CAUSAL_START

```
FORWARD_CAUSAL_START      2026-09-24T17:36:19Z   (UTC, both functions deployed)
deployed commit           a67b5099
causal execution version  1m-ordering-v1
migration version         20260924120000_ipo_causal_execution_ordering
migration applied         2026-09-24T17:30:47Z
first cron run of the
  deployed code           2026-09-24T17:45:00Z   succeeded
```

The boundary is defined by the **column**, not by a clock:

```
forward causal population  =  ipo_paper_trade_history
                              WHERE causal_execution_version = '1m-ordering-v1'
                                AND excluded_from_stats = false
```

A column is used rather than a timestamp because a timestamp cannot express the
one case that matters — a trade that entered before the deploy and exited after
it, which is legacy evidence regardless of when its row was written.

`FORWARD_CAUSAL_START` will be recorded here as the deployment timestamp once the
deploy happens, for narrative reference only.

---

## 10. Tests

New file `supabase/tests/_shared/ipoCausalOrdering.test.ts`, 31 tests, built from
the real incident. All ten required cases are covered:

| # | case | test |
|---|---|---|
| 1 | target high before E2 entry → must not book target | `1`, `1a` (the verbatim incident bar), `1b` |
| 2 | entry first, target later in the same bar → valid | `2` |
| 3 | wick through S2 then recovery → no invalidation | `3` |
| 4 | target after entry, HTF later closes beyond S2 → target wins | `4` |
| 5 | HTF closes beyond S2 before any target → S2 close | `5` |
| 6 | entry and target in one minute → ambiguous, slot HELD | `6`, `6b`, `6c`, `6d` |
| 7 | position survives the entry bar → later bars manage it | `7` |
| 8 | re-entry on the same zone preserved | `8` |
| 9 | one open position per instrument | `9` |
| 10 | no SMC behaviour, no level/target/stop computed | `10`, `10b`, `10c` |

Plus the ambiguous-position model, A–E:

| # | case | test |
|---|---|---|
| A | target extreme first, entry later, no later target → OPEN preserved | `A` |
| B | entry first, target later in the same minute → CLOSED WIN branch kept | `B` |
| C | ambiguity then a later target → branches converge, R provable | `C` |
| D | ambiguity then an S2 close → both terminal, no R claimable | `D`, `D2` |
| E | no later IPO admitted while a branch holds the position | `E`, `E2`, `E3`, `E4` |

A and B are the same fixture asserted from both sides: nothing in the data
distinguishes them, so the runner must produce one identical state for both. `E`
checks the slot at all three levels (fill loop, live assignment, database index);
`E2` drives `runPaper` end to end and asserts no fill ever follows an ambiguity
within a plan; `E3` pins the fork test including its convergence clause; `E4`
asserts contaminated rows stay out of the validated population.

Plus: the forward-evidence stamp defaults to legacy; `minutesInBar` windows
correctly; a `NEED_MINUTES` result can never be applied as an outcome; a later
bar that cannot be ordered IS terminal in every branch (`6c`); a feeds-disagree
fill keeps `NO_POSITION` live (`6d`).

**Oracle equivalence.** `the forward resolver agrees with the research resolver
on the same tape` restates the walk the causal-validation work used — post-entry
minutes, target the moment any minute reaches it, otherwise the HTF close beyond
S2 — and cross-checks it against the production resolver on three bar shapes.
Research and forward must not answer differently for the same candle sequence.

**The frozen engines are pinned unchanged**: they still call
`manageOpen` on the fill bar and still do not import the ordering module.

### Existing tests that changed, and why

| test | change |
|---|---|
| `ipoIntrabarOrdering` E3 | pinned the defect (`stepPosition(pos, closedBars[entryIdx], 0)`). Now pins its absence and that every `stepPosition` call supplies an ordering. |
| `ipoPaperRunner` — central equivalence | was "reproduces the engine exactly". Now: **paper takes a SUBSET of the engine's trades and never invents one**, and on every trade no override or ambiguity touched, exit bar, exit price and R match exactly. Excursions are compared only where the fill bar was not read from the tape, because post-entry MAE/MFE legitimately differ. |
| `ipoPaperRunner` — multi-window, volatility-gated, same-bar, gap, divergence | all narrowed the same way. The fixtures now supply a deterministic 4-point-per-bar minute tape, so they exercise the resolved path; the ambiguity path has its own fixtures. The volatility test additionally asserts the gate itself is unchanged — every paper trade is an engine trade in a HIGH_VOL bucket. |
| `ipoPaperLifecycle` — zone ordinal | the ordinal counts the ENGINE's trades on a zone, which is its stated contract. With paper taking a subset, paper rows can carry ordinals 1 and 3. Now asserted 1-based and strictly increasing rather than densely consecutive. |
| `ipoPaperLifecycle` — no SMC management | `ORDERING_UNRESOLVED` and `CAUSAL_OVERRIDE` added to the allowed vocabulary, with the assertion that a void carries no R. |
| `ipoPaperFunctions` — schema guards | now scan **every** IPO migration, since `supabase db push` applies them all and a later file may widen an earlier CHECK. The exit-reason guard now derives the list from the contract's own union rather than a hardcoded three. |
| `ipoFunctionReachability` | the read path's closure gained `ipoCausalOrdering`; the module is asserted **import-free** so the closure cannot widen further. |

---

## 11. Production isolation

- Writes only `ipo_paper_positions`, `ipo_paper_trade_history`,
  `ipo_execution_events`, `kv_cache` — asserted by an exact-set test.
- No SMC table, no broker path, no live flag, no MetaAPI/OANDA change. The
  structural guards that forbid the runner from even naming `paper_positions`,
  `pending_orders`, `paper_trade_history` or `broker-execute` still pass.
- `ipoCausalOrdering.ts` is import-free and provably pure: no `fetch`, no
  `Deno.env`, no `createClient`, no `.from(`.
- The candle fetches keep `persistSymbolOverrides: false`, so the added 1m and
  daily requests cannot write a symbol mapping into the SMC-owned
  `broker_connections`.
- **Cron unchanged.** The existing fifteen-minute job is sufficient: the extra
  fetches are conditional and rare, and a provisional plan simply does not
  advance the cursor, so the next tick re-plans the same bars.

### The candidate ledger

`INTENT_CREATED` / `REFUSED` / `FILLED` / `CLOSED` already record candidate,
rejection and outcome. Their payloads now also carry the resolution method, the
entry minute, the target minute, both feed sources, and the Daily structure tag.

**The Daily tag is observational and is NOT a gate.** Experiment 3 refuted the
HTF-opposed hypothesis on unseen data, so no context filter is promoted. It is
computed causally — only daily candles fully closed before the entry bar opened,
sliced to the same 300-bar depth bot-scanner uses — fetched only when a fill
occurred, and failure leaves it null without affecting the run. Test `10c`
asserts no decision branches on it.

### Schema

One additive migration, `20260924120000_ipo_causal_execution_ordering.sql`. IPO
tables only. Every new column is nullable with no backfill; two CHECK constraints
are widened (never narrowed); two partial indexes added. No data is rewritten,
moved or deleted, and no SMC table is named.

---

## 12. Deployment status

**DEPLOYED 2026-09-24.** Migration first, then both functions, in that order —
the worker writes the new columns, so the reverse would have failed every insert.

| step | result |
|---|---|
| migration `20260924120000` | applied 17:30:47Z, HTTP 201, recorded in `supabase_migrations.schema_migrations` |
| `ipo-paper-runner` | deployed 17:35Z |
| `ipo-paper-state` | deployed 17:36:19Z |

`supabase db push` could not be used: the CLI has an access token but no cached
database password, so `migration list`/`db push` block on a prompt. The migration
was applied through the Management API instead — the established route for this
project — as a single transaction containing the file verbatim plus the
`schema_migrations` insert, so the CLI's view stays in step. Before applying,
local and remote version lists were compared: **exactly one migration was pending
and it was the intended one**, with no remote-only drift.

### Post-deploy verification, against the live project

| check | result |
|---|---|
| migration recorded | `20260924120000 / ipo_causal_execution_ordering` |
| new columns | 10 on `ipo_paper_positions`, 10 on `ipo_paper_trade_history` |
| status CHECK | `open, data_gap_suspended, ordering_ambiguous` |
| exit-reason CHECK | `TARGET_2R, S2_CLOSE_INVALIDATION, DATA_GAP_ABORTED, ORDERING_UNRESOLVED` |
| event-type CHECK | the nine originals plus `CAUSAL_OVERRIDE, ORDERING_AMBIGUOUS, AMBIGUITY_RESOLVED, SEQUENCE_FORKED` |
| coherence CHECK | widened to cover `ORDERING_UNRESOLVED` alongside `DATA_GAP_ABORTED` |
| **one-open-per-instrument index** | `WHERE status = ANY ('open','data_gap_suspended','ordering_ambiguous')` |
| runner invocation | `ok: true`, 3 instruments warm, 0 errors, 0 divergences, 0 provisional plans |
| read path invocation | `ok: true`, evidence split present |
| cron `ipo-paper-runner-15min` | `*/15`, **active, unchanged**; 17:45Z run succeeded |
| legacy history | fingerprint `cfee7468b611bf68df5bbd66732415dd` **identical before and after** |
| SMC tables | not named anywhere in the applied DDL; only `ipo_*` tables altered |
| broker / live execution | untouched; the function still places no order |

### The first close under the new code

The USD/JPY position open at deploy time exited on the 18:00Z run:

```
entry 17:00Z   exit 17:30Z   TARGET_2R   +1.793R
exit_resolution_method  HTF_UNAMBIGUOUS
orderingDetail          "target reached, bar did not close beyond S2"
causal_execution_version NULL        <- legacy: it ENTERED before the fix
ambiguity_kind NULL   sequence_contaminated false   htf_would_have_booked NULL
```

The resolver ran, found exactly one resolving event on a post-fill bar, needed no
tape, and agreed with the whole-bar reading. The row stays **legacy** because its
fill bar was resolved under the old model — which is the attribution rule this
document specifies, working on its first real case.

## 13. Known limitations

1. **No tick feed.** Entry and target inside the same minute cannot be ordered,
   so the position is carried in `ordering_ambiguous` until a later bar settles
   it. How often that happens on forward data is not yet known; the historical
   corpus ran about 6% (63 of 1,021).
1a. **Branch simulation is bounded, not complete.** The correct-in-full answer is
   to carry every possible state, which costs 2^n with n ambiguities. What is
   implemented holds the slot conservatively, converges the branches where they
   provably agree, and labels the conditional tail. An instrument that forks and
   never re-converges stays labelled from that point on.
2. **Minute reach is one page.** A bar older than `MINUTE_PAGE_LIMIT` minutes
   cannot be ordered and is voided. On the current cadence that should never
   fire; if the runner is down for hours, bars from the outage window may void.
3. **Provider consistency is recorded, not enforced.** If the HTF bars come from
   one feed and the minutes from another, the row says so, but nothing rejects
   the mismatch. Stage 1 showed such a pairing is `VENUE_SPECIFIC` evidence, not
   proof.
4. **Legacy rows stay contaminated.** They are labelled and separated, never
   repaired. Any pooled view of forward performance remains misleading until the
   legacy population is excluded — which is why the UI banner exists.
5. **The engine/paper sequences can diverge after an override**, permanently, for
   that instrument's forward record. The paper sequence is the correct one, but
   it is no longer comparable trade-for-trade with a research replay of the same
   window. The paper layer therefore now enforces the frozen
   `touchIndex > previousExitIndex` rule itself instead of inheriting it from the
   engine's trade list — without that, a multi-bar run could open a candidate
   whose entry bar fell inside a window paper was still holding.
6. **The lifecycle funnel does not count voids.** `closedAtTarget` and
   `closedAtS2` simply omit them; the exit-reason split alongside shows them. A
   dedicated funnel bucket would be clearer.
7. **This cannot recover the contaminated history.** It stops new contamination
   from accruing. The forward evidence collected before the deploy is what it is.

---

## 14. Statement

No IPO detection, geometry, lifecycle, contraction, FVG, direction, E2 entry, S2
price, S2 confirmation timeframe, 2R target, re-entry, sequencing, volatility or
cost rule was changed. No exit rule was added or modified — no break-even, no
trailing, no partial, no hard 1R stop, no lower-timeframe stop. No context gate
of any kind was introduced. No SMC module, table or behaviour was touched. No
broker or live execution path was modified and nothing enables live trading. No
cron statement changed. No existing paper history row was altered, deleted or
relabelled. No credential appears in any file, log or diff.

### Quality gates

| gate | result |
|---|---|
| `deno test supabase/tests` | **1332 passed, 0 failed** (1301 before; +31 new) |
| `deno test supabase/functions` | **1569 passed, 0 failed** |
| `deno check` on all changed modules | clean |
| `vitest run` | **262 passed** |
| `tsc --noEmit` | clean |
| `npm run build` | clean |
| targeted IPO paper regression | `ipoCausalOrdering` 31/31, `ipoPaperRunner` 23/23, `ipoPaperLifecycle` 16/16, `ipoPaperContract`, `ipoPaperFunctions`, `ipoIntrabarOrdering`, `ipoFunctionReachability` all green |
