# D.1 — Persistent Incremental Engine State

Status: **implemented and verified locally. Nothing applied, nothing deployed.**
No migration applied, no function deployed, no cron, no Journal change, no SMC
change, no broker work. The Phase D migration is still unapplied.

Headline: **the warm path is 49 ms where the rebuild path is 17.1 s — a 384×
reduction — and persisted/rehydrated execution reproduces uninterrupted
execution with zero mismatches across every restart point tested.**

One prediction I made did **not** survive measurement; see §6.

---

## 1. The state DTO

`supabase/functions/_shared/ipoEngineState.ts` (new, 333 lines, pure).

Nothing reflects over the engine instance. `IncrementalEngine.snapshot()`
enumerates the continuation state explicitly, and each field is there because a
later bar reads it:

| Field | Why a later bar needs it |
|---|---|
| `bars` | every whole-series call — `twoStageContractions`, `segmentEpisodes`, `fvgsNear` — rescans the full prefix |
| `vol` (`effSeen`, `atrSeen`) | the sorted percentile reference the next bar is ranked against |
| `tracked` | candidate lifecycles mid-flight: zone, invalidation level, `validAt`, `promotionDead`, `lastTouch`, `hasFvg`, `fvgSettled`, `epContext` |
| `frozenEpisodes` | the contraction cache |
| `episodes` | the context string each candidate is compared against every bar |
| `open`, `lastExitIndex`, `lastVol` | sequencing, management, previous-exit state |
| `trades` | consumed by the paper layer's reconciliation |

**`refusals` is deliberately excluded.** It is written and never read — a
diagnostic accumulator, not state. A test parses every `this.refusals` mention
in the engine and fails if any of them is not a `.push(`.

Identity and integrity block, all validated on restore:

```
schemaVersion            RUNTIME_STATE_SCHEMA_VERSION = 1
strategyVersion          spec-1.1
engineRulesFingerprint   derived from FROZEN_RULES, never hand-maintained
instrument / timeframe / highVolOnly
costModelId              declared identity of costPerSide
lastProcessedBarTime, barCount
checksum                 64-bit FNV-1a over everything above
```

`FROZEN_RULES` is new: the FVG window, the detection reach, the four contraction
parameters and the state-exit family, previously scattered as literals, now
collected in one exported object **and used by the engine itself**. Change any
of them and the fingerprint changes automatically, so old state stops being
restorable without anyone remembering to bump a constant. The values are
unchanged, and the oracle-equivalence suite still passes.

The one thing a payload cannot carry is `EngineConfig.costPerSide`, a function.
The caller supplies it on restore and `costModelId` must match, so a silently
re-tuned cost model invalidates the state instead of re-pricing an open trade.

### Rebuild reasons — a rebuild is never silent

`NO_STATE` · `MALFORMED_STATE` · `SCHEMA_VERSION_CHANGED` ·
`STRATEGY_VERSION_CHANGED` · `ENGINE_RULES_CHANGED` ·
`INSTRUMENT_CONFIG_CHANGED` · `COST_MODEL_CHANGED` · `CHECKSUM_MISMATCH` ·
`BAR_CONTINUITY_BROKEN` · `STATE_BAR_LIMIT` · `ADMIN_REQUESTED`

Restore is fail-closed: there is no partial restore and no best-effort repair.
Every reason has a test that makes it fire.

---

## 2. The hard safety requirement — result

**Zero mismatches.** 26 tests in `supabase/tests/_shared/ipoEngineState.test.ts`.

The required protocol, run literally:

```
bootstrap 1,200 bars
  ├─ uninterrupted: feed 40 more bars            → baseline
  └─ split:  restore from bytes → feed 20
             export → engine destroyed
             restore from bytes → feed 20        → compared
```

Compared: every field of every emitted event, in order, plus the full trade
ledger, the open trade, the volatility bucket, the bar count, the sequencing
flag and every tracked candidate. All identical.

Restart points, each **located in the fixture rather than assumed** — the test
fails if a condition never occurs:

| Required restart state | Found | Result |
|---|---|---|
| during contraction | yes | exact |
| with pending IPO | yes | exact |
| after IPO becomes valid | yes | exact |
| immediately before touch | yes | exact |
| with open trade | yes | exact |
| after S2 invalidation | yes | exact |
| after target exit | yes | exact |
| around a volatility-state change | yes | exact |

Plus:

- **every single bar** of a 99-bar window restarted individually — 99 restarts,
  all exact (a phase-dependent bug in FVG settlement or episode freezing would
  hide from a single point);
- the same for a **volatility-gated** instrument at full 200-bar warmup;
- `export → restore → export` byte-identical;
- a snapshot taken mid-stream is unaffected by the engine continuing.

