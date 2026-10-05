# FTMO readiness — V1

Status: **NOT READY. Do not connect an FTMO account.** Nothing here connects
to, or trades, any broker.

Date: 2026-10-05. Inputs: the settlement-ledger work (`PAPER_SETTLEMENT_LEDGER_V1.md`),
the reset proposal (`SMC_RESET_SCOPE_PROPOSAL_V1.md`), the attribution design
(`SMC_ATTRIBUTION_AND_CONFIG_VERSIONING_V1.md`), the engine inventory and
per-engine performance reports (`docs/SMC_ENGINE_INVENTORY_V1.md`,
`docs/SMC_ENGINE_PERFORMANCE_V1.md` in the research checkout), live config
from the 2026-10-05 snapshot, and `_shared/propFirmRisk.ts` / `propFirmGate.ts`.

## 1. Gate checklist (all must be green before any FTMO connection)

| # | Requirement | State | What closes it |
|---|---|---|---|
| 1 | Correct accounting | **Built, not deployed.** Ledger + atomic settlement + guard, 20 real-Postgres tests, full suite green | merge; 24h observe with zero unledgered writes; switch guard to `enforce` |
| 2 | Duplicate settlement impossible | **Built, not deployed.** Unique settlement key; every close path rewired; source tests forbid direct writes | as 1 |
| 3 | Clean reset | **Proposed, awaiting approval** (decision D1: open CHF/JPY) | approve → execute → verification table in the proposal |
| 4 | Working attribution | **Not built.** 9–11 of 34 period trades carry engine/route; 0 carry a config version; 10 configs mixed in one period | implement the attribution design (next PR) |
| 5 | Engines independently measurable | **No.** Impulse cannot initiate on its own; "engine" P/L today is attribution by evidence, not by recorded initiator | 4, then a clean forward sample per (engine, config_version) |
| 6 | Risk controls verified | **Partially.** Gaps in §3 | §3 items |
| 7 | Evidence of edge | **Not established.** Historical replay: SMC concepts net-negative (`SMC_EDGE_DIAGNOSIS_V1`). Demo: +$5,008 real over 34 trades, but excluding the top 5 winners it is −$744 net; expectancy CI spans zero | a forward sample under ONE frozen config, large enough that the expectancy CI excludes zero after costs |
| 8 | Costs modelled | **No.** Spread, commission and swap are not recorded on paper trades | record per-trade cost (or a broker-specific cost model) before comparing paper to a prop account |
| 9 | Broker reconciliation | **No.** Paper is the system of record; broker mirroring is fire-and-forget (`broker_execution_ledger` has 4 rows) | a broker↔ledger reconciliation job with alerting, tested on a demo MT5 account |

## 2. FTMO rules the system must enforce

These are the rules **as encoded in `propFirmRisk.ts` `FTMO_2STEP_DEFAULTS`**
and the inactive `prop_firm_config` row (firm `ftmo_2step`, stage `challenge`,
initial 100,000). FTMO changes its rules; **re-confirm every row against
FTMO's current published Trading Objectives before connecting.**

| Rule | Encoded value | Enforced by | Gap |
|---|---|---|---|
| Max daily loss | 5% of **initial** balance, measured as start-of-day balance − **equity** (floating included); day = 00:00 CE(S)T | `checkDailyLoss` (equity-based, DST-aware reset via `getResetHourUTC`) | prop-firm gate is `is_active = false`. The always-on Gate 7 uses **realized balance only** and resets at **UTC** midnight. Floating losses do not count, and the day boundary is 1–2h off FTMO's |
| Max overall loss | 10% of initial (static for 2-Step; trailing for 1-Step) | `checkMaxDrawdown` | bot's own `maxDrawdown 10` trails from `peak_balance`, which included the 871.19 phantom until the reset |
| Profit target | 10% challenge / 5% verification / none funded | `calculateProfitTarget` | informational only |
| Emergency flatten | at 96% of the daily limit (`emergency_close_pct 0.002` of 5%) | `propFirmEmergencyClose` | P&L was a flat `×100,000` (wrong for JPY/metals/crypto) and credited skipped positions. **Fixed in the settlement PR** (instrument-aware `pnlFor`, per-position settlement) |
| Safety buffer / size reduction | soft-lock at 0.8% before the limit; size cut from 60% of limit used | `checkDailyLoss` | as above: inactive |
| Weekend | FX skipped when the market is closed | `fxMarketClosed` guard | whether positions may be **held** over the weekend depends on the FTMO account type — confirm and add a pre-close rule if required |
| News | — | news filter gate (`config.newsFilterEnabled`) | confirm FTMO's restriction for the chosen account type; the gate's data source must be verified live |
| Minimum trading days, inactivity | — | not encoded | add as monitoring, not as a trading rule |

