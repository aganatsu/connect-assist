# Phase D Design — IPO Paper Trading Contract

**2026-09-21. DESIGN ONLY.** Nothing implemented. No migration applied, no
paper execution built, Journal untouched, daily/weekly advisor untouched, broker
untouched.

---

## 0. The contamination finding, stated exactly

Phase C flagged the risk; here is the measured form of it.

| consumer | query | scoping |
|---|---|---|
| `trades/index.ts` (Journal source) | `from("paper_trade_history").select("*").eq("user_id", …)` | **none at all** |
| `bot-weekly-advisor` | `.select("*").eq("user_id",…).gte("closed_at",…)` | **none on the trade query** (`bot_id` is used only for the *account* query) |
| `bot-daily-review` | same unscoped select, then a JS filter | **fail-open, and worse** |

`bot-daily-review:933`:

```js
if (t.bot_id) return t.bot_id === botId;
… if (reason?.bot === "fotsi_mr") return botId === "fotsi_mr";
    return botId === "smc";          // <-- a NULL bot_id row is ATTRIBUTED TO SMC
```

An unlabelled row is not merely included — it is **counted as an SMC trade** in
the daily review. So writing IPO results into `paper_trade_history` would not
just pool the data, it would silently inflate SMC's measured performance.

**Conclusion, adopted as a hard constraint:** `paper_positions`,
`pending_orders` and `paper_trade_history` are **SMC-owned legacy trading
state**. IPO never writes them, and isolation is achieved by IPO not entering —
not by teaching three existing consumers to exclude it.

---

## 1. IPO paper position model — proposed schema

Three tables, all `ipo_`-prefixed and service-role only. **Not applied.**

### 1.1 `ipo_paper_positions` — open state, one row per live paper position

| column | type | notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `strategy_id` | text NOT NULL | `'ipo_cet'`. **NOT NULL by design** — the SMC failure mode is a nullable owner |
| `strategy_version` | text NOT NULL | e.g. `'spec-1.1'`; pins which frozen rules produced it |
| `setup_id` | text NOT NULL | natural key of the IPO candidate (§9) |
| `intent_id` | text NOT NULL UNIQUE | natural key of the decision to enter (§9) |
| `user_id` | uuid NOT NULL | FK `auth.users` |
| `symbol` | text NOT NULL | |
| `timeframe` | text NOT NULL | |
| `direction` | text NOT NULL | CHECK `('long','short')` |
| `entry_time` | timestamptz NOT NULL | the CLOSED bar that filled |
| `entry_price` | double precision NOT NULL | the IPO-candle midpoint |
| `target_price` | double precision NOT NULL | entry ± 2 × risk |
| `s2_invalidation_level` | double precision NOT NULL | IPO candle far extreme |
| `nominal_risk_distance` | double precision NOT NULL | `abs(entry − s2)`; equals zone width |
| `requested_risk` | numeric NOT NULL | account currency per 1R |
| `cost_r` | double precision NOT NULL | round-trip cost in R, fixed at entry |
| `ipo_candle_time` | timestamptz NOT NULL | provenance |
| `volatility_bucket` | text NOT NULL | bucket at entry |
| `execution_mode` | text NOT NULL | CHECK `('paper')` — **Phase D cannot store `'live'`** |
| `status` | text NOT NULL | CHECK `('open')`; closing moves the row (§3) |
| `mae_r`, `mfe_r` | double precision | running excursion |
| `last_managed_bar_time` | timestamptz NOT NULL | the newest bar this position has been advanced through — the gap-recovery anchor |
| `created_at`, `updated_at` | timestamptz NOT NULL | |

Constraints: `UNIQUE (intent_id)`; `UNIQUE (strategy_id, symbol) WHERE status='open'`
— **one open position per instrument enforced in the database**, not only in code.

### 1.2 `ipo_paper_trade_history` — closed results

Same identity and plan columns, plus:

| column | type | notes |
|---|---|---|
| `exit_time` | timestamptz NOT NULL | |
| `exit_price` | double precision NOT NULL | |
| `exit_reason` | text NOT NULL | CHECK `('TARGET_2R','S2_CLOSE_INVALIDATION','FORCED_FLAT')` |
| `realized_r` | double precision NOT NULL | net of the frozen cost model |
| `gross_r` | double precision NOT NULL | before cost, so the cost is auditable |
| `mae_r`, `mfe_r` | double precision NOT NULL | |
| `bars_held` | integer NOT NULL | |
| `same_bar_ambiguous` | boolean NOT NULL | target and S2 on one bar (§3) |

Constraint: `UNIQUE (intent_id)` — a close can be retried and cannot duplicate.

### 1.3 `ipo_execution_events` — append-only audit

