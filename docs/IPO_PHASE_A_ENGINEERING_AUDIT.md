# Phase A — Engineering Audit

**2026-09-21. Read-only.** No implementation, migration, deployment, cron,
broker change or merge. Audits the repo against
`docs/IPO_MULTI_STRATEGY_INTEGRATION_DESIGN_SYSTEM.md` (commit `a6c49685`),
treated as a proposal rather than as fact.

> **Note on branch state.** The design document arrived on
> `origin/feature/ipo-live-integration` while the local branch was 1 behind. It
> was read from the remote ref without merging, so the uncommitted research from
> earlier phases is untouched. **The local branch is still 1 behind origin.**

---

## 1. Current System Map

```
pg_cron ─┬─ bot-scanner            scan   */5 * * * *
         ├─ bot-scanner            manage *   * * * *
         ├─ zone-confirmation-scanner      *   * * * *
         ├─ scanner-operational-health     *   * * * *
         ├─ outcome-tracker              15   * * * *
         ├─ kv-cache-cleanup             15   * * * *
         ├─ data-cleanup                  0 3 * * *
         ├─ prop-firm-daily-reset  0 22 (summer) / 0 23 (winter)
         ├─ bot-daily-review              0 22 * * *
         └─ bot-weekly-advisor            0 23 * * 0

bot-scanner/index.ts  (8,584 lines — the entire SMC pipeline in one function)
  CONFIG   bot_configs -> mapNestedToFlat / applyPairOverrides  (~120 settings)
  POSITIONS paper_positions WHERE user_id, status=open   :2468
           filter  !p.bot_id || p.bot_id === "smc"        :2471   <-- fail-open on NULL
  MANAGE   scannerManagement.manageOpenPositions          :2516
           be_enabled | trailing_enabled | partial_enabled | sl_tightened
           -> broker-execute modify/close when execution_mode === "live"
  BREACH   SL/TP crossed -> close + paper_trade_history   :2928
  PENDING  pending_orders fill / expire / invalidate      :3323
           thesisValidator :3494 · zoneConfirmation :3784
           FILL -> paper_positions.insert :3933 -> broker-execute :4048
  GATE 0   propFirmGate -> emergency close-all            :4162 / :4205
  PER PAIR HTF POI -> fib/PD/liquidity -> directionEngine -> directionVerdict :5992
           -> unifiedZoneEngine :6067 (primary) -> impulseZoneEngine gate :6091
           -> cascadeZoneEngine :5622 (swing only) -> structuralOrderBlockRunner :5351 (SHADOW)
           -> confluenceScoring -> ICT gates -> conflict counter -> game plan
           -> staged_setups :6135 -> checkPortfolioConflict :7135 (ADVISORY)
           -> calculateSLTP -> unifiedPositionSizing :7172
           LIMIT  -> pending_orders.insert  :7512
           MARKET -> paper_positions.insert :7775 -> broker-execute :7899
           else   -> logRejectedSetup :8192 ; scan_logs.insert

zone-confirmation-scanner  pending_orders awaiting_confirmation -> CHoCH
                           -> paper_positions.insert -> broker-execute :625
frontend  React/Vite -> src/lib/api.ts -> EDGE FUNCTIONS (not tables, mostly)
```

## 2. Data Ownership Map

| domain | owner today | notes |
|---|---|---|
| `paper_accounts` (incl. `execution_mode`) | SMC + prop-firm | account-level, **not per strategy** |
| `paper_positions` | SMC | 4 writers; `bot_id` is the only scoping, fail-open on NULL |
| `pending_orders` | SMC | 20 write sites across 2 functions |
| `paper_trade_history` | SMC + propFirmGate | |
| `staged_setups` | SMC | |
| `bot_configs` | SMC | ~120 settings, single blob per user/connection |
| `broker_connections` | platform | read only by `broker-execute` |
| `prop_firm_config` / `_daily_state` / `_events` | platform | |
| `strategy_activation_registry` / `_events` | **unowned — no reader or writer exists** | |
| `rejected_setups`, `scan_logs`, `trade_reasonings` | SMC telemetry | |
| `kv_cache`, `api_credit_usage` | platform infra | |
| `ipo_corpus_examples` | IPO research | service-role only |
| `ipo_paper_ledger` | IPO (proposed) | **migration unapplied** |
| `broker_execution_ledger`, `setup_lifecycle_events` | **dormant** | in baseline schema, referenced by no function |

## 3. Table Read/Write Matrix

