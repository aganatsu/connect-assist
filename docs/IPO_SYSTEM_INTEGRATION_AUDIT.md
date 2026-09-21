# IPO ↔ Existing System Integration Audit

**Read-only architecture study. 2026-09-21.** No code, schema, function, cron or
frontend was modified in producing it.

Traced from source, not documentation. File and line references are to
`feature/ipo-live-integration` @ `ddece731`.

---

## 0. The finding that governs everything else

**`paper_positions` is not a record of paper trades. It is the enrollment list
for every automated action the bot takes.**

A row in that table is, by membership alone and with no further opt-in:

- managed every 60 seconds (break-even, trailing, partial, SL tighten)
- eligible for SL/TP breach closure
- eligible for prop-firm emergency close-all
- counted against `maxOpenPositions` and `maxPerSymbol`
- **able to reach the broker** — the management loop calls `broker-execute`
  directly (`bot-scanner:2553, 2571, 2698, 2719`) when
  `paper_accounts.execution_mode === "live"`

The only thing standing between an IPO row and all of that is one filter:

```js
// bot-scanner/index.ts:2470-2471
let openPosArr = (openPositions || []).filter(
  (p: any) => !p.bot_id || p.bot_id === BOT_ID);   // BOT_ID = "smc"
```

`!p.bot_id ||` — **a NULL `bot_id` is adopted, not excluded.** A single insert
that forgets the column hands an IPO position to the existing bot's stop logic,
and if the account is live, to a broker.

That is the whole risk, in one line.

---

## 1. Existing system — end-to-end flow

```
pg_cron (supabase/cron/setup_cron.sql)
  │  bot-scanner          scan     */5 * * * *
  │  bot-scanner          manage   *   * * * *
  │  zone-confirmation-scanner      *   * * * *
  │  outcome-tracker               15   * * * *
  │  data-cleanup / reviews / prop-firm reset (daily/weekly)
  ▼
bot-scanner/index.ts  (8,584 lines — one function, the whole pipeline)
  │
  ├─ CONFIG        bot_configs → mapNestedToFlat/applyPairOverrides (configMapper)
  │                ~120 settings; DEFAULTS at :112-330
  │
  ├─ POSITIONS     paper_positions WHERE user_id, status=open        :2468
  │                └─ filter by bot_id                                :2471
  │                └─ refresh current_price via cachedFetch           :2476
  │
  ├─ MANAGE        manageOpenPositions(_shared/scannerManagement.ts)  :2516
  │                actions: be_enabled · trailing_enabled ·
  │                         partial_enabled · sl_tightened · no_change
  │                └─ live mode → broker-execute modify/partial-close
  │
  ├─ BREACH        SL/TP crossed → close + paper_trade_history        :2928
  │
  ├─ PENDING       pending_orders monitor: fill / expire / invalidate :3323
  │                └─ thesis revalidation (thesisValidator)           :3494
  │                └─ zone confirmation (zoneConfirmation)            :3784
  │                └─ FILL → paper_positions.insert                   :3933
  │                        → broker-execute if live                   :4048
  │
  ├─ GATE 0        propFirmGate → emergency close-all                 :4162,4205
  │
  ├─ DATA          candleSource.fetchCandlesWithFallback
  │                MetaAPI → TwelveData → Polygon, kv_cache, FOTSI
  │                reservations via reserve_api_credit RPC (fail-open)
  │
  └─ PER PAIR      HTF POI → Fib/PD/liquidity → direction engine
                   → directionVerdict                                 :5992
                   → unifiedZoneEngine (primary signal)               :6067
                   → impulseZoneEngine gate (hard/soft/off)           :6091
                   → cascadeZoneEngine (swing_trader only)            :5622
                   → structuralOrderBlockRunner (SHADOW)              :5351
                   → confluenceScoring.runConfluenceAnalysis
                   → ICT gates (HTF/MSS/Judas/FVG/killzone/risk)
                   → conflict counter · game plan · news gates
                   → staged_setups (watchlist)                        :6135
                   → checkPortfolioConflict                           :7135
                   → calculateSLTP  (slMethod "structure", tpMethod "rr_ratio")
                   → computePositionSize (unifiedPositionSizing)      :7172
                   ├─ LIMIT path  → pending_orders.insert             :7512
                   └─ MARKET path → paper_positions.insert            :7775
                                  → broker-execute if live            :7899
                   → logRejectedSetup otherwise                       :8192
                   → scan_logs.insert (details_json)

zone-confirmation-scanner (every minute)
  └─ pending_orders awaiting_confirmation → CHoCH → paper_positions.insert

outcome-tracker (hourly) → grades rejected_setups
bot-daily-review / bot-weekly-advisor → read-only analytics
frontend (React/Vite) → supabase-js as `authenticated`, RLS-scoped by user_id
```

---

## 2. Every trade-creation path

