# Phase D Implementation Report — IPO Paper Trading

Status: **implemented locally, nothing applied and nothing deployed.**
The migration `20260921140000_ipo_paper_state.sql` is written and unapplied. No
edge function is deployed, no cron exists, no broker path is reachable, and the
live SMC bot is untouched.

Branch: `feature/ipo-live-integration`. Production changed: **NO**.

---

## 0. What was built

| Layer | File | Lines | State |
|---|---|---|---|
| Schema | `supabase/migrations/20260921140000_ipo_paper_state.sql` | 219 | written, **UNAPPLIED** |
| Contract (pure) | `supabase/functions/_shared/ipoPaperContract.ts` | 328 | new |
| Runner (pure) | `supabase/functions/_shared/ipoPaperRunner.ts` | 391 | new |
| Worker | `supabase/functions/ipo-paper-runner/index.ts` | 309 | new, **not deployed** |
| Read API | `supabase/functions/ipo-paper-state/index.ts` | 119 | new, **not deployed** |
| Tests | `ipoAdvisorIsolation`, `ipoPaperContract`, `ipoPaperRunner`, `ipoPaperFunctions` | 5 + 18 + 22 + 23 = 68 | all passing |

The design's `ipoTradeIntent` / `ipoPaperExecutor` / `ipoPaperManager` split
landed as two modules rather than three: `ipoPaperContract` holds intent,
sizing, fill and management (all pure, all per-position), and `ipoPaperRunner`
holds the orchestration across bars. The boundary that matters — no SMC
execution helper anywhere, nothing impure below the edge function — is the same.

---

## 1. T11 first, as instructed

`supabase/tests/_shared/ipoAdvisorIsolation.test.ts`, 5 tests, written and run
**before** any Phase D table or code existed.

It pins the measured table sets of the three SMC consumers (the Journal's
`trades` source, `bot-daily-review`, `bot-weekly-advisor`), asserts no IPO
module writes any of them, asserts no view, trigger or foreign key bridges IPO
and SMC history, and pins that `bot-daily-review` still contains
`return botId === "smc"` — the line that would silently attribute an unlabelled
row to SMC. If that attribution is ever removed, the test fails and the
isolation rationale gets re-read rather than quietly expiring.

One correction was needed while writing it: my expected table sets omitted
`bot_recommendations`, `user_settings` and `broker_connections`. The test now
pins the measured sets, not the remembered ones.

---

## 2. The four approved decisions, as implemented

### 2.1 Sizing — R-native, dollars derived

`realizedR` is the strategy result. `realizedPnlUsd` is computed from it under
the sizing recorded **on that row**, so changing the risk policy later cannot
retroactively change a historical strategy result. Stored per position and per
result: `reference_balance_at_entry`, `nominal_risk_pct`, `nominal_risk_usd`,
`nominal_risk_distance`, `realized_r`, `realized_pnl_usd`.

Defaults are $100,000 and 0.20%, i.e. $200 per 1R, and they are **configuration,
not code**: `sizingFromEnv()` reads `IPO_PAPER_REFERENCE_BALANCE` and
`IPO_PAPER_NOMINAL_RISK_PCT`. Two tests keep it out of the strategy path:
`ipoIncrementalEngine`, `ipoLiveEngine` and `ipoObservation` are grepped for
`nominalRisk`, `referenceBalance`, `riskUsd`, `0.20` and `100_000`, and
`ipoIncrementalEngine`, `ipoLiveEngine` and `ipoPaperRunner` are grepped for the
literal defaults. The engine cannot see a risk policy at all.

No compounding: the reference balance is fixed, so two periods are comparable.

**$200 is a unit of account, not a loss cap**, and a test asserts it. S2 losses
routinely exceed 1R; the test drives a −3R outcome and checks it reports about
−$600 with nothing clamping it.

### 2.2 costR > 2 — an execution rule, not an IPO rule

`buildIntent()` always returns `strategyDecision: "WOULD_ENTER"` for an engine
entry. When `costR > 2` it additionally sets `execution: "BLOCKED"` with
`blockReason: "ECONOMICALLY_UNTRADEABLE_COST"`. The IPO signal is unchanged and
the refusal is written to `ipo_execution_events` alongside the intent, so a
forward test can later measure exactly what the economic rule cost.

The limit is exactly 2 and is deductive: with a fixed 2R target, a round-trip
cost above 2R makes a positive outcome impossible even on a perfect win. A test
pins `costR = 2.0` as EXECUTED and `2.0001` as BLOCKED, and greps the contract
to prove no 0.5R / 0.75R / 1R statistical threshold exists.

### 2.3 Bootstrap placement