| table | INSERT | UPDATE | DELETE | READ |
|---|---|---|---|---|
| paper_positions | bot-scanner ×2, zone-conf ×1, paper-trading ×1 | paper-trading ×8, **scannerManagement ×7**, bot-scanner ×3, zone-conf ×1 | paper-trading ×4, bot-scanner ×2, propFirmGate ×1 | bot-scanner, paper-trading, zone-conf |
| paper_trade_history | paper-trading ×4, bot-scanner ×2, **propFirmGate ×1** | — | paper-trading, data-cleanup | trades, reviews, advisor |
| pending_orders | bot-scanner ×1 | bot-scanner ×14, zone-conf ×6 | — | bot-scanner, zone-conf |
| staged_setups | bot-scanner ×2 | bot-scanner ×7 | — | bot-scanner |
| paper_accounts | paper-trading ×2 | paper-trading ×14, bot-scanner ×8, propFirmGate ×1 | — | prop-firm, reviews, zone-conf |
| trades | trades ×2 (manual journal) | trades ×1 | trades, paper-trading | trades |
| rejected_setups | bot-scanner ×2, rejectedSetupLogger ×1 | outcome-tracker ×1 | outcome-tracker | advisor, reviews, UI |
| scan_logs | bot-scanner ×3 | — | paper-trading, data-cleanup | scheduled-tasks, UI |
| strategy_activation_* | **none** | **none** | **none** | **none** |

## 4. Broker Call Graph

```
broker-execute/index.ts
  credentials: broker_connections (ONLY table it touches)
  routing:     conn.broker_type === "metaapi" | "oanda"
  actions:     account_summary · open_trades · place_order · account_balance
               symbol_specs · validate_symbol · connection_status
               close_trade · trade_history · modify_trade

callers (7 sites, all gated on paper_accounts.execution_mode === "live"):
  bot-scanner :2553  open_trades      (pre-modify lookup, MANAGEMENT)
  bot-scanner :2571  modify_trade     (SL move — break-even / trailing)
  bot-scanner :2698  open_trades      (pre-partial lookup, MANAGEMENT)
  bot-scanner :2719  close_trade      (partial close)
  bot-scanner :4048  place_order      (pending-order fill)
  bot-scanner :7899  place_order      (market entry)
  zone-confirmation-scanner :625      (confirmation fill)
  frontend  src/lib/api.ts ×8         (read-only UI: status, history, specs)
```

**The critical structural fact: four of the seven server-side call sites are in
the MANAGEMENT loop, not the entry path.** A position merely *existing* in
`paper_positions` is sufficient to generate live broker orders.

## 5. Correlation Enforcement Map

| mechanism | status | evidence |
|---|---|---|
| `checkPortfolioConflict(...).approved` | **NEVER READ** | no `.approved` reference at any call site |
| concentration score | **ADVISORY — sizing only** | `:7143` scales size, floor 0.5; log says "Portfolio correlation advisory" |
| `blockThreshold: 0.7` | **DEAD CONFIG** | defined in `DEFAULT_PORTFOLIO_CONFIG`, never consulted |
| `maxCurrencyExposure: 2.0` | **DEAD CONFIG** | computed, never enforced |
| static correlation matrix | computed | feeds concentration only |
| dynamic Pearson | computed | feeds concentration only |
| directional correlation | computed | feeds concentration only |
| Gate 22 `correlationFilterEnabled` | **separate mechanism, can block** | `:1887`, `maxCorrelatedPositions` |

**Answering §12 directly: almost nothing is enforced.** The only hard correlation
block is Gate 22, and it is a different code path from `portfolioCorrelation.ts`.

> **Discrepancy found — conflicting defaults for Gate 22.**
> `bot-scanner:1281` resolves `correlationFilterEnabled ?? false`.
> `configMapper.ts:332` sets `RUNTIME_DEFAULTS.correlationFilterEnabled = true`.
> `BotConfigModal.tsx:255` also defaults it true.
> Whether the only enforced correlation control is on or off by default depends
> on which mapping wins at runtime. **Unresolved statically — must be confirmed
> against the live `bot_configs` row before anything depends on it.**

## 6. Prop-Firm Enforcement Map

```
runPropFirmGate(...)                     bot-scanner :4194   (Gate 0, pre-scan)
  reads   prop_firm_config · prop_firm_daily_state · paper_accounts · broker_connections
  writes  prop_firm_events · prop_firm_daily_state
  outputs enabled · maxPositionSizeMultiplier · shouldCloseAll · reason

ENFORCED:
  propFirmSizeMultiplier   :4200   scales every position size
  shouldCloseAll           :4203   -> propFirmEmergencyClose(openPosArr)
                                      deletes paper_positions, writes
                                      paper_trade_history close_reason=prop_firm_emergency
  weekend guard                     crypto-only when FX closed
  equity source                     broker equity when live; skips on unavailable
                                      rather than firing a false emergency
prop-firm-daily-reset  0 22 / 0 23 — two crons for summer/winter
```