| table | INSERT by | UPDATE by | DELETE by |
|---|---|---|---|
| **paper_positions** | bot-scanner ×2, zone-confirmation-scanner ×1, paper-trading ×1 | paper-trading ×8, **scannerManagement ×7**, bot-scanner ×3, zone-conf ×1 | paper-trading ×4, bot-scanner ×2, propFirmGate ×1 |
| **paper_trade_history** | paper-trading ×4, bot-scanner ×2, **propFirmGate ×1** | — | paper-trading, data-cleanup |
| **pending_orders** | bot-scanner ×1 | bot-scanner ×14, zone-conf ×6 | — |
| **staged_setups** | bot-scanner ×2 | bot-scanner ×7 | — |
| **trades** | trades ×2 (manual journal) | trades ×1 | trades, paper-trading |
| **paper_accounts** | paper-trading ×2 | paper-trading ×14, bot-scanner ×8, propFirmGate ×1 | — |
| `broker_execution_ledger` | — | — | — (in baseline schema, **referenced by no function**) |
| `setup_lifecycle_events` | — | — | — (same: dormant) |

**Concurrency.** `bot-scanner manage` and `zone-confirmation-scanner` both run
every minute and both write `paper_positions`; `bot-scanner scan` overlaps every
5th minute. Serialisation is by optimistic claim (`:2996` re-selects after a
conditional update and skips if another cycle won), not by lock.

### Answers to the specific questions

| if IPO wrote to the existing tables, could it… | verdict |
|---|---|
| count toward the old bot's max positions | **YES** unless `bot_id` is set — `:1568` counts `openPosArr` |
| be managed by the old bot | **YES** — `manageOpenPositions` receives `openPosArr` |
| be closed by the old management loop | **YES** — breach close `:2928` and prop-firm `:4205` both take `openPosArr` |
| trigger broker execution | **YES, indirectly** — management calls `broker-execute` at `:2553/2571/2698/2719` when the account is live. The insert itself does not; the *management of it* does. |
| trigger prop-firm logic | **YES** — `propFirmEmergencyClose` deletes the row and writes `paper_trade_history` with `close_reason: "prop_firm_emergency"` |
| appear as an old-strategy trade | **YES** — no strategy column exists; analytics, reviews and the journal would pool it |
| cause pending-order collisions | **YES if it used `pending_orders`** — 14 update sites and a 6-update second writer, all unscoped by strategy |

---

## 3. Existing strategy component classification

| component | status |
|---|---|
| `directionEngine` / `directionVerdict` | **AUTHORITATIVE** — single source of direction (`:5992`) |
| `unifiedZoneEngine` | **AUTHORITATIVE** — primary signal source (`:6067`) |
| `impulseZoneEngine` | **AUTHORITATIVE, configurable** — hard / soft / off |
| `cascadeZoneEngine` | **OPTIONAL** — `swing_trader` style only |
| `structuralOrderBlockRunner` | **SHADOW ONLY** (`:5351`) |
| `confluenceScoring` | **AUTHORITATIVE** — gates on `minConfluence` |
| ICT gates (HTF, MSS, Judas, FVG-invalidation, killzone, risk) | **OPTIONAL** — each has an "off" mode; several are log-only by default |
| `thesisConviction` | **SHADOW** — "log only, no trade impact" (`:6453`) |
| `zoneConfirmation` | **AUTHORITATIVE** on the limit path |
| `thesisValidator` | **AUTHORITATIVE** — can cancel a pending order |
| `calculateSLTP` | **AUTHORITATIVE** |
| `unifiedPositionSizing` | **AUTHORITATIVE** |
| `propFirmGate` | **AUTHORITATIVE, pre-emptive** — Gate 0, can close everything |
| `scannerManagement` | **AUTHORITATIVE** — mutates stops on live positions |
| `structureShadow`, `structureLagObserver`, `rejectedSetupLogger` | **OBSERVATIONAL** |
| `broker_execution_ledger`, `setup_lifecycle_events` | **LEGACY / dormant** |

---

## 4. Existing vs IPO — conflict matrix

| dimension | existing bot | IPO candidate | verdict |
|---|---|---|---|
| Signal origin | unifiedZone + confluence score ≥ `minConfluence` | valid IPO lifecycle + FVG | **MUST REMAIN ISOLATED** |
| State model | per-scan evaluation, staged_setups watchlist | multi-state lifecycle (contraction → expansion → trend → touch) carried across bars | **CONFLICTS** — two different state machines over the same instrument |
| Entry | market at zone, or limit at OB/FVG with CHoCH confirmation | **E2**: limit at the IPO candle's 50% | **SIMILAR BUT DIFFERENT** — same mechanism, different level and no confirmation step |
| Stop | `slMethod: "structure"` + ATR floor + buffer, **mutated in flight** | **S2**: close beyond the IPO candle extreme, **never moved** | **CONFLICTS — irreconcilable** |
| Target | `tpMethod: "rr_ratio"`, `tpRatio 2.0`, regime-adjusted | **T_2R** fixed, no adjustment | **SIMILAR BUT DIFFERENT** |
| Volatility | ATR filter as a pass/fail gate | causal ATR(14)/price terciles as an eligibility bucket (BTC only) | **SIMILAR BUT DIFFERENT** |
| Concurrency | `maxOpenPositions` 3, `maxPerSymbol` 2, portfolio heat | exactly one per instrument, first-come-first-served | **CONFLICTS** |
| Sizing | `unifiedPositionSizing`, prop-firm multiplier | undecided — R-multiples only, and nominal R ≠ realized loss | **MUST REMAIN ISOLATED** |
| Sessions / kill zones | enabled sessions, active days | none — every closed bar is eligible | **CONFLICTS** |
| Candle data | `candleSource` fallback chain | same | **SHARED SAFELY** (subject to §6) |
| `SPECS`, pip sizes, symbols | shared constants | shared | **SHARED SAFELY** |
| Auth, routing, AppShell, UI kit | existing | reuse | **SHARED SAFELY** |
| Telegram, logging, cors | existing | reuse | **SHARED SAFELY** |

