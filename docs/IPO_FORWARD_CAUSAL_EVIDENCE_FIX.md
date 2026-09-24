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
     entry and target in the SAME minute  -> UNRESOLVED  ORDERING_UNRESOLVED
     no minute reaches E2 (feeds disagree)-> UNRESOLVED  ORDERING_UNRESOLVED
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

## 5. Unresolved behaviour

When nothing can order the events the observation is **voided, never fabricated**:

```
exit_reason         ORDERING_UNRESOLVED
exit_price          NULL
realized_r          NULL
realized_pnl_usd    NULL
excluded_from_stats TRUE
exclusion_reason    the resolver's own explanation
```

This mirrors the existing `DATA_GAP_ABORTED` treatment, and the schema's
coherence constraint now enforces it: a row with either void reason **must**
carry no R, must be excluded, and must say why.

The position closes rather than lingering. One branch of the ambiguity means the
trade is already over, so carrying it forward would invent a different fiction
from the one being removed — and it keeps the position slot in step with the
frozen engine.

A plan that still needs a tape is **provisional** and is never written. The
worker either supplies the tape and re-plans, or declares the tape final so the
affected bar becomes `ORDERING_UNRESOLVED`. There is no path that falls back to
the whole-bar reading.

---

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

**Not yet set — the fix is committed and not deployed.** See §12.

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

New file `supabase/tests/_shared/ipoCausalOrdering.test.ts`, 20 tests, built from
the real incident. All ten required cases are covered:

| # | case | test |
|---|---|---|
| 1 | target high before E2 entry → must not book target | `1`, `1a` (the verbatim incident bar), `1b` |
| 2 | entry first, target later in the same bar → valid | `2` |
| 3 | wick through S2 then recovery → no invalidation | `3` |
| 4 | target after entry, HTF later closes beyond S2 → target wins | `4` |
| 5 | HTF closes beyond S2 before any target → S2 close | `5` |
| 6 | entry and target in one minute → `ORDERING_UNRESOLVED` | `6`, `6b` |
| 7 | position survives the entry bar → later bars manage it | `7` |
| 8 | re-entry on the same zone preserved | `8` |
| 9 | one open position per instrument | `9` |
| 10 | no SMC behaviour, no level/target/stop computed | `10`, `10b`, `10c` |

Plus: the forward-evidence stamp defaults to legacy; `minutesInBar` windows
correctly; a `NEED_MINUTES` result can never be applied as an outcome.

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
| `ipoPaperRunner` — central equivalence | was "reproduces the engine exactly". Now: same trades, same entry bars, same exit bars, identical R **wherever the bars could order it**; void where they could not, with an assertion that the resolvable majority remains checkable. |
| `ipoPaperRunner` — multi-window equivalence | same narrowing, same guard that resolved ≥ voided. |
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

**NOT DEPLOYED.** The work is committed and ready; two steps remain and both need
an explicit go-ahead.

The order matters and cannot be inverted: the worker writes the new columns, so
the migration must land **first** or every insert fails.

```
1.  supabase db push                       # applies 20260924120000 only
2.  supabase functions deploy ipo-paper-runner
    supabase functions deploy ipo-paper-state
```

The migration is safe to apply ahead of the deploy: additive nullable columns and
widened CHECKs cannot affect the currently running function.

Nothing else deploys. No SMC function, no broker function, no cron statement.

**What happens on the first corrected run.** Existing open positions read back
with `causal_execution_version` NULL and `engine_exit_overridden` false. They are
managed from then on under the causal rules, and their history rows stay marked
legacy — correct, because their fill bar was resolved under the old model.

---

## 13. Known limitations

1. **No tick feed.** Entry and target inside the same minute is terminal:
   `ORDERING_UNRESOLVED`, excluded. How often that happens on forward data is not
   yet known; the historical corpus ran about 6% (63 of 1,021).
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
   window.
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
| `deno test supabase/tests` | **1321 passed, 0 failed** (1301 before; +20 new) |
| `deno test supabase/functions` | **1569 passed, 0 failed** |
| `deno check` on all changed modules | clean |
| `vitest run` | **262 passed** |
| `tsc --noEmit` | clean |
| `npm run build` | clean |
| targeted IPO paper regression | `ipoCausalOrdering` 20/20, `ipoPaperRunner` 23/23, `ipoPaperContract`, `ipoPaperFunctions`, `ipoPaperLifecycle`, `ipoIntrabarOrdering` all green |