**Prop-firm operates on `openPosArr`** — the `bot_id`-filtered array. An IPO row
with `bot_id = "ipo"` is excluded; one with `bot_id = NULL` is not.

## 7. Scheduler Map

| job | cron | writes |
|---|---|---|
| bot-scanner scan | `*/5 * * * *` | positions, pending, staged, scan_logs, rejected, reasonings |
| bot-scanner manage | `* * * * *` | positions, history, accounts |
| zone-confirmation-scanner | `* * * * *` | positions, pending, reasonings |
| scanner-operational-health | `* * * * *` | health RPC |
| outcome-tracker | `15 * * * *` | rejected_setups grading |
| kv-cache-cleanup | `15 * * * *` | kv_cache |
| data-cleanup | `0 3 * * *` | history pruning |
| prop-firm-daily-reset | `0 22` + `0 23` | prop_firm_daily_state |
| bot-daily-review | `0 22 * * *` | analytics |
| bot-weekly-advisor | `0 23 * * 0` | analytics |

Three jobs fire every minute. Market-data credits are reserved through a
Postgres RPC (`reserve_api_credit`, limit 50/60s) that **fails open**.

## 8. UI Impact Map

**The frontend is edge-function-mediated, not direct-table.** `src/lib/api.ts`
is the single data layer:

| edge function | call sites in api.ts |
|---|---|
| paper-trading | 12 |
| trades | 8 |
| broker-execute | 8 (read-only) |
| broker-connections | 8 |
| prop-firm | 6 |
| smc-analysis | 4 |
| bot-config | 4 |
| fundamentals | 3 |
| user-settings / market-data / bot-scanner | 2 each |

Only two direct table reads exist in `api.ts` (`staged_setups`, `scan_logs`),
plus `RejectedSetups.tsx` reading `rejected_setups` directly.

| page | data source | IPO impact |
|---|---|---|
| BotView | `useEngine` + react-query via api.ts | nav entry only; do not add an IPO tab |
| Settings | bot-config fn | **must not gain IPO settings** (§8 drift risk) |
| Journal | trades fn | would pool IPO trades if IPO wrote `trades` |
| Chart | smc-analysis fn | unaffected |
| Dashboard (Index) | react-query | nav entry only |
| Backtest | backtest-engine | unaffected |
| RejectedSetups | direct `rejected_setups` | unaffected |
| Brokers | broker-connections fn | unaffected |

**This resolves an open question from the previous audit.** The house pattern is
a read-only edge function, not a direct table read. An IPO read endpoint
therefore fits the existing architecture better than adding a SELECT policy to
`ipo_paper_ledger`, and keeps the table service-role only.

## 9. RLS / Security

| table | RLS | policies |
|---|---|---|
| paper_* / pending_orders / staged_setups / trades / scan_logs / bot_configs | on | 1–4, user-scoped |
| `strategy_activation_registry` / `_events` | on | **SELECT only** — writes only via `transition_strategy_activation` (SECURITY DEFINER, requires a reason, optimistic `p_expected_revision`) |
| `ipo_corpus_examples` | on + **FORCE**, grants revoked | 0 — service role only |
| **`ipo_paper_ledger`** | on, **no FORCE, no REVOKE/GRANT** | 0 — **defect, migration unapplied** |
| `kv_cache` | on | 0 |

---

## 10. Discrepancies between the design and the repo

| # | design says | repo actually | severity |
|---|---|---|---|
| D1 | §12 "audit which correlation controls are enforced" | **`approved`, `blockThreshold` and `maxCurrencyExposure` are all dead.** Only Gate 22 blocks, via a different module | **high** — the design assumes a correlation layer exists to extend |
| D2 | §12 correlation sits "after signal, before execution" | it sits before sizing and only *scales* size | medium |
| D3 | §6 control plane via strategy modes | `strategy_activation_registry` exists, is well-governed, and **has zero readers/writers** — it is unused scaffolding, not a live control plane | medium |
| D4 | §9 "treat current SMC state as SMC-owned" | agreed, but the enforcing mechanism is one fail-open filter `!p.bot_id \|\| p.bot_id === "smc"` | **high** |
| D5 | §4 lists `broker-execute call sites` | 4 of 7 server-side sites are in the **management loop**, not entry. The design's mental model of "execution path" understates this | **high** |
| D6 | §13 prop-firm layer | already enforced and pre-emptive (Gate 0, close-all). Not a layer to be added — a layer to be *excluded from* | medium |
| D7 | §24 security | `ipo_paper_ledger` lacks FORCE RLS and grant revocation that `ipo_corpus_examples` has | medium |
| D8 | §21 scheduled tasks | design does not account for three jobs already at `* * * * *` and a **fail-open** credit limiter already at quota | medium |
| D9 | §18–20 UI | design implies page-level data access; the repo is **edge-function-mediated** through `api.ts` | low — but it changes the IPO UI plan |
| D10 | §7.2 incremental engine | the existing `ipoLiveEngine` is O(n²) by design and **exceeds the 150s Edge limit**; the design treats the incremental engine as an optimisation, when it is a hard prerequisite | **high** |
| D11 | §9 proposes 8 IPO tables | `ipo_paper_ledger` already exists and covers observation + paper. 8 tables precede the engine requirement the design itself says should come first | low |