---

## 5. Database impact — recommendation **B: isolated tables**

RLS posture today (all user-scoped via `user_id`, `authenticated` role):

| table | RLS | policies |
|---|---|---|
| paper_accounts / paper_positions / paper_trade_history | on | 1 each |
| pending_orders / staged_setups | on | 4 each |
| trades / trade_reasonings / rejected_setups / scan_logs / bot_configs | on | 1 each |
| ipo_corpus_examples | on + **FORCE**, grants revoked | 0 (service-role only) |
| **ipo_paper_ledger** | on, **no FORCE, no REVOKE/GRANT** | 0 |

### Why not A (shared tables + `strategy_id`)

A `strategy_id` column only helps if **every** reader filters on it. Today:

- 4 functions insert into `paper_positions`, 4 update it, 3 delete from it
- the single guard is `!p.bot_id || p.bot_id === BOT_ID` — **fail-open on NULL**
- `propFirmGate`, `scannerManagement`, the breach-close block, the max-position
  gate and the daily/weekly reviews would each need a new filter
- a missed filter is not a visible bug. It is the old bot silently moving a
  frozen IPO stop, or closing an IPO position, in production

Adding `strategy_id` converts a one-line invariant into a dozen, spread over
8,584 lines of a function that already routes to a broker.

### Recommendation

**B — isolated IPO tables until forward validation completes.** `ipo_paper_ledger`
already exists and is sufficient. The IPO candidate must not write
`paper_positions`, `pending_orders`, `paper_trade_history` or `paper_accounts`
in any form during forward testing.

Revisit only when there is forward evidence and a deliberate decision to give
IPO real risk. At that point the correct move is probably still not shared
tables but a shared *execution* service both strategies call.

**Two defects in the current IPO table, recorded not fixed:**
1. missing `FORCE ROW LEVEL SECURITY` — the owner role bypasses RLS
2. missing `REVOKE ALL … FROM anon, authenticated` / `GRANT … TO service_role`

Both are present on `ipo_corpus_examples` (migration `20260920100000`) and absent
from `20260921120000`.

---

## 6. Scheduler and concurrency

| job | schedule | writes |
|---|---|---|
| bot-scanner `scan` | `*/5 * * * *` | positions, pending, staged, scan_logs, rejected |
| bot-scanner `manage` | `* * * * *` | positions, history, accounts |
| zone-confirmation-scanner | `* * * * *` | positions, pending, reasonings |
| scanner-operational-health | `* * * * *` | health |
| outcome-tracker | `15 * * * *` | rejected_setups grading |
| kv-cache-cleanup | `15 * * * *` | kv_cache |
| data-cleanup | `0 3 * * *` | history pruning |
| daily review / prop-firm reset | `0 22`, `0 23` | analytics |
| weekly advisor | `0 23 * * 0` | analytics |

**The binding constraint is market-data credits, not CPU.** `apiCreditBudget`
reserves through a Postgres RPC because a per-isolate limiter was measured at
"75 credits/min average, 371 peak, 100% of quota" while each isolate believed
itself under budget. The reservation **fails open** on RPC error or timeout — so
overload does not appear as clean refusal, it appears as provider throttling and
stale candles.

An IPO scanner fetching 1,200 bars × 3 instruments per run is a material new
draw on an already-saturated quota. Any scheduling must (a) call
`setCreditCallerContext` — the current function already does — (b) reuse
`candleCache`/`kv_cache` rather than fetching independently, and (c) not land on
the same minute boundary as the two every-minute jobs.

---

## 7. Frontend placement

Existing: React 18 + Vite, `react-router-dom` v6, TanStack Query, shadcn/ui,
recharts + lightweight-charts. 16 routes, `AppShell`, three nav lists
(`AppSidebar` 10, `IconRail` 13, `MobileNav` 13).

**Recommended: a separate top-level page**, not a tab inside `BotView`.

