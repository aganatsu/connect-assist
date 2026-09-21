# Phase C Report — IPO Observation Mode

**2026-09-21. Read-only observation.** No schema change, no migration, no
deployment, no cron, no broker path, no SMC behaviour change.

Engine: `ipoIncrementalEngine.ts`. `ipoLiveEngine.ts` is unchanged and remains
the reference oracle.

---

## 1. Research-only lifecycle concepts are displayed as NOT TRACKED

The trader vocabulary has ten states. The **frozen** `ipoLifecycle` implements
only the four that change a decision:

| concept | frozen lifecycle | displayed as |
|---|---|---|
| suppression by an active contraction | computed | `YES` / `NO` |
| opposite-side clearance (promotion) | computed | `YES` / `NO` |
| touch | computed | `YES` / `NO` |
| invalidation | computed | drives `state` |
| **MOVE_AWAY** | **not computed** | **`not tracked`** |
| **EXPANSION_TO_IPO** | **not computed** | **`not tracked`** |
| **TREND_FROM_IPO** | **not computed** | **`not tracked`** |

Those three live in `ipoStateMachine.ts` as research and are **not part of the
frozen population rules**. They are rendered as *not tracked* rather than as a
definite "no", because a fabricated state is worse than an absent one — a reader
would otherwise conclude the engine had checked and found nothing.

A test pins this: every row must report the three as `NOT_TRACKED` and the other
three as a definite `YES`/`NO`.

## 2. No correlation or prop-firm surface in Phase C — by design

The brief asked for informational account-safety decisions *if available*, and
to stop and report rather than fix if integration required touching the existing
correlation path.

**It would have.** `checkPortfolioConflict` needs `openPositions`, which come
from `paper_positions` — a table Phase C must not read. `runPropFirmGate` reads
`prop_firm_*` plus `paper_accounts` and is pre-emptive by design.

So both surfaces are **omitted, not stubbed**. This is a deliberate absence
recorded as such, not an oversight.

Two facts from the Phase A audit make deferring cheap: correlation is almost
entirely **advisory** today (`approved`, `blockThreshold` and
`maxCurrencyExposure` are dead; concentration only scales size), and all three
UI correlation settings are currently **inert** because `mapNestedToFlat` reads
`strategy.*` while the UI writes `instruments.*`. Surfacing that in the IPO tab
would display a control that does nothing.

## 3. The observation endpoint touches only `kv_cache`

```
supabase/functions/ipo-observation/index.ts   .from("kv_cache")   — and nothing else
```

`kv_cache(key, value, expires_at, updated_at)` already exists in the baseline
schema and is the house cache for FOTSI and daily candles. It was chosen because
bootstrapping ~1,200 bars costs ~30s, which is unacceptable per UI poll, and a
new table would be a schema change Phase C does not need. Keys are namespaced
`ipo_observation:<instrument>` and expire at the next bar close.

**A `kv_cache` row is a string keyed by name. No SMC code path can read it as a
position, an order, or a trade.**

`_shared/ipoObservation.ts`, the snapshot builder, touches **no database at
all** — a test asserts it contains no `createClient`, no `.from(`, no table
name, and no `.insert` / `.upsert` / `.update` / `.delete`.

## 4. Zero broker-execute reachability

Full transitive import graph of the observation stack:

```
ipo-observation/index.ts
  -> supabase-js · cors · candleSource · apiCreditBudget · smcAnalysis
  -> _shared/ipoObservation.ts
       -> smcAnalysis · ipoRegimeDescriptors · ipoLiveEngine (types) 
       -> _shared/ipoIncrementalEngine.ts
            -> ipoContractionStateExit · ipoContractionTwoStage · ipoZones
            -> ipoLiveVolatility · ipoLifecycle · ipoRegimeDescriptors · smcAnalysis
```

No broker module, no execution helper, no position sizing, no prop-firm gate.

**`broker-execute` occurrences in CODE across the whole observation stack
(backend and frontend): 0.** The single textual occurrence is the doc comment in
`ipo-observation/index.ts` that states the guarantee; tests strip comments before
matching.

The frontend is equally constrained: `IpoScanner` invokes exactly one endpoint
(`ipo-observation`), contains no `.from("`, no `useMutation`, and no order
affordance. `executionEligible` is a **label for a human** — it reports whether
the frozen rules would admit the setup. Phase C acts on nothing.

## 5. No writes to SMC trading-state tables

Asserted by test across both the endpoint and the snapshot builder, for
`paper_positions`, `pending_orders`, `paper_trade_history`, `paper_accounts`,
`staged_setups`, `trades` and `bot_configs`. The endpoint's `.from(...)` call
sites resolve to exactly `["kv_cache"]`.

Unchanged versus `origin/main`: `bot-scanner`, `paper-trading`, `broker-execute`,
`zone-confirmation-scanner`, `scannerManagement`, `propFirmGate`, `configMapper`.

`BotView.tsx` is **+17 lines, 0 deletions** — the existing SMC tree is wrapped in
a strategy tab and is byte-identical inside. A test asserts `ScanDetailInline`
contains no IPO conditional.

---

## Test status

- Deno: **1,073 passed, 0 failed** (12 new observation tests)
- Vitest: **57 passed, 0 failed** (8 new regression tests)
- One pre-existing `tsc` error in `ChartOverlayHUD.tsx` (`"obV2"`), verified
  present on HEAD before this phase and unrelated to it.

---

## Open before Phase D — the IPO paper-state contract

Phase D must not begin until these are defined:

1. **IPO-owned position table / state** — shape, ownership, and why it cannot be
   adopted by SMC management.
2. **Paper fill semantics** — limit at the midpoint, what counts as a fill, and
   how a same-bar fill-and-exit is resolved.
3. **S2 management** — who advances it, on what cadence, and what happens to an
   open position across a gap or a missed bar.
4. **Target handling** — 2R only, and what happens when both target and S2
   trigger on one bar.
5. **Interaction with correlation / account safety** — whether IPO paper is
   visible to account-level risk at all, given §2 above.
6. **Journal / Dashboard presentation** — how paper results appear **without
   mixing into SMC live P&L**. `paper_trade_history` is read unscoped by the
   journal, daily review and weekly advisor, so this is a real pooling risk.

**Phase C complete. Stop before Phase D.**