| column | type | notes |
|---|---|---|
| `id` | bigserial pk | |
| `event_id` | text NOT NULL UNIQUE | natural key (§9) |
| `strategy_id`, `strategy_version` | text NOT NULL | |
| `setup_id`, `intent_id` | text | intent nullable for setup-level events |
| `bar_time` | timestamptz NOT NULL | the CLOSED bar that produced it |
| `event_type` | text NOT NULL | `SETUP_VALID`, `INTENT_CREATED`, `FILLED`, `REFUSED`, `MANAGED`, `CLOSED`, `RECOVERED` |
| `strategy_decision` | text NOT NULL | §5 |
| `account_decision` | text | §5, nullable while unavailable |
| `reason_codes` | jsonb NOT NULL | |
| `payload` | jsonb NOT NULL | full snapshot for replay |
| `created_at` | timestamptz NOT NULL | |

This is what makes a forward test auditable bar by bar, and it is the reason a
refusal is as much a record as a fill.

---

## 2. Fill semantics — reuse, do not reinvent

**The frozen rule, quoted from `ipoIncrementalEngine.feed`:**

```js
const entry   = long ? hit.zoneLow : hit.zoneHigh;      // IPO-candle midpoint
const reached = long ? bar.low <= entry : bar.high >= entry;
```

So, precisely:

| question | answer |
|---|---|
| fill trigger | **candle range overlap of the midpoint level** — `bar.low <= entry` for a long, `bar.high >= entry` for a short |
| touch, cross, or close? | **neither touch-of-zone nor cross nor close.** The zone *touch* qualifies the candidate; the *fill* additionally requires the bar's range to reach the midpoint |
| fill price | exactly `entry` (the midpoint). No slippage in the base model |
| which bar | **only the bar on which `touchedThisBar` is true.** If the range does not reach the midpoint on that bar the setup is `REFUSED` with `PRICE_NOT_AT_ENTRY`; **it does not wait for a later bar** |
| candidate selection | first match in ascending `ipoIndex` — the earliest IPO wins a tie, and if *it* fails the fill test the whole bar is refused rather than falling through |
| sequencing | one open position per instrument; a new entry requires `barIndex > lastExitIndex` (strictly after, no same-bar re-entry) |

**No new signal logic.** The paper executor consumes `ENTERED` events from the
frozen engine and must not re-derive any of the above.

---

## 3. S2 position management — IPO semantics only

Explicitly **absent**: break-even, trailing, partial TP, wick-stop close,
structure invalidation, max-hold, prop-firm emergency close. None of
`scannerManagement`, `calculateSLTP`, `unifiedPositionSizing` or `propFirmGate`
may be called.

**Per closed bar, in this exact order** (matching `manageOpen`):

1. update `mae_r` / `mfe_r` from the bar's extremes
2. `closedBeyond = long ? close < s2 : close > s2` → **close at the bar CLOSE**,
   `exit_reason = S2_CLOSE_INVALIDATION`
3. else `hitTarget = long ? high >= target : low <= target` → close at the
   **exact target price**, `exit_reason = TARGET_2R`
4. else remain open; advance `last_managed_bar_time`

**Same-bar ambiguity: STOP FIRST.** The frozen engine tests `closedBeyond`
before `hitTarget`, so a bar doing both is a loss. The row records
`same_bar_ambiguous = true` so the optimistic reading remains recoverable
without changing the result.

**A wick through S2 does not close the position.** This is the defining property
of S2 and the reason IPO must never enter SMC's breach-close path, which closes
on a wick.

**Open-trade persistence.** State lives in `ipo_paper_positions`;
`last_managed_bar_time` is the resume anchor.

**Gap recovery.** On each run, replay every closed bar strictly after
`last_managed_bar_time` through step 1–4 in order. Bars are never skipped and
never re-applied, because the anchor advances only after a bar is processed. If
the gap exceeds available history, emit `RECOVERED` with the gap size and
**close the position `FORCED_FLAT`** rather than guessing what happened in the
dark — an unobserved S2 breach must not be silently ignored.

---

## 4. Paper execution architecture

```
closed bar
   │
   ▼
IncrementalEngine.feed()                    frozen, decides everything
   │  events: ENTERED · EXITED · REFUSED · NO_CANDIDATE
   ▼
ipoTradeIntent            normalise -> { setup_id, intent_id, plan, decisions }
   │
   ├─► ipo_execution_events         every event, including refusals
   │
   ▼
ipoPaperExecutor          intent -> ipo_paper_positions   (INSERT, idempotent)
   │
   ▼
ipoPaperManager           per closed bar -> §3 -> ipo_paper_trade_history
   │
   ▼
ipoPaperReadApi           edge function, read-only, for the UI
```