`BotView` is the operating surface for the live bot. Putting an unvalidated
paper strategy inside it invites reading one strategy's numbers as the other's,
and the two have different position semantics, different stop behaviour and
different risk units. A strategy *selector* implies interchangeability that does
not exist yet.

`RejectedSetups.tsx` is the right template: read-only, cards + filters + table,
no execution affordances.

**Blocker:** the frontend queries as `authenticated`; `ipo_paper_ledger` has RLS
on with zero policies, so every query returns `[]` silently. Requires either a
SELECT-only policy or a read-through edge function. Unresolved.

---

## 8. Configuration collision

The IPO candidate must use **its own immutable, versioned spec** —
`docs/IPO_FORWARD_TRADING_SPEC.md` v1.1, mirrored in code constants — and must
**not** read `bot_configs`.

`bot_configs` feeds ~120 settings through `configMapper`. Silently inherited,
these would each invalidate the frozen result:

| setting | effect on IPO |
|---|---|
| `minConfluence` (55) | filters trades the validation never filtered |
| `slMethod: "structure"`, `slATRMultiple`, `slBufferPips`, `MIN_SL_PIPS` | replaces S2 and changes 1R, therefore changes every R figure |
| `tpMethod`, `tpRatio`, regime TP adjust | replaces T_2R |
| `breakEvenEnabled` (true), `breakEvenPips` | moves a stop the frozen rule never moves |
| `trailingStopEnabled`, `partialTPEnabled` | ditto |
| `enabledSessions`, `enabledDays` | removes eligible bars |
| `maxOpenPositions`, `maxPerSymbol`, `portfolioHeat` | breaks one-per-instrument sequencing |
| `spreadFilterEnabled`, `newsFilterEnabled`, ATR filter | new refusals |
| `riskPerTrade`, prop-firm multiplier | sizing against nominal R, which understates loss ~1.75× |

The validated numbers are only meaningful under the exact frozen rule set. A
config-driven IPO is a different, unvalidated strategy wearing the same name.

---

## 9. Risk-management collision

If an IPO position entered the existing management pipeline:

| mechanism | source | effect on a frozen IPO trade |
|---|---|---|
| break-even move | scannerManagement `:495` | **moves the stop** — S2 says the stop never moves. Converts losers into scratches and destroys the loss distribution the sizing decision depends on |
| SL tighten | `:441` | same |
| trailing stop | `:553, :640` | **caps winners below 2R** — T_2R is a fixed limit; a trail exits first |
| partial TP | `partial_enabled` | halves position at an unvalidated level |
| SL/TP breach close | bot-scanner `:2928` | closes on a **wick**; S2 requires a **close** beyond the extreme. This alone flips a large share of outcomes |
| prop-firm emergency close | propFirmGate `:310-324` | deletes the position mid-trade, writes `close_reason: prop_firm_emergency` |
| max-open-position gate | `:1568` | suppresses IPO entries, or IPO suppresses the live bot's |
| portfolio heat / correlation | `checkPortfolioConflict :7135` | additional unvalidated refusals |
| broker mirror | `:2553, 2571, 2698, 2719` | **a management action on a live account sends a real order** |

**The single most damaging one is the SL/TP breach close.** S2's entire
character — tolerating deep wicks, which is why median losses run 1.75R — is
erased by a wick-triggered stop. It would not merely reduce the edge; it would
produce a different strategy whose backtest does not exist.

---

## 10. Highest-risk integration points, ranked

1. **`paper_positions` membership** — fail-open `bot_id` NULL adoption. One
   forgotten column exposes a frozen strategy to stop mutation and a broker.
2. **`scannerManagement` + breach close** — will silently rewrite IPO outcomes.
3. **`execution_mode === "live"`** — an account-level flag, not per-strategy.
   Nothing lets an account be live for one strategy and paper for another.
4. **`propFirmGate` close-all** — pre-emptive, unscoped by strategy.
5. **`bot_configs` inheritance** — invalidates the validated result without any
   visible failure.
6. **Shared API credit budget** — already saturated, fails open.
7. **`pending_orders`** — 20 write sites across two functions, no strategy scope.
8. **`ipo_paper_ledger` RLS** — no FORCE, no REVOKE; and unreadable by the
   frontend as configured.

---

## 11. Recommended integration architecture

**Parallel, not merged.** The IPO candidate runs beside the existing bot and
shares only stateless utilities.

```
SHARED (stateless, safe)          ISOLATED (stateful, must not be shared)
─────────────────────────         ──────────────────────────────────────
candleSource + candleCache        ipo_paper_ledger        (own table)
apiCreditBudget                   frozen IPO spec         (own config)
SPECS / pip sizes / symbols       LiveEngine state        (own lifecycle)
cors, telegram, logging           one-per-instrument      (own concurrency)
AppShell, UI kit, auth, routing   S2 invalidation         (own risk model)
```

Rules that should hold for as long as IPO is unvalidated forward:

1. IPO writes **only** `ipo_paper_ledger`. Never `paper_positions`,
   `pending_orders`, `paper_trade_history`, `paper_accounts`.