```
scheduled worker              browser / UI
   ipo-paper-runner              ipo-paper-state
   ├─ fetch 1,200 closed bars    └─ SELECT persisted rows
   ├─ rebuild the frozen engine       (no engine, no candles, no writes)
   ├─ advance the paper layer
   └─ persist state + rows
```

`HISTORY_BARS` stays at 1,200. A test asserts the read path contains no
`IncrementalEngine`, no `runPaper`, no `fetchCandlesWithFallback`, and no
`.insert`/`.upsert`/`.update`/`.delete` — the UI request path structurally
cannot bootstrap.

Runtime state (cursor bar, activation bar, bars seen, bootstrap count) lives in
the existing generic `kv_cache`, as Phase C's snapshot does. That avoided a
fourth table beyond the three approved.

**An honest limitation, stated rather than hidden.** The frozen engine is not
resumable across stateless invocations: `tracked`, `episodes` and the volatility
window would all need a hand-written serialiser, and a serialiser is exactly the
kind of restatement that drifts from the frozen rules. So the worker rebuilds
each run. What advances incrementally is the paper layer — only bars past the
persisted cursor produce writes, and an open position is managed bar-by-bar by
the contract with no engine involved.

That split means two components can both decide when a position ends, so the
runner **checks them against each other every run**. If the engine holds a
different position, different levels, or has closed one the paper layer still
holds, `runPaper` returns a `divergence` string and the worker writes nothing
for that instrument. A partially-written run whose correctness is unknown would
corrupt exactly the forward record Phase D exists to produce.

### 2.4 Data gaps — no FORCED_FLAT

The design's §11 T9 said an over-long gap yields `FORCED_FLAT`. Per the approved
decision that is **not** implemented. The lifecycle is:

```
open → data_gap_suspended → open                 (recovered, replayed in order)
                          → DATA_GAP_ABORTED      (permanent)
```

An abort carries **no exit price, no `realized_r`, no `realized_pnl_usd`**, is
`excluded_from_stats = true` with an `exclusion_reason`, retains the last known
MAE/MFE and entry state, and records the exact missing interval in
`gap_from_bar_time` / `gap_to_bar_time`. The database refuses any other shape:

```sql
constraint ipo_paper_history_outcome_coherent check (
  (exit_reason <> 'DATA_GAP_ABORTED'
     and exit_price is not null and realized_r is not null
     and excluded_from_stats = false)
  or
  (exit_reason = 'DATA_GAP_ABORTED'
     and realized_r is null and excluded_from_stats = true
     and exclusion_reason is not null))
```

The exclusion is a stored column, not a convention every future reader has to
remember, and the read API filters on it. Aborted rows are still **returned and
counted** under `abortedExcluded` — a hidden failure is worse than a visible one.

**What gap detection can and cannot see.** A provider returns the bars it has;
an interior hole and a closed market are indistinguishable in the payload, and
there is no session calendar here to tell them apart. Two failures are crisply
detectable and both are implemented:

- `COVERAGE_LOST` — the returned window no longer contains the bar we last
  managed, so we cannot prove we saw every bar in between.
- `FEED_STALE` — no closed bar for longer than a market pause could explain.
  The default is 3 days, so a normal FX weekend never trips it.

A suspended instrument takes **no new entries** and does not even rebuild. A
flat instrument on a stale feed opens nothing — filling against a price that may
be days old is not a fill.

---

## 3. Test results

```
deno test supabase/tests/ supabase/functions/   2709 passed | 0 failed  (4m31s)
vitest run                                           57 passed | 0 failed  (2.0s)
deno check supabase/functions/*/index.ts             clean
```

New Phase D tests: 68 across four files, all passing.

