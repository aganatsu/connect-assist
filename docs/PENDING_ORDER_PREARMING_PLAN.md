# Pending Order Pre-Arming — implementation plan

Scoped 2026-08-12. Not started. Work begins at step 1.

Read `CLAUDE.md` first. This plan touches identity, schema and entry behaviour,
which is exactly where this repo has historically drifted.

---

## The problem

With **Market Fill at Zone** disabled, the bot effectively cannot open a trade.
Confirmed from production data: no `pending_orders` row has reached `filled`
since **2026-05-15**, and in the 14 days to 2026-08-11, 30 were created and 0
filled.

The cause is not a single bug. Three were fixed (below); the fourth is a design
gap and is what this plan addresses.

`bot-scanner`'s hard Impulse Zone Gate calls `continue` whenever price is not
already at the zone (~line 6752, "price not at zone yet ... Persisted to
Watchlist"). The order-placement path at ~line 8538 is therefore never reached
in advance. So:

| price vs zone | Market Fill ON | Market Fill OFF |
| --- | --- | --- |
| away from zone | watchlist only | watchlist only |
| at the zone | fill immediately | create pending order, then await CHoCH |

Both routes act **only on arrival**. "Pending Zone Orders" currently means
*start confirmation after arrival*, not *arm the setup before arrival* — despite
its UI description, "Place limit orders at zone instead of waiting for market
fill".

A trade with Market Fill off therefore needs four coincidences:

1. price reaches the zone
2. a scan lands while it is there (5-minute granularity, on zones ~11 pips wide)
3. CHoCH confirms before expiry
4. the order is not destroyed meanwhile — **fixed in #318**

### What this is NOT

It is **not** a broker resting limit order. A real limit would execute on touch
and bypass CHoCH, silently converting a confirmed-entry model into an
unconfirmed one. This is a **pre-armed zone setup stored in `pending_orders`**
that begins confirmation on touch.

---

## Two different things are called `candidateId`

They are currently disjoint in the code, and merging them would be wrong.

| | generator | identifies | consumers |
| --- | --- | --- | --- |
| **Zone evidence ID** | `buildZoneCandidateId` in `_shared/zoneCandidateIdentity.ts` — deterministic over detector, symbol, timeframe, source candle, direction, bounds | a **market object** (this FVG/OB) | `zoneTimeframeEvidence.ts` only |
| **Setup lifecycle ID** | `crypto.randomUUID()`, persisted at watchlist creation (`bot-scanner` ~5818), inherited downstream | **one opportunity's journey** | `staged_setups` → `pending_orders` → `paper_positions` |

The lifecycle ID is stable **by persistence, not by derivation**. That is a
feature: a persisted ID cannot drift as a rolling candle window advances.

`breakerCandidateAuthority.ts` has a third, deterministic ID that includes
`structureBreakIndex`. That one is breaker-specific and is not the lifecycle ID.

> **Do not consolidate these.** Same name, genuinely distinct concepts — the
> case `CLAUDE.md` already flags for `detectBreakerBlocks` / `detectJudasSwing`.
> Add both to `docs/CONCEPT_INVENTORY.md` during step 1.

---

## Implementation steps

Steps 1–2 are **prerequisites, not details**. Attempting step 5 first fails on a
database constraint, and the failure points at the wrong place.

### 1. Document and rename the two identity concepts
Record both in `docs/CONCEPT_INVENTORY.md`. Rename so the collision cannot be
"fixed" by a future agent merging them.

### 2. Narrow candidate uniqueness to active statuses
Today:

```sql
CREATE UNIQUE INDEX idx_pending_orders_candidate
  ON public.pending_orders (user_id, bot_id, candidate_id)
  WHERE candidate_id IS NOT NULL;
```

This spans **all** statuses. Only 30 of 1,325 rows currently carry a
`candidate_id`, so it is effectively dormant — which is why 511 supersede
inserts succeeded. The moment identity is populated, a cancelled or expired row
owns that ID forever and legitimate re-inserts (including #318's supersede path)
fail with a constraint violation rather than a cancellation.

Required:

```sql
WHERE candidate_id IS NOT NULL
  AND status IN ('pending', 'awaiting_confirmation')
```

**This migration must land before step 3.** It is a no-op while `candidate_id`
is mostly null, which is precisely why it is safe to do first.

### 3. Preserve the persisted lifecycle ID
Watchlist → pre-armed record → position must carry one ID.

- `bot-scanner` ~8877: `pendingLifecycleEvidence?.candidateId || crypto.randomUUID()`
  — remove the random fallback for watchlist-linked setups.
- `bot-scanner` ~10780: breaker path always randomises.
- Leave historical null IDs untouched.

### 4. Explicit handoff for materially changed setups
A materially changed setup is a **new** lifecycle candidate, created through an
explicit handoff rather than by silently reusing or randomising an ID. Use
`shouldSupersedePendingOrder()` (`_shared/botConfigBehavior.ts`, from #318) as
the decision primitive — written for a different purpose, but it is the right
comparison.

### 5. Pre-arm at zone discovery
Create the pending record when the qualified zone is found, while price is still
away. Lifecycle:

```
Watchlist candidate created
  → same candidate pre-armed in pending_orders (shared frozen context + ID)
  → candle wick touches zone      → zone_touch_time recorded
  → awaiting_confirmation
  → frozen CHoCH/reversal contract passes
  → atomic candidate claim
  → position opened
```

Pre-arm **only when Market Fill is off**:
- Market Fill on → watchlist only
- Market Fill off → watchlist plus linked pre-armed record

### 6. One absolute expiry
`staged_setups.ttl_minutes` defaults to **240**; `pending_orders.expiry_minutes`
defaults to **60**. One candidate, two clocks disagreeing by 4x. The pre-armed
record inherits the watchlist candidate's absolute expiry, and does **not**
restart on arming or on touch.

### 7. Atomic exclusion between routes
Once a record is armed in advance, price arriving could satisfy both the armed
setup and the market-fill path in the same scan. Market fill must atomically
claim or cancel the pre-armed record before entering. Do not rely on flag
ordering.

### 8. Touch detection from cached candles
Group by symbol + timeframe and evaluate **candle high/low, not close** — a wick
into the zone between scans is exactly what the current design misses.

`zone-confirmation-scanner` filters `status = 'awaiting_confirmation'`
(~line 305), so it structurally cannot see pre-touch armed records. It needs
widening or a sibling pass. Read from the scan cache; do not add per-record
fetches (see #310, #316).

### Phase-specific invalidation

An entry stop is sized for a position that exists. Using it as a pre-arrival
boundary is a category error, and it worsens the longer a setup is armed —
GBP/CHF has been observed with ~2 pips of tolerance below an 11-pip zone.

| phase | invalidation authority |
| --- | --- |
| before touch | frozen impulse / zone structural boundary |
| after touch | confirmation contract and attempt limits |
| after entry | position stop loss |

Expect the `invalidated` rate to **rise** once setups are armed for longer. That
is the design working, not a regression.

---

## Required tests

The failure mode is a forked identity, which no hash comparison catches. Test
the persistence behaviour, not derivation:

- repeated detection of the same setup **updates the existing watchlist row and
  preserves its `candidate_id`**
- only one active watchlist row per symbol/direction/setup
- pre-armed pending inherits the same `candidate_id`
- unchanged rescans do not create another identity
- material changes go through `shouldSupersedePendingOrder()` and an explicit
  handoff
- **terminal historical rows do not block a new active candidate** (this one
  otherwise surfaces in production weeks later as silent insert failures)

---

## Direction-reversal validation after #319

`compareDirectionVerdicts()` remains the sole post-placement direction owner.
The pending monitor, confirmation monitor, and simulated backtest lifecycle now
adapt the dedicated persisted Direction Verdict into that comparison. They do
not rebuild direction or fetch another set of candles.

The comparison remains fail-open unless the setup has a frozen baseline and the
current verdict is fresh, executable, built for the same frozen style roles,
and complete for the sources that style/configuration expects.

Two constraints that must survive wiring, both already pinned by tests in
`supabase/tests/_shared/directionVerdictAuthority.test.ts`:

- **A partial verdict must never cancel, even at high confidence.**
  `agreement = agreeing / directionalSources` is an unweighted headcount, so
  dropping an *opposing* source raises agreement and removes its confidence
  penalty. A partial verdict can be *more* confident than the complete one.
- **Completeness is relative to the style.** `weeklyBias` is supplied only when
  `roles.bias === "1w"`. Requiring all five sources would mark every Day Trader
  verdict partial forever and disable the check while appearing to work.

---

## Monitoring

### Supersede cancellations should collapse (after #318)

```sql
select split_part(cancel_reason, ':', 1) as reason_class, count(*) as n
from pending_orders
where status = 'cancelled' and created_at > now() - interval '7 days'
group by 1 order by 2 desc;
```

Baseline before #318, across 1,047 cancelled rows: Superseded 511, Direction
flip 300, Game plan bias reversal 203, other 33.

### New pending rows should retain touch and attempt state

```sql
select order_id, symbol, status, zone_touch_time, confirmation_attempts, created_at
from pending_orders
where created_at > now() - interval '2 days'
order by created_at desc;
```

`zone_touch_time` resetting to null across scans is the #318 regression signal.

### Fills — the measure that matters

```sql
select status, count(*) as n, max(created_at) as last
from pending_orders
where created_at > now() - interval '7 days'
group by 1 order by 2 desc;
```

A fill needs price to actually reach a zone, so absence over a day or two is not
evidence of failure. Order **survival** is the earlier signal.

### TwelveData credits — expect ~19/min against a 50 cap

```sql
select caller, count(*) as credits
from api_credit_usage
where reserved_at > now() - interval '3 minutes'
group by 1 order by 2 desc;
```

Post-#316 baseline: `bot-scanner:candleSource` ~13/min (was 20–30 before the
daily-FX pre-warm), `impulse-lifecycle-replay` ~3/min (bounded by `limit(20)`
every 5 min), `paper-trading/price` ~3/min.

If this climbs, check `creditBudget` in `scan_logs.details_json` — non-zero
`unenforced` means the shared budget failed open and per-isolate limiting is
back.

### Scan-stage forensics

`details_json` is an array from the main scan path and an **object** from the
game-plan path. A set-returning function cannot sit inside `CASE`:

```sql
select d->>'pair' as pair, d->>'status' as status,
       left(coalesce(d->>'skipReason', d->>'reason', ''), 90) as why,
       count(*) as n
from scan_logs,
     lateral jsonb_array_elements(
       case when jsonb_typeof(details_json) = 'array'
            then details_json else jsonb_build_array(details_json) end
     ) as x(d)
where created_at > now() - interval '2 hours'
group by 1, 2, 3 order by 4 desc;
```

---

## Related work already merged

| PR | change |
| --- | --- |
| #309 | paper-trading price cache — polling was uncapped |
| #310 | manage loop 8s → 20s; it ran 7 passes per minute |
| #311 | shared TwelveData budget in Postgres; the limiter counted per isolate |
| #312 | metered the call sites that bypassed the limiter entirely |
| #314 | per-caller credit attribution |
| #315 | 30-minute credit history (was 2 minutes — could not distinguish saturation from a burst) |
| #316 | manage loop re-fetched six daily FX pairs every minute |
| #318 | pending orders cancelled and recreated themselves every scan cycle |
| #319 | introduced the single owner for post-placement direction; live/backtest consumers are now wired to it |