2. IPO reads **no** `bot_configs`. Its parameters live in versioned code.
3. IPO never calls `broker-execute`, `unifiedPositionSizing` or `propFirmGate`.
4. The existing bot's code is not modified to accommodate IPO. Isolation is
   achieved by IPO not entering, not by the old bot learning to exclude it.
5. If the two ever must share execution, build a shared execution service both
   call — do not teach one strategy's pipeline about the other.

---

## 12. Proposed phased plan — **NOT IMPLEMENTED**

**Phase 0 — close the two table defects.** Add `FORCE ROW LEVEL SECURITY` and
`REVOKE`/`GRANT` to `20260921120000`, matching `ipo_corpus_examples`. Migration
is unapplied, so this is an edit, not a schema change.

**Phase 1 — decide frontend read access.** SELECT-only policy for
`authenticated`, or a read-through edge function. Blocks everything visual.

**Phase 2 — paper environment.** Apply the migration, deploy
`ipo-paper-trading`, invoke manually, audit rows against a local engine replay.
Currently blocked: there is no non-production Supabase project, and both
migrations and function deploys are wired to merge-on-`main`.

**Phase 3 — read-only frontend page.** `/ipo-strategy`, ledger-backed, no
execution affordances, registered in all three nav lists.

**Phase 4 — scheduling.** Only after manual runs are verified. Off the
every-minute boundary, reusing the shared cache, with credit attribution.

**Phase 5 — forward evaluation.** Accumulate live-forward rows and compare
against the causal baseline in spec §11 (portfolio +0.585R, 72.6% win, PF 2.02,
~104 trades/month). No rule changes in response.

**Phase 6 — only if Phase 5 holds.** Revisit execution and sizing, including the
two open blockers: position sizing against a 1.75R median loss, and BTC's
cost-dominated setups.

---

**Nothing in this document has been implemented. No code, schema, function,
cron, policy or frontend was changed.**

---
---

# ADDENDUM — API Architecture & Strategy Control

**Read-only. 2026-09-21.** Nothing implemented, migrated, scheduled or deployed.

---

## PART A — Market data and API credits

### A.1 The credit mechanism

- Reservation is a Postgres RPC, `reserve_api_credit(p_provider, p_limit, p_window_seconds, p_caller)`, `SECURITY DEFINER`, counting rows in `api_credit_usage` inside a sliding window.
- `api_credit_usage(id, provider, reserved_at, caller)` — one row per granted credit; index `(provider, caller, reserved_at DESC)`.
- Limit at the call site: **`TD_RATE_LIMIT = 50`** per **60 s** (`candleSource.ts:25`), deliberately 50 of an actual 55 for margin.
- **It fails open.** RPC error, non-boolean, or a 2 s timeout → the fetch proceeds anyway (`apiCreditBudget.ts:89-109`). Overload therefore shows up as provider throttling and stale candles, not as clean refusal.
- Postgres was chosen because a per-isolate limiter measured **75 credits/min average, 371 peak, 100% of quota** while every isolate believed itself under budget.

### A.2 Caching layers

| layer | scope | TTL | file |
|---|---|---|---|
| `createScanCache` | one scan cycle, in-memory, de-dupes identical `(symbol, tf, range)` and coalesces in-flight | cycle | `dataCache.ts` |
| `candleCache` (`kv_cache`) | cross-function, cross-invocation | daily 1 h, weekly 6 h | `candleCache.ts` |
| `batchGetCachedCandles` / `batchSetCachedCandles` | bulk read/write of the above | same | `candleCache.ts` |
| `fotsiCache` | 28-pair currency-strength result | 4 h | `fotsiCache.ts` |

**`candleCache` only covers daily and weekly.** Intraday (15m/1h/4h) is cached only within a single scan cycle and is re-fetched from the provider on the next one.

### A.3 Per-function consumption

| function | cadence | candle demand |
|---|---|---|
| **bot-scanner `scan`** | `*/5` | dominant consumer. 12 instruments × ~11 `cachedFetch` call sites (1d ×4, 4h ×2, 1h ×2, 15m ×2, 1w ×1), de-duped per cycle to roughly 5–7 unique fetches per pair, plus FOTSI (28 pairs, amortised over 4 h) and one 15m refresh per open-position symbol |
| **bot-scanner `manage`** | `* * * * *` | one 15m/5d fetch per distinct open-position symbol (`:2476`) |
| **zone-confirmation-scanner** | `* * * * *` | confirmation-timeframe fetch per pending order awaiting confirmation |
| **market-data** | on demand | frontend-driven |
| **paper-trading** | on demand | none via `candleSource` — no credit context registered |
| **outcome-tracker** | `15 * * * *` | fetches to grade rejected setups |
| **backtest-engine** | manual | bursty; registers credit context |
| **daily / weekly advisor** | daily / weekly | analytics reads, minimal |