**No SMC execution helper is reused.** Shared code is limited to stateless
utilities that carry no SMC behaviour: `candleSource`, `candleCache`,
`apiCreditBudget`, `SPECS`, `cors`, logging. A guard test extends the existing
shadow-isolation list to assert the IPO executor imports none of
`scannerManagement`, `propFirmGate`, `unifiedPositionSizing`, `calculateSLTP`,
`zoneConfirmation` or `broker-execute`.

---

## 5. Correlation / account safety — two results, neither erased

Every decision is recorded twice, and **the strategy result is never overwritten
by the account result**.

```
strategy_decision  ∈ { WOULD_ENTER, WOULD_NOT_ENTER, WOULD_EXIT, HOLD }
account_decision   ∈ { ALLOW, BLOCK_CORRELATION, BLOCK_MAX_POSITIONS,
                       BLOCK_PORTFOLIO_HEAT, BLOCK_PROP_FIRM, UNAVAILABLE }
```

Rendered as the brief describes:

```
IPO VALID
  PAPER STRATEGY : WOULD ENTER
  ACCOUNT SAFETY : WOULD BLOCK — CORRELATION
```

**Phase D default: `account_decision = UNAVAILABLE`, and the paper position is
taken on the strategy result alone.** Three reasons, all from evidence already
gathered rather than preference:

1. Computing it requires `openPositions` from `paper_positions`, which IPO must
   not read.
2. Correlation is **advisory** in the live system today — `approved`,
   `blockThreshold` and `maxCurrencyExposure` are dead code. There is no
   enforced decision to mirror.
3. All three UI correlation settings are currently **inert** (mapper reads
   `strategy.*`, UI writes `instruments.*`), so any figure shown would not
   reflect what SMC actually does.

Wiring a real `account_decision` needs a strategy-aware portfolio view that can
see both books. That is its own piece of work and is **not** Phase D.

Recording the field now — nullable, populated later — means the forward record
can answer "how often would account safety have blocked us" retrospectively,
without re-running anything.

---

## 6. Journal integration — a read layer, never a pooled table

**Do not modify the Journal in Phase D.** Design only:

```
ipo-paper-read        (new, read-only)      -> ipo_paper_trade_history
trades                (existing, untouched) -> paper_trade_history
        │
        ▼
strategy-aware read layer (future)
   returns rows tagged { strategy, strategy_version, mode: paper|live, source }
```

Rules:

- **Never `UNION` the raw tables.** A union re-creates the pooling this whole
  design exists to prevent, one level up.
- Every returned row carries `strategy` and `mode` explicitly; no row is
  untagged, and there is no "default" strategy.
- The default Journal view stays **SMC-only** so existing P&L is unchanged by
  the mere existence of IPO data. IPO is opt-in via an explicit filter.
- Aggregates (win rate, P&L, expectancy) are computed **per strategy** and never
  summed across `mode` boundaries without an explicit request.

---

## 7. Daily / weekly advisor isolation

**Confirmed isolated, structurally.**

`bot-daily-review` and `bot-weekly-advisor` both read `paper_trade_history`.
IPO writes `ipo_paper_trade_history`. There is no view, trigger, FK or union
between them, so IPO results are **invisible** to both by construction — not by
a filter that could be forgotten.

This is precisely why the isolated-table choice is worth its cost: had IPO
written to `paper_trade_history`, `bot-daily-review` would have **attributed
every NULL-`bot_id` IPO row to SMC** (§0).

Visibility can only be added deliberately, by the future strategy-aware
analytics layer explicitly querying the IPO table.

---

## 8. RLS / security

All three IPO tables adopt the `ipo_corpus_examples` posture, which is the
hardening that was staged in `docs/patches/ipo_paper_ledger_rls.patch`
(RETIRED at D.2 — the patch did not apply and the table it hardened was
removed; the posture below is what the Phase D migration ships):

```sql
alter table public.<t> enable row level security;
alter table public.<t> force row level security;   -- owner does NOT bypass
revoke all on public.<t> from anon, authenticated; -- unreachable, not merely empty
grant  all on public.<t> to service_role;
```

Zero `anon`/`authenticated` policies. **Browser access is via edge function
only** — matching the house pattern established in the Phase A audit, where the
frontend reaches data through `src/lib/api.ts` and edge functions rather than
direct table reads.

The prepared ledger patch should be applied in the same migration batch so the
existing `ipo_paper_ledger` does not remain the one weakly-secured IPO table.

**UPDATE, D.2:** resolved by removing that table rather than hardening it. It
was superseded by the three tables above, had never been applied or deployed,
and `supabase db push` would have created it alongside them.

---

## 9. Idempotency — natural keys

Retrying a closed bar must be a no-op. Every write is keyed on content, not on
time of execution.