## 3. Risk-control gaps found during this work

1. **ICT risk management reads a table that does not exist.** It queries `trade_history`, which is absent from production (verified in the PostgREST schema). Its consecutive-loss, daily and weekly limits have always seen zero trades. The per-file evidence is in the engine inventory.
2. **Gate 7 / Gate 15 measure realized P&L only.** An FTMO daily-loss breach is driven by equity. Until the prop-firm gate is active with **broker** equity, open losers are invisible to the daily limit.
3. **Two day boundaries.** Gate 7 rolls at UTC midnight (`paper-trading` H17); FTMO rolls at CE(S)T midnight. One limit must own the day, and it must be FTMO's.
4. **Conflicting limits in config.** `risk.maxConcurrentTrades 7` vs `risk.maxOpenPositions 3`; `risk.maxDailyLoss 3`% vs `protection.maxDailyLoss $3,000`; `instruments.enabled` lists BTC/ETH while `allowedInstruments` marks them false. Before FTMO, each limit needs exactly one owner and a test proving it binds.
5. **Worst-case daily loss is not bounded by construction.**
   - 3 open × 1% risk = 3% planned, below 5%.
   - But stop slippage, gaps and correlated stops are not modelled.
   - The ATR SL floor can widen stops, and sizing must use the widened stop.
   - Needed: a test that the sized risk at the floor-adjusted stop never exceeds `riskPerTrade`.
6. **History-derived gates after reset.** Cooldown, loss streak and daily-$ loss now read only post-reset trades (settlement PR). Without that, a reset account inherited old streaks.

## 4. Account / risk rules to enforce on an FTMO account (proposal)

To be confirmed by you. Each is a hard rule with a test, owned by one gate:

| Rule | Value (proposal) | Owner |
|---|---|---|
| Daily loss stop (equity, CE(S)T day) | stop new entries at 3.0% of initial; flatten at 4.0% | prop-firm gate, active, broker equity |
| Overall loss stop | flatten and halt at 8% of initial (2% buffer to FTMO's 10%) | prop-firm gate |
| Risk per trade | ≤ 0.5% of initial at the floor-adjusted stop | sizing, with test |
| Concurrent risk | ≤ 1.5% of initial across open positions | portfolio heat gate (single owner) |
| Instruments | FX majors/crosses only (Era E), mapped to FTMO symbol names | instrument filter, single list |
| Config | frozen; one `config_version` for the whole evaluation | attribution PR |
| Kill switch | settles every position through the ledger and mirrors to the broker, with reconciliation | kill switch + reconciliation job |

## 5. Order of work

1. Merge and verify the settlement ledger → `enforce`.
2. Approve and run the clean reset.
3. Attribution + config versioning PR.
4. Fix or remove the dead ICT risk table read, unify the day boundary, and give each limit a single owner, each with a test. (These change which trades happen, so they need your explicit approval; they are not part of this no-strategy-change work.)
5. Forward paper sample under one frozen config; costs recorded.
6. Demo MT5 account (not FTMO) with broker reconciliation.
7. Only then: this checklist re-run → FTMO decision.