Provider fallback: **MetaAPI → TwelveData → Polygon**, with a 60 s global deadline per call and a `TD_MAX_WAIT_MS` throttle that skips straight to Polygon rather than queueing.

### A.4 Modelled IPO load — the premise was wrong

**API cost is negligible.** TwelveData takes `outputsize` as a single parameter; 1,200 bars is **one request**, not 1,200. `ipo-paper-trading` as written costs:

> **3 credits per run** (EUR/USD 1H, BTC/USD 1H, USD/JPY 30M — one request each)

Against a 50/min budget that is trivial even at 5-minute cadence.

**The real constraint is CPU, and it is fatal as designed.**

Measured in this session, replaying one window through `LiveEngine`:

| bars | wall clock |
|---|---|
| 1,083 | 64.9 s |
| 1,464 | 197.4 s |
| 1,464 (BTC) | 231.0 s |
| 2,057 | 454.6 s |
| 2,170 | 323.4 s |

The Supabase Edge Function budget is **~150 s** (`candleSource.ts:796`, `bot-scanner:2164`). **A single 1,200-bar instrument already exceeds it; three sequentially exceed it several times over.** `ipo-paper-trading` would time out on its first real invocation.

Cause: `LiveEngine.feed()` re-runs `runLifecycle(prefix) + episodesFor(prefix)` on every bar — O(n²) — and `buildRows` calls `runLifecycle` a second time per event, roughly doubling it. That was a deliberate correctness choice (one copy of each rule, no drift), and it is right for offline replay. It is not viable in a 150 s request.

**This must be resolved before scheduling is even a question.** Options, none implemented:
- run the replay outside an Edge Function (a worker with no 150 s ceiling)
- persist engine state so each invocation processes only new bars — rejected earlier for good reason: persisted state drifts from the rules that produced it
- make the engine incremental while proving bar-for-bar equivalence against the current replay (the equivalence harness already exists for exactly this)
- shorten the window to whatever fits, accepting reduced warm-up — but BTC needs ≥ 200 bars before its volatility bucket resolves at all

### A.5 Shared-data architecture options

| | credits | consistency | failure isolation | latency | complexity | risk to existing bot |
|---|---|---|---|---|---|---|
| **A. reuse `candleCache`** | no change (3/run either way) | poor — intraday isn't cached, so IPO would mostly miss | good | good | low | **low** |
| **B. persist canonical closed bars, both read** | −3/run at best | **best** — one truth, and IPO needs exactly this (closed bars only) | good | good | medium | low-medium (new table, SMC unchanged until it opts in) |
| **C. central acquisition → fan-out** | best in theory | best | **poor** — one fetcher becomes a single point of failure for live trading | adds a hop | high | **high — rewrites the live bot's data path** |
| **D. IPO fetches independently** *(current)* | +3/run | weakest — two views of the same bar | **best** | best | none | **none** |

**Ranking for this decision: B, then D, then A, then C.**

**C is the theoretically clean answer and the wrong one now.** It puts the live trading system's data supply behind new shared infrastructure to save three credits a run. The saving does not exist; the risk does.

**D — what exists today — is defensible in the interim** precisely because the credit cost is negligible and failure isolation is total. Its weakness is consistency: SMC and IPO could disagree about the same bar.

**B is the right destination.** IPO's requirement is narrow — *closed* bars on three instruments — which is exactly what a canonical closed-bar store is good at, and it can be introduced without SMC reading from it until someone chooses to.

### A.6 Does IPO need 5-minute polling? **No.**

IPO evaluates only on **closed** bars. 1H bars close 24×/day; 30M bars close 48×/day. Polling faster than bar close cannot produce a new decision — it can only re-derive the same one.

> Sufficient cadence: **once per 30 minutes**, offset a minute or two after the boundary.
> 48 runs/day versus 288 at 5-minute polling — an **83% reduction** in invocations for zero loss of signal.

Offsetting also keeps it off the `:00` boundary where both every-minute jobs land.

---

## PART B — `strategy_activation_registry` / `_events`

### B.1 What they are

Defined in `20260914000000_baseline_schema.sql` (registry `:1090`, events `:1070`). **No edge function and no frontend code reads or writes either table.** They appear in `src/integrations/supabase/types.ts` only because that file is generated from the schema. They are **built, governed, indexed — and entirely unused.**

**Registry** — current state per activation:

`user_id`, `bot_id` (default `'smc'`), `feature_key`, `variant_key` (default `'default'`), `activation_scope` jsonb + `activation_scope_hash`, `authority_stage`, `runtime_scope`, `evidence_contract_version` (default `strategy-evidence.v1`), `evidence_snapshot` jsonb, `evidence_hash`, `evidence_window_start/end`, `transition_reason`, `approved_by`, `approved_at`, `runtime_enforced`, `revision`, timestamps.

**Events** — append-only transition log: `activation_id` FK (cascade), from/to `authority_stage`, from/to `runtime_scope`, evidence contract + snapshot + hash, `reason` (NOT NULL), `actor_id`, `revision`.