| entity | natural key | uniqueness |
|---|---|---|
| setup | `sha1(strategy_id, symbol, timeframe, ipo_candle_time, direction)` | logical |
| intent | `sha1(setup_id, entry_bar_time)` | `UNIQUE (intent_id)` on positions |
| paper fill | `intent_id` | `UNIQUE (intent_id)`; insert is `ON CONFLICT DO NOTHING` |
| close event | `intent_id` | `UNIQUE (intent_id)` on history; `ON CONFLICT DO NOTHING` |
| audit event | `sha1(event_type, intent_id ?? setup_id, bar_time)` | `UNIQUE (event_id)` |

Plus the structural guard `UNIQUE (strategy_id, symbol) WHERE status='open'`, so
a double-fill is refused by the database even if application logic fails.

**Manager idempotency** comes from `last_managed_bar_time`: a bar at or before
the anchor is skipped, so re-running a range cannot double-count excursion or
close a position twice.

---

## 10. Read/write matrix and isolation proof

| table | IPO reads | IPO writes | SMC reads | SMC writes |
|---|---|---|---|---|
| `ipo_paper_positions` | yes | yes | **no** | **no** |
| `ipo_paper_trade_history` | yes | yes | **no** | **no** |
| `ipo_execution_events` | yes | yes | **no** | **no** |
| ~~`ipo_paper_ledger` (Phase C)~~ | — | — | — | — | *retired at D.2, never applied* |
| `kv_cache` | yes (namespaced) | yes (namespaced) | yes | yes |
| `paper_positions` | **no** | **no** | yes | yes |
| `pending_orders` | **no** | **no** | yes | yes |
| `paper_trade_history` | **no** | **no** | yes | yes |
| `paper_accounts` | **no** | **no** | yes | yes |
| `bot_configs` | **no** | **no** | yes | yes |
| `broker_connections` | **no** | **no** | yes | yes |

**Isolation proof obligations**, each a test:

1. no IPO module imports `scannerManagement`, `propFirmGate`,
   `unifiedPositionSizing`, `calculateSLTP`, `zoneConfirmation`
2. no IPO module contains the string `broker-execute` in code
3. IPO `.from(...)` call sites resolve to `ipo_*` and `kv_cache` only
4. `execution_mode` CHECK permits only `'paper'` in Phase D
5. the shadow-isolation guard list covers every new module
6. SMC files byte-identical to `origin/main`

## 11. Test plan

| # | test | asserts |
|---|---|---|
| T1 | executor equivalence | positions/history reproduce `IncrementalEngine` events exactly on all 15 windows |
| T2 | fill semantics | fills only when the bar range reaches the midpoint, only on the touch bar, at exactly the midpoint |
| T3 | tie-break | earliest `ipoIndex` wins; if it fails the fill test the bar is refused, no fall-through |
| T4 | no same-bar re-entry | entry requires `bar > lastExitIndex` |
| T5 | S2 wick | a wick beyond S2 does **not** close; only a close does |
| T6 | same-bar ambiguity | target + S2 on one bar → LOSS, `same_bar_ambiguous = true` |
| T7 | no SMC management | no break-even, trail, partial or wick-stop ever mutates an IPO position |
| T8 | idempotent replay | re-running an identical bar range produces zero new rows |
| T9 | gap recovery | bars after the anchor are replayed in order; an over-long gap yields `FORCED_FLAT` |
| T10 | dual decision | `strategy_decision` is never overwritten by `account_decision` |
| T11 | advisor isolation | daily review and weekly advisor output is bit-identical with and without IPO rows present |
| T12 | Journal isolation | the default Journal response is unchanged by IPO rows |
| T13 | RLS | `anon` and `authenticated` cannot select; service role can |
| T14 | schema guards | `strategy_id` NOT NULL; `execution_mode` CHECK rejects `'live'`; partial unique index blocks a second open position |
| T15 | SMC regression | full Deno + vitest suites green; SMC files unchanged vs main |

T11 is the one that would have caught the §0 defect, and it should be written
before any IPO row is ever inserted.

---

## Open decisions for sign-off before Phase D implementation

1. **Position sizing** — still undecided. 97.2% of losing trades exceed nominal
   1R (median 1.75R, worst 17.3R). `requested_risk` is in the schema; the value
   is not chosen.
2. **Cost-dominated setups** — `costR > 2` cannot profit even on a perfect win
   (3.7% of a fresh sample). Admit and record, or refuse? Refusing is a new
   rule and needs its own pre-registered test.
3. **Bootstrap placement** — a 1,200-bar bootstrap is ~30s and a 2,927-bar one
   is 184s, over the Edge limit. Paper running on a schedule needs either
   persisted engine state or an out-of-request worker.
4. **`FORCED_FLAT` policy** — confirm that closing on an unrecoverable gap is
   preferred to leaving a position open through unobserved bars.

---

**DESIGN ONLY. No migration applied, no paper execution implemented, Journal
untouched, advisors untouched, broker untouched. Stop after this report.**