"Fresh process" is implemented as rehydration **from a string**, through a
function that cannot close over the engine that produced it. It is not a real
`fork`; the test suite has no `--allow-run`. The one thing a real process
boundary would additionally drop is `costPerSide`, and that is supplied exactly
as the worker supplies it — which is why `costModelId` exists.

### What the exactness work found

A real defect in my own test method, which turned out to be a real property of
the engine worth pinning:

> **`LiveEvent.trade` is the engine's own object, not a copy.** An `ENTERED`
> event held across later bars silently acquires `exitIndex`, `exitPrice` and
> `netR` when the trade closes.

This produced a false failure: the baseline's retained events had mutated to
their final values while the restarted run's had not. The fix was to compare
events **as emitted**. The aliasing itself is now pinned by its own test, and it
is the main blocker on consuming engine events in the paper runner — see the
exit-authority audit.

---

## 3. Runtime behaviour

Normal scheduled invocation:

```
load persisted engine state  (kv_cache, one row, self-checksummed)
restore or name a rebuild reason
fetch INCREMENTAL_BARS = 120   ← not 1,200
continuityCheck: the page must CONTAIN the last processed bar
feed only the bars after it
runPaper(..., warmEngine)
persist: results → positions → events → ENGINE STATE → paper cursor
```

`continuityCheck` is where the safety lives. **The overlap is the proof**: only
if the fetched window contains the last processed bar is it demonstrable that
nothing between the two is missing. No overlap → `BAR_CONTINUITY_BROKEN` →
rebuild. A bar already processed is never re-fed; a provider restating a bar we
have already acted on is a continuity break, not an update.

### Atomicity — stated precisely

The engine payload is **one row, one upsert**, so it is atomic at the row level:
a reader sees the old complete state or the new one. It carries its own
checksum, so a torn or truncated value is rejected on restore and becomes a
rebuild rather than a wrong continuation.

The engine row and the paper-cursor row are **not** written in one transaction.
The order is chosen so the surviving failure is the benign one: crash between
them and the next run has an engine *ahead* of the cursor, re-derives decisions
for bars the cursor has not passed, and every write is content-addressed, so the
replay is a no-op. The reverse order would advance the cursor past bars the
engine had not recorded and lose those setups silently.

A full rebuild happens only for one of the eleven named reasons above, including
`?rebuild=1` for an explicit administrative re-anchor.

---

## 4. Performance — measured

1,200-bar bootstrap, synthetic 1h fixture, this machine.

| | EUR/USD 1h | BTC/USD 1h (gated) |
|---|---|---|
| **Cold bootstrap (1,200 bars)** | **17,094 ms** | **13,305 ms** |
| restore from bytes | 2.9 ms | 2.2 ms |
| continuity check (60-bar page) | 0.1 ms | 0.0 ms |
| feed 1 new closed bar | 41.3 ms | 31.5 ms |
| `runPaper` on the warm engine | 0.3 ms | 0.0 ms |
| export + serialize | 4.6 ms | 2.3 ms |
| **Warm invocation, one new bar** | **49.2 ms** | **36.0 ms** |
| speedup vs rebuild | **384×** | **395×** |
| feed 3 bars / 24 bars | 122 ms / 981 ms | 94 ms / 760 ms |
| payload raw / gzip | 389.0 KB / 93.1 KB | 374.2 KB / 90.6 KB |

**Bars fetched per invocation:** 120 warm (one provider page), 1,200 cold.

**API requests/credits:** unchanged at **one provider request per instrument per
invocation** — `fetchCandlesWithFallback` is billed per request, not per bar, so
the warm path does not reduce the request count. What it reduces is payload and
compute. The credit budget is therefore unaffected by D.1; the scanner-starvation
problem is a separate matter and this does not make it worse.

**Persistence:** two `kv_cache` upserts per instrument per invocation. Not
measured against a live database — no deployment was made — so `persistMs` is
instrumented in the worker response and left to be read from the first real run.

### Payload growth

| Bars | Total | bars | tracked | vol reference | trades | episodes |
|---|---|---|---|---|---|---|
| 1,200 | 389.0 KB | 25% | **55%** | 12% | 7% | 1% |
| 2,400 | 784.1 KB | 24% | **55%** | 12% | 8% | 1% |

Linear, ~330 bytes per bar. `MAX_STATE_BARS` is set to **3,000** — about four
months of hourly bars, ~1 MB raw and ~240 KB gzipped — after which the state is
discarded and the engine re-anchors under `STATE_BAR_LIMIT`.