### B.2 Constraints — this is a governance ledger, not a flag table

- `authority_stage ∈ {shadow, log_only, soft_adjustment, hard_block}`
- `runtime_scope ∈ {observation, paper, live_canary, live}`
- **`runtime_enforced = false` OR (`authority_stage ∈ {soft_adjustment, hard_block}` AND `runtime_scope ∈ {paper, live_canary, live}`)** — a feature cannot be enforced from a shadow stage or an observation scope. The database refuses it.
- `evidence_window_end >= evidence_window_start`
- unique on `(user_id, bot_id, feature_key, variant_key, activation_scope_hash)`
- `revision > 0`

### B.3 RLS

| | policy |
|---|---|
| registry | **SELECT only**, `auth.uid() = user_id` |
| events | **SELECT only**, `auth.uid() = user_id` |

**There is no INSERT, UPDATE or DELETE policy on either table.** Writes are possible only through `transition_strategy_activation(...)` — `SECURITY DEFINER`, `search_path` pinned, which validates stage and scope, **requires a reason** (`RAISE EXCEPTION 'Every activation transition requires a reason'`), takes `p_expected_revision` for optimistic concurrency, and writes registry + event together.

### B.4 Can they be the control plane? **Yes — and they are better suited than `bot_configs`.**

| property | why it matters here |
|---|---|
| users cannot write directly | a strategy cannot be switched on by an accidental `UPDATE` |
| every transition needs a reason and an actor | an audit trail of who enabled live trading and why |
| append-only event log | the history cannot be rewritten |
| optimistic concurrency | two tabs cannot race a mode change |
| `runtime_scope` already models `observation / paper / live_canary / live` | **maps directly onto OFF / PAPER / LIVE** |
| `runtime_enforced` CHECK | a database-level refusal to enforce an unproven strategy |
| `evidence_snapshot` + `evidence_hash` | the promotion gate the IPO programme has been producing evidence for all along |

**One caveat of fit.** The vocabulary is `feature_key` / `variant_key` — designed for "should this *feature* be enforced", not "is this *strategy* running". Using it as a strategy selector means adopting a convention, e.g. `feature_key = 'strategy.ipo_cet'`, `variant_key = 'v1.1'`. That is a naming decision, not a schema change, and it should be written down before the first row exists or the table will accumulate two incompatible conventions.

`bot_id` defaults to `'smc'`, which is a second reason to be explicit.

---

## PART C — Shared account and risk questions

These are **policy decisions, not technical ones.** Recorded here with the consequence of each choice, decided nowhere.

| # | question | why it cannot be answered from intuition | would it alter validated IPO? |
|---|---|---|---|
| C1 | Shared portfolio heat? | Heat is a function of correlated exposure. SMC and IPO can hold the same pair in opposite directions, which is either a hedge or double risk depending on sizing | **YES** — a shared heat cap refuses IPO entries the validation never refused |
| C2 | Should one strategy's open EUR/USD block the other's? | Validated IPO is one-position-per-instrument **within IPO**. Cross-strategy blocking is a different rule | **YES** — changes the trade set directly |
| C3 | Max positions global or per strategy? | Global caps make the two strategies compete for slots; whichever scans first wins | **YES** — first-come-first-served across strategies is not what was validated |
| C4 | Conflicting directions? | Net-flat is not the same as two independent positions with independent stops | **YES** if netting; **NO** if both simply run |
| C5 | Own virtual account for IPO paper? | Shared `paper_accounts` means one equity curve, one drawdown, one prop-firm trigger | **YES** — shared prop-firm state can emergency-close an IPO position |
| C6 | What changes if IPO goes live? | `execution_mode` is **account-level**, not per-strategy. There is currently **no way** to run SMC live and IPO paper on one account | **YES** — this is a structural gap, not a setting |

**C6 is the one to note now.** The frontend design below shows `LIVE 🔒` for IPO. That lock is not only policy — the system has no mechanism to honour a per-strategy live/paper split. Implementing one is a prerequisite for IPO live, not a detail of it.

**Default posture until forward validation completes:** every answer that keeps IPO isolated. Own virtual account, per-strategy limits, no shared heat, no cross-strategy blocking. That is the only configuration whose expectancy has been measured.

---

## PART D — Strategy Control UI (design only)

### D.1 Existing surfaces

- **`BotView`** — live operating surface for SMC.
- **`Settings`** — `bot_configs` editor, ~120 settings.
- **`ScheduledTasks`** — cron CRUD, reads `scheduled_tasks`, shows last run.
- **Navigation** — `AppSidebar` (10), `IconRail` (13), `MobileNav` (13). A new route must be added to all three.

### D.2 Proposed: a `/strategies` control page

A new top-level page, **not** a tab inside `BotView` and **not** a mode dropdown. A dropdown implies the two are interchangeable configurations of one engine; they are two engines with incompatible risk models.

