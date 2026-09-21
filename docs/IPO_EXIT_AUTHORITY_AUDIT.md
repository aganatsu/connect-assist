# Exit Authority Audit — why two components decide when an IPO trade ends

Requested at the D.1 checkpoint. **Analysis only. Nothing was refactored.**

---

## 1. The finding, stated plainly

Two modules independently implement the frozen termination rule.

| | `ipoIncrementalEngine.manageOpen` | `ipoPaperContract.stepPosition` |
|---|---|---|
| S2 test | `close < stop` (long) | `bar.close < s2InvalidationLevel` |
| Target test | `high >= target` | `bar.high >= targetPrice` |
| Order | S2 tested **before** target | S2 tested **before** target |
| Ambiguous bar | loss, silently | loss, `sameBarAmbiguous = true` |
| Exit price | `close` on S2, `target` on target | identical |
| Cost | `gross - costR`, cost fixed at entry | identical |
| MAE/MFE | running max of adverse/favourable ÷ risk | identical |

They are line-for-line equivalent today. Neither is derived from the other, and
nothing in the build would notice if they stopped agreeing — which is exactly
why `runPaper` carries a divergence check.

## 2. How it got that way

It is not an oversight; it follows from the Phase D architecture as approved.

The engine could not be resumed across stateless invocations, so the worker
rebuilt it every run. A rebuilt engine has no memory of what the paper layer
already recorded, and its bar window slides. The paper layer therefore had to be
able to advance an open position **from the database and the bars alone**,
without an engine — which is also what made gap suspension possible, since the
engine cannot represent "these bars are missing and I will not guess".

So the duplication bought two things:

1. management that survives a cold worker with no engine state, and
2. a position lifecycle (`open → suspended → aborted`) the engine has no concept
   of and should not acquire, because it is a data-quality concern, not a rule.

## 3. What D.1 changes about the argument

Persistent state removes reason (1). A warm engine now carries the open trade
across invocations, so the paper layer no longer *needs* to be able to manage
without one. Reason (2) is untouched: the engine still has no suspended state,
and giving it one would mean editing a frozen module to model a provider
failure.

## 4. Can the runner consume authoritative engine events instead?

Mostly yes, and here is precisely what it would take.

**It would work for the normal path.** `feed()` already emits `EXITED` with the
complete `LiveTrade` — exit bar, exit price, net R, MAE, MFE. The runner could
map that event to a `PaperResult` and delete `stepPosition`'s exit logic
entirely.

**Three things block a clean swap, and none of them is hypothetical:**

1. **Events alias live engine state.** `LiveEvent.trade` is the engine's own
   object, not a copy. A test added in D.1 pins this: an `ENTERED` event held
   across later bars silently acquires `exitIndex`, `exitPrice` and `netR` when
   the trade closes. Any consumer that stores events — which an event-driven
   runner must — would be reading mutable state and could not tell an emission
   from a later mutation. This was found the hard way: it produced a false
   failure in the D.1 restart suite before it was understood.

   *Fix:* emit copies, or copy at the boundary. Emitting copies is a change to
   the engine's interface and would want its own equivalence run.

2. **A suspended position has no engine counterpart.** During a data gap the
   paper layer must hold a position the engine either does not have (it was
   never fed the missing bars) or has already resolved on bars we refuse to
   trust. Event consumption gives no answer here; the paper layer still needs
   `suspendForGap` / `resumeFromGap` / `abortForGap`, and the abort path must
   still produce a result with **no** exit price and **no** R.

3. **Sizing and identity are not engine concepts.** `realizedPnlUsd`,
   `nominalRiskUsd`, `setupId`/`intentId`, `excludedFromStats` and the
   strategy/account decision split all live in the paper layer. Consuming events
   removes the duplicated *exit arithmetic*, not the mapping layer.

## 5. Recommendation

**Do not refactor at D.1. Keep the duplication and keep the divergence check.**

Reasons, in order of weight:

- The duplication is currently *load-bearing for safety*. The divergence check
  is only meaningful because two implementations exist; collapsing to one
  removes the detector along with the redundancy. Right now that detector is the
  only thing standing between a subtle state bug and a silently wrong forward
  record — and D.1 has just changed how state is carried, which is the worst
  possible moment to remove the check on it.
- The event-aliasing defect (4.1) must be fixed *before* any event-driven
  consumer exists, and fixing it touches the engine's emission contract. That is
  a separate change with its own oracle-equivalence run, not a rider on a state
  checkpoint.
- The saving is small. `stepPosition` is ~40 lines of arithmetic that is fully
  covered by tests and pinned against the engine on every run.

**What to do instead, now:** the divergence check stays, and D.1 strengthens it
— it already compares levels and open/closed disagreement, and it now runs
against a *warm* engine, so a state bug surfaces as a divergence rather than as
a plausible-looking trade.

**When to revisit:** after the event-copy fix lands and after Phase D has run
long enough to show the divergence check firing zero times on real data. At that
point the choice is between two honest designs, rather than between a safe one
and a tidy one.

## 6. If the duplication is kept — which it is — the required conditions

1. `runPaper` must refuse to write on any engine/paper disagreement. *Implemented.*
2. The disagreement must name the trade and the nature of the mismatch. *Implemented.*
3. Both implementations must be exercised on the same bars in CI. *Implemented:
   the runner's equivalence tests compare the paper result against
   `replayIncremental` trades field by field across seven independent windows.*
4. Any edit to one exit path must be mirrored and re-verified in the other.
   *Enforced only by the tests above; there is no structural guard, and that is
   the residual risk of this decision.*