## 11. Feature-drift and SMC-regression risks

| risk | mechanism | mitigation |
|---|---|---|
| **R1 — NULL `bot_id` adoption** | any IPO insert into `paper_positions` missing `bot_id` is managed, stop-moved and possibly sent to a broker | IPO must not write that table at all |
| **R2 — management reaches the broker** | `scannerManagement` calls `broker-execute` on live accounts | keep IPO out of `openPosArr` entirely |
| **R3 — config bleed** | adding IPO keys to `bot_configs` puts them behind the same mapper that already has a conflicting default (D1) | IPO config stays in versioned code |
| **R4 — `execution_mode` is account-level** | no way to run SMC live and IPO paper on one account | prerequisite for any IPO live mode |
| **R5 — Settings page growth** | a shared settings page invites shared settings | no IPO controls in Settings |
| **R6 — analytics pooling** | Journal/reviews read `paper_trade_history` unscoped | IPO history stays separate |
| **R7 — credit exhaustion** | limiter fails open at an already-saturated quota | reuse cache; do not add a fast cron |
| **R8 — touching bot-scanner** | any edit to an 8,584-line live function risks SMC regression | **do not modify bot-scanner in any IPO phase** |

## 12. Lowest-risk implementation architecture

**Strict parallelism. Isolation by non-participation, not by filtering.**

```
SHARED (stateless, safe)        ISOLATED (stateful, must not be shared)
────────────────────────        ──────────────────────────────────────
candleSource + candleCache      ipo_paper_ledger        (own tables)
apiCreditBudget                 versioned IPO spec      (own config)
SPECS / pip sizes               IPO engine state        (own lifecycle)
cors / telegram / logging       one-per-instrument      (own concurrency)
AppShell / UI kit / auth        S2 invalidation         (own risk model)
broker_connections (read)       NO broker path at all
```

Five rules that make the isolation structural rather than procedural:

1. IPO writes **only** `ipo_*` tables. Never `paper_positions`,
   `pending_orders`, `paper_trade_history`, `paper_accounts`.
2. IPO reads **no** `bot_configs`.
3. IPO never calls `broker-execute`, `unifiedPositionSizing` or `propFirmGate`.
4. **`bot-scanner` is not modified in any IPO phase.** Isolation is achieved by
   IPO not entering, not by SMC learning to exclude it.
5. IPO UI data comes from a **read-only edge function**, matching the house
   pattern, leaving `ipo_paper_ledger` service-role only.

The existing shadow-isolation guard test already enforces (1)–(4) at the import
level for 27 modules and should be extended, not replaced.

## 13. Proposed Phase B file/table changes — **NOT IMPLEMENTED**

Phase B is the incremental engine plus oracle equivalence. It needs **no schema
change and no new table**.

| file | change | why |
|---|---|---|
| `_shared/ipoIncrementalEngine.ts` | **new** | O(1)-per-bar engine with persistable state. D10 makes this a prerequisite, not an optimisation |
| `_shared/ipoLiveEngine.ts` | **unchanged** | becomes the reference oracle (§7.1). Its value is that it re-runs the frozen rules and cannot drift |
| `tests/_shared/ipoIncrementalEngine.test.ts` | **new** | bar-for-bar equivalence against the oracle on every validation window; any divergence fails |
| `tests/_shared/ipoZones.test.ts` | +1 line | register the new module in the shadow guard |
| migrations | **none** | state stays in memory during Phase B; persistence is Phase C |
| edge functions | **none** | nothing deployed, nothing scheduled |
| frontend | **none** | |

Phase B exit criterion, stated before it starts: **the incremental engine must
reproduce the oracle's trade set exactly — same entries, same exits, same R to
1e-9 — on all 15 validation windows, and complete a 1,200-bar instrument inside
the 150s Edge budget.** Anything less is not a pass.

### Recommended ordering change

The design runs Phase C (observation) before Phase D (paper). Two items should
be pulled earlier because they block everything and are cheap:

- **fix `ipo_paper_ledger` RLS** (FORCE + REVOKE/GRANT) while the migration is
  still unapplied — an edit, not a schema change
- **resolve D1** by reading the live `bot_configs` row to determine whether
  Gate 22 is actually on, before any design depends on correlation behaviour

---

**Phase A only. Nothing implemented, migrated, deployed, scheduled or merged.**