| Design item | Where | Result |
|---|---|---|
| T1 executor equivalence | `ipoPaperRunner.test.ts` | bar-by-bar paper trading reproduces the engine's forward trades exactly — entry bar, exit bar, exit price, realized R, MAE, MFE — over **7 independent seeded markets** plus a gated BTC config at full 200-bar warmup |
| T2 fill semantics | same | fills come from the frozen engine's `ENTERED` events; the entry price equality is asserted per trade |
| T3 tie-break | engine (`ipoIncrementalEngine.test.ts`) | unchanged, earliest `ipoIndex` |
| T4 no same-bar re-entry | engine | unchanged; the runner takes engine output |
| T5 S2 wick | `ipoPaperContract.test.ts` | a wick through S2 returns HOLD |
| T6 same-bar ambiguity | same | stop-first, `sameBarAmbiguous = true`, negative R |
| T7 no SMC management | same | the contract is grepped for `breakEven`, `trailing`, `partial`, `moveStop`, `propFirmGate`, `unifiedPositionSizing`, `calculateSLTP`, `scannerManagement`, `broker-execute` |
| T8 idempotent replay | runner + functions | identical input produces byte-identical events, results and position; all keys are content-addressed and every write upserts on them |
| T9 gap recovery | `ipoPaperRunner.test.ts` | suspend → recover → replay in order, and the recovered trade's exit matches the engine's exactly; permanent gap → abort with no fabricated exit. **`FORCED_FLAT` appears nowhere** (asserted) |
| T10 dual decision | runner + contract | `strategy_decision` stays `WOULD_ENTER` under `BLOCK_CORRELATION` and under `ECONOMICALLY_UNTRADEABLE_COST` |
| T11 advisor isolation | `ipoAdvisorIsolation.test.ts` | written first; passing |
| T12 Journal isolation | same | the Journal's source table set is pinned and contains no IPO table |
| T13 RLS | — | **cannot be tested until the migration is applied.** The SQL is asserted statically instead: ENABLE + FORCE RLS, REVOKE from `anon`/`authenticated`, GRANT to `service_role`, on all three tables |
| T14 schema guards | `ipoPaperFunctions.test.ts` | `strategy_id` NOT NULL, `execution_mode` CHECK rejects anything but `'paper'`, partial unique index blocks a second open position, and every event type and exit reason the code emits is proven to be accepted by the CHECK lists |
| T15 SMC regression | full suites | see above |

Type checking: `deno check` passes on every new module and on every
`supabase/functions/*/index.ts`. (The suite runs `--no-check`, so this was run
separately.)

---

## 4. Isolation proof

`ipo-paper-runner` touches exactly four tables, asserted by extracting every
`.from("…")` in the file and comparing the set:

```
ipo_execution_events · ipo_paper_positions · ipo_paper_trade_history · kv_cache
```

`ipo-paper-state` performs only `.select(…)`.

Both files are grepped (with comments stripped, and with IPO's own
`ipo_*` identifiers removed first so `ipo_paper_positions` does not mask
`paper_positions`) for: `paper_positions`, `pending_orders`,
`paper_trade_history`, `paper_accounts`, `trade_history`, `bot_setups`,
`broker_connections`, `broker-execute`, `paper-trading`, `bot-scanner`,
`unifiedPositionSizing`, `propFirmGate`, `calculateSLTP`, `scannerManagement`.

The owner user id comes from `IPO_PAPER_USER_ID`, deliberately **not** from
SMC's `paper_accounts` list — discovering it there would couple IPO to a table
it must not read.

Both functions were added to the shadow-isolation allow-list in
`ipoZones.test.ts` with the reason recorded inline, and `ipoPaperContract.ts`
and `ipoPaperRunner.ts` were added to the guarded module list.

---

## 5. Deliberate behaviours worth knowing before this runs

1. **Activation writes nothing historical.** The first run sets the cursor to
   the newest closed bar and records no trades. Backfilling 1,200 bars of engine
   output would look like forward paper results while being pure hindsight.
2. **A trade already open at activation is not adopted.** We never saw it fill.
   The engine's own sequencing then blocks new entries until it finishes, so the
   first forward entry can be delayed by up to one trade. This is a known,
   bounded cost of switching on mid-stream.
3. **A divergent run writes nothing for that instrument** and reports the reason
   in the response. It is a condition to investigate, not to retry blindly.
4. **The runtime cursor is written last**, after results, positions and events,
   so a crash mid-run replays the same window — which the content-addressed keys
   make a no-op.

---

## 6. Not done, and why

- Migration **not applied**, functions **not deployed**, no cron. Stopped here
  as instructed.
- T13 (live RLS behaviour) awaits the migration.
- No Journal change. The design says Phase D is design-only there, and the
  default Journal view stays SMC-only.
- No UI. Phase C's observation panel is unchanged; a paper panel would read
  `ipo-paper-state` and is not part of this scope.
- `#580` remains open. Consolidation remains unresolved.
- The `maxCorrelation` config drift found in Phase A is still **not fixed** — it
  is an SMC change needing its own regression testing.

---

## 7. To apply, when approved

```
supabase migration up            # 20260921140000_ipo_paper_state.sql
supabase secrets set IPO_PAPER_USER_ID=<uuid>
supabase functions deploy ipo-paper-runner
supabase functions deploy ipo-paper-state
```

Optional sizing overrides: `IPO_PAPER_REFERENCE_BALANCE`,
`IPO_PAPER_NOMINAL_RISK_PCT`.

**UPDATE, D.2:** `docs/patches/ipo_paper_ledger_rls.patch` no longer exists. It
turned out not to apply, and the table it hardened was retired rather than
fixed — see `docs/IPO_PHASE_D2_STATUS.md`. `20260921140000_ipo_paper_state.sql`
is now the only pending migration.