```
Strategies                                        [data feed: ● healthy]

┌────────────────────────────────────────────────────────────────┐
│ SMC  (current)                         ● PAPER                 │
│ 12 instruments · 15m/1h/4h/1d                                  │
│ last scan    2m ago            next     in 3m                  │
│ open         2 positions       feed     ● MetaAPI              │
│ [ OFF ]  [ PAPER ]  [ LIVE ]                    → Performance  │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ IPO Contraction–Expansion–Trend        ○ OFF                   │
│ EUR/USD 1H · BTC/USD 1H · USD/JPY 30M                          │
│ last scan    never             next     on next bar close      │
│ open         0                 feed     — · BTC warmup 0/200   │
│ [ OFF ]  [ PAPER ]  [ LIVE 🔒 ]                 → Performance  │
│ 🔒 live requires per-strategy execution mode (not yet built)   │
└────────────────────────────────────────────────────────────────┘
```

Per card: status · last successful scan · timeframes · next eligible evaluation · data-feed health · paper/live mode · open positions · performance link. Each card reads **only its own strategy's tables** — no shared component computes a combined number, which is how configuration silently leaks between strategies.

### D.3 OFF / PAPER / LIVE state machine

```
        ┌──────────────── OFF ────────────────┐
        │   runtime_scope = observation       │
        │   runtime_enforced = false          │
        └───────┬──────────────────▲──────────┘
       enable   │                  │  disable (always permitted,
       (reason) │                  │           no evidence needed)
        ┌───────▼──────────────────┴──────────┐
        │              PAPER                  │
        │   runtime_scope = paper             │
        │   authority_stage = soft_adjustment │
        │   writes: strategy-owned tables     │
        │   broker: never                     │
        └───────┬──────────────────▲──────────┘
      promote   │                  │  demote (always permitted)
      requires: │                  │
        · evidence_snapshot + hash │
        · forward window ≥ N       │
        · explicit reason + actor  │
        · per-strategy execution   │
          mode to EXIST            │
        ┌───────▼──────────────────┴──────────┐
        │         LIVE   🔒 for IPO           │
        │   runtime_scope = live | live_canary│
        │   runtime_enforced = true           │
        └─────────────────────────────────────┘
```

Every edge is a `transition_strategy_activation` call: reason required, actor recorded, revision checked, event appended. **Demotion is always allowed without evidence** — the safe direction should never be gated.

### D.4 Multi-strategy conflict matrix

| concern | SMC only | IPO only | both active |
|---|---|---|---|
| candle fetches | as today | +3 credits/run | +3 credits/run — **not the constraint** |
| edge CPU | as today | **exceeds 150 s budget (A.4)** | same, unresolved |
| `paper_positions` | SMC owns | IPO must not touch | **isolation must hold** |
| max positions | global cap | own cap | **C3 undecided** |
| portfolio heat | global | n/a | **C1 undecided** |
| prop-firm close-all | affects SMC | must not reach IPO | **C5 undecided** |
| same pair, both strategies | n/a | n/a | **C2 undecided** |
| opposite directions | n/a | n/a | **C4 undecided** |
| execution mode | account-level | paper only | **C6 — structurally impossible today** |
| UI | BotView | `/strategies` + own perf page | two cards, no shared totals |

---

## Revised phased plan — **NOT IMPLEMENTED**

**Phase 0 — table defects.** `FORCE ROW LEVEL SECURITY` + `REVOKE`/`GRANT` on `20260921120000`, matching `ipo_corpus_examples`. Migration unapplied, so this is an edit.

**Phase 1 — resolve the runtime ceiling.** *New, and now the critical path.* The 1,200-bar replay cannot complete inside an Edge Function. Decide between an incremental engine proven equivalent by the existing harness, or execution outside the Edge runtime. **Nothing downstream is reachable until this is settled.**

**Phase 2 — frontend read access.** SELECT-only policy on `ipo_paper_ledger`, or a read-through function.

**Phase 3 — paper environment.** Apply migration, deploy, invoke manually, audit rows against a local replay. Still blocked by the absence of a non-production project and by migrations/deploys being wired to merge-on-`main`.

**Phase 4 — control-plane convention.** Write down the `feature_key` / `variant_key` / `bot_id` naming for strategies **before** the first registry row exists.

**Phase 5 — `/strategies` page, read-only.** Cards, status, no mode buttons yet.

**Phase 6 — OFF/PAPER toggle** via `transition_strategy_activation`. LIVE stays locked.

**Phase 7 — scheduling.** Every 30 minutes, offset from the boundary. Not 5-minute polling.

**Phase 8 — forward evaluation** against spec §11 (+0.585R, 72.6%, PF 2.02, ~104 trades/month). No rule changes in response.

**Phase 9 — answer C1–C6 with forward evidence.** Per-strategy execution mode (C6) is a prerequisite for IPO live, not a setting.

**Phase 10 — canonical closed-bar store (option B)**, if and when both strategies benefit.

---

**Nothing in this addendum has been implemented. No code, schema, migration, function, cron, policy or frontend was changed.**