**`tracked` is the majority of the payload and is never pruned** (one candidate
roughly every other bar). Pruning it is *not* obviously safe and was not
attempted: in `advance()` the episode-context comparison runs **before** the
`invalidatedAt` guard, and `rederive()` resets `invalidatedAt` to null — so an
invalidated candidate can be revived by a late contraction. Dropping dead
candidates would be an optimisation that can change decisions, which is exactly
the class of change this programme refuses to make casually. Flagged as
follow-up work needing its own measurement, not folded in here.

---

## 5. Exit authority

Full analysis in `docs/IPO_EXIT_AUTHORITY_AUDIT.md`.

Summary: `ipoIncrementalEngine.manageOpen` and `ipoPaperContract.stepPosition`
are line-for-line equivalent implementations of the same frozen rule. The
duplication exists because, before D.1, the paper layer had to be able to manage
a position from the database and bars alone with no engine — and because the
engine has no concept of a suspended position, which is a data-quality state and
should not become a rule.

D.1 removes the first reason and not the second.

**Recommendation: keep the duplication and keep the fail-closed divergence
check, for now.** The duplication is currently load-bearing for safety — the
divergence check is only meaningful because two implementations exist, and
collapsing to one removes the detector along with the redundancy, immediately
after changing how state is carried. Consuming engine events also requires
fixing the event-aliasing defect first, which touches the engine's emission
contract and deserves its own oracle-equivalence run. Revisit after that fix
lands and after the divergence check has run clean on real data.

---

## 6. A prediction that did not survive

I expected to show that rebuilding on a sliding 1,200-bar window is not merely
expensive but *discontinuous* — that bars dropping off the back would change
episodes and therefore decisions, making persistence a correctness fix as well
as a cost fix.

**Measured: zero difference.**

| Window | Series | Seeds | Bars compared | Bars differing |
|---|---|---|---|---|
| 300 | 500 | 1 | 201 | **0** |
| 600 | 700 | 2 | 202 | **0** |

A sliding-window rebuild produced exactly the same event at every compared bar
as a continuously-grown engine. So the case for persistence is **cost, and
continuity by construction rather than by luck** — not a measured drift fix. I
am not going to claim a correctness benefit the measurement does not support.

This does not weaken the case for D.1: 17 s per instrument per invocation is the
real problem, and a state that is proven to continue exactly is worth having on
its own terms. But the "rebuilds silently change decisions" argument is
withdrawn at these window sizes.

---

## 7. Files

| File | Change |
|---|---|
| `_shared/ipoEngineState.ts` | **new** — DTO, packing, fingerprint, restore, continuity |
| `_shared/ipoIncrementalEngine.ts` | `FROZEN_RULES` exported and used; `snapshot()` / `fromSnapshot()`; no rule changed |
| `_shared/ipoLiveVolatility.ts` | `VolatilityState`, `exportState()`, `LiveVolatility.restore()` |
| `_shared/ipoPaperRunner.ts` | optional `warmEngine`; `bootstrapped` now means "a rebuild was paid for" |
| `ipo-paper-runner/index.ts` | warm path, 120-bar incremental fetch, continuity gate, named rebuild reasons, engine-state persistence, per-phase timings in the response |
| `tests/_shared/ipoEngineState.test.ts` | **new** — 26 tests |
| `tests/_shared/ipoPaperRunner.test.ts` | +1 test: the warm path decides exactly what the rebuild path decides, with exactly one rebuild across 120 invocations |
| `tests/_shared/ipoZones.test.ts` | `ipoEngineState.ts` registered in the shadow guard |

`ipo-paper-state` (the read path) is **unchanged** and still performs only
`SELECT`. The engine payload is stored under its own key and is never shipped to
a browser.

---

## 8. Test results

```
deno test supabase/tests/ supabase/functions/   2737 passed | 0 failed  (5m12s)
vitest run                                        57 passed | 0 failed  (1.9s)
deno check                                        clean on every function and IPO module
```

2,709 → 2,737: +26 new persistence tests and +2 elsewhere (the warm-path
equivalence test and the event-aliasing pin). No test was removed or relaxed,
and the oracle-equivalence suite for `ipoIncrementalEngine` still passes
unchanged after `FROZEN_RULES` was extracted.

---

## 9. Still not done

- Migration `20260921140000_ipo_paper_state.sql` **not applied**.
- Functions **not deployed**, no cron.
- `persistMs` and real API credit behaviour unmeasured — they need a live run.
- `tracked` pruning: 55% of the payload, needs its own decision-safety analysis.
- Event-copy fix on `LiveEvent.trade`: prerequisite for any event-driven runner.
- `#580` still open; consolidation still unresolved; the `maxCorrelation` config
  drift still deliberately unfixed.
