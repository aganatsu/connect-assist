# IPO 1-minute intrabar resolution — stage 1

**Research only. No strategy logic changed. No baseline replaced. No deployment.**
Follows the forensic audit merged as `8530eef4` (PR #618). Dated 2026-09-23.

This is **stage 1 of the research order agreed after that merge**, and it
deliberately stops short of a new baseline.

| step | status |
|---|---|
| 1. can we get 1m from the same provider family as the HTF bars? | **BLOCKED** — see §2 |
| 2. classify trades whose historical source cannot be identified | **DONE** — §2 |
| 3. Bitstamp-specific parallel reconstruction for BTC | **DONE** — §4 |
| 4. label every result by provider | **DONE** — enforced in the type system, §3 |
| 5. calculate a new versioned baseline | **NOT STARTED, deliberately** |

---

## 1. What stage 1 produces

Two concepts, kept apart by the type system rather than by convention:

- **SOURCE_MATCHED** — same provider *and* venue as the HTF bar, proven.
  Reconstructs the original path. **Zero trades qualify today.**
- **VENUE_SPECIFIC** — a named venue's own tape, honest about being a different
  tape. Bitstamp BTC/USD. **14 trades resolved.**

Plus `HTF_SOURCE_UNKNOWN` and `CROSS_FEED_REFERENCE` for completeness.

---

## 2. Can we source-match? Not today, and the reason is recorded

`ipo-paper-runner/index.ts:303` does:

```ts
const { candles } = await fetchCandlesWithFallback({ … });
```

`fetchCandlesWithFallback` returns `{ candles, source }`. **The source is
discarded at the destructure**, and no IPO table has a provider, venue or feed
column. The fetch is a three-provider fallback chain — MetaAPI → TwelveData →
Polygon — so any given stored bar came from one of three tapes and nothing
records which.

**Therefore every historical IPO trade is `HTF_SOURCE_UNKNOWN`.** That is the
classification called for in step 2 of the agreed order: not an assumption of
match, not an assumption of mismatch, an explicit statement that the question
cannot be answered from what was stored.

**Two things would change this, neither done here:**

1. *Going forward* — capture `source` on the position row. One word at the
   destructure, one nullable column. No strategy impact.
2. *Retrospectively* — attribution by comparison. Fetch each provider's own 1h
   history for the stored timestamps and look for an exact OHLC match. A tape
   that reproduces the stored bars bit-for-bit **is** the source, and that is
   evidence rather than inference. This needs `TWELVE_DATA_API_KEY` and
   `POLYGON_API_KEY`, which this investigation does not hold.

Until (2) runs, **no SOURCE_MATCHED result can exist**, and the code will not
let one be claimed by accident.

---

## 3. The resolution rules

`supabase/functions/_shared/ipoIntrabarResolution.ts` — pure, research-only, not
wired to the engine, the runner or the backtest.

**Scope is one bar.** The audit established multi-bar trades are unaffected:
once a position survives its entry bar every later bar is evaluated causally.
The defect lives entirely in the entry bar, so that is all this resolves. A
trade still open when the HTF bar ends is handed back to HTF management
unchanged.

```
entry timestamp   first 1m bar with low <= entry            (long)
post-entry MFE    max high over minutes AT OR AFTER entry
target touch      first minute at/after entry with high >= target
S2 touch          first minute at/after entry with low <= S2   — INFORMATIONAL
S2 invalidation   first minute at/after entry whose CLOSE < S2  — THE EXIT
```

**S2 remains close-confirmed.** This is the rule the incident turns on and finer
resolution must not weaken it: the 14:23 touch did not invalidate, the 14:30
close did. Two tests pin it.

**Within one minute, target beats an S2 close** — the close is the minute's last
event, so it cannot precede a high in the same minute. This is the opposite of
the HTF stop-first convention and correct for the same reason: it follows the
known ordering rather than a safety convention standing in for one.

**Residual ambiguity is reported, never guessed.** A minute containing both the
entry and the target is `UNRESOLVED_AT_1M` — 1m is no finer than 1h for that
trade, and it is the tick-data fallback case.

---

## 4. Bitstamp reconstruction — BTC/USD, 14 same-bar trades

`local-runner/intrabar-resolve-bitstamp.ts`. Read-only; writes one local JSON.

### Feed divergence check, run first

Before resolving anything, the Bitstamp minutes for each hour are aggregated
back to 1h and compared with the stored bar. If the two tapes disagree
materially on the hour, the minute answer is not trustworthy either.

```
n=14   min 0.007%   median 0.034%   max 0.094%   above the 0.2% limit: 0
```

The tapes agree closely on the hour. That **strengthens** Bitstamp as a proxy;
it does not make it the original source. Divergence of 0.094% on an 85,000 price
is ~80 points, and BTC risk here is ~343 points, so residual feed noise is worth
roughly 0.23R — small relative to the effects below, not zero.

### Results

| 1m outcome | n | HTF R booked | meaning |
|---|---|---|---|
| `STILL_OPEN_AT_BAR_END` | 7 | +8.14 | not resolved in the hour — **outcome unknown**, must carry forward |
| `S2_CLOSE_AFTER_ENTRY` | 4 | +1.66 | **definite reversal**: booked +2R, actually an S2 loss inside the hour |
| `TARGET_AFTER_ENTRY` | 2 | +1.33 | **genuine post-entry win — stands** |
| `UNRESOLVED_AT_1M` | 1 | +0.18 | needs tick data |

Verdicts: AGREES 2, CONTRADICTED 11, STILL_UNRESOLVED 1, FEED_DIVERGENT 0.

### The single most important number

**Not one of the 11 contradicted trades reached 2R post-entry.** Highest
post-entry MFE across all of them was **1.66R**:

```
2026-08-22T05:00  entry 05:10  post-entry MFE 0.97R
2026-08-24T11:00  entry 11:40  post-entry MFE 1.42R
2026-08-25T12:00  entry 12:06  post-entry MFE 1.56R
2026-08-28T02:00  entry 02:18  post-entry MFE 0.37R
2026-08-31T14:00  entry 14:42  post-entry MFE 0.85R
2026-09-03T14:00  entry 14:59  post-entry MFE 0.16R
2026-09-09T18:00  entry 18:42  post-entry MFE 0.57R
2026-09-09T22:00  entry 22:09  post-entry MFE 1.35R
2026-09-18T13:00  entry 13:51  post-entry MFE 1.66R
2026-09-22T00:00  entry 00:58  post-entry MFE 0.18R
2026-09-23T14:00  entry 14:13  post-entry MFE 1.19R
```

Every one was booked at +2R gross. Entry minutes cluster late in the hour —
13:51, 14:42, 14:59, 22:09 — exactly the shape the audit predicted: the high was
set early, price ranged down to the entry afterwards, and the engine paired the
two.

### The incident, reconstructed

```
2026-09-23T14:00Z  htf=TARGET_2R  divergence 0.035%  1m=S2_CLOSE_AFTER_ENTRY  CONTRADICTED
  entry minute   14:13
  post-entry MFE 1.19R   (84880 against a target needing 85159.525)
  S2 touched     14:23   — touch only, correctly NOT an exit
  S2 close       14:30   — the invalidation
```

Bitstamp's own API reproduces the manual reading exactly: the 14:00 minute is
`H 85838.51 / L 85754.37` against the hand-read `H 85839 / L 85754`.

---

## 5. What this does NOT say

**CONTRADICTED is not "loss".** Only 4 of the 11 are proven losses inside the
hour. Seven are `STILL_OPEN_AT_BAR_END`: the trade should have carried forward
to later HTF bars, and its real outcome is **unknown** until the corrected
sequence is re-simulated forward. Some of those may still have reached target an
hour later. Treating +8.14R of booked R as −8.14R would be the same error as
booking it in the first place, in the other direction.

**Two trades genuinely won.** `TARGET_AFTER_ENTRY` on 2026-08-28 and 2026-08-31
reached the target after the entry, at 1m. This is the concrete reason "ignore
the entry-bar target" is the wrong fix — it would delete real wins.

**Nothing here is a baseline.** No expectancy is published, the locked
1,039-trade table is untouched, and these 14 BTC trades are a venue-specific
sample from one instrument.

---

## 6. What stage 2 needs

In the agreed order, before any new baseline:

1. **Provider attribution** (§2 option 2) — needs `TWELVE_DATA_API_KEY` and
   `POLYGON_API_KEY`. Without it every result stays `HTF_SOURCE_UNKNOWN` and
   `SOURCE_MATCHED` remains empty by construction.
2. **EUR/USD and USD/JPY** — 69 same-bar trades between them, and Bitstamp
   does not trade FX, so there is no venue-specific fallback. These are entirely
   dependent on step 1.
3. **Forward re-simulation** of the 7 `STILL_OPEN_AT_BAR_END` trades, to convert
   "unknown" into an outcome.
4. **Tick fallback** for the 1 `UNRESOLVED_AT_1M` trade.

Only after those does a versioned baseline become meaningful, and it must be
published beside the locked table, never as an edit to it.

---

## 7. Files

| file | |
|---|---|
| `supabase/functions/_shared/ipoIntrabarResolution.ts` | **new**, pure, research-only. Not imported by any engine, runner or backtest. |
| `supabase/tests/_shared/ipoIntrabarResolution.test.ts` | **new**, 13 tests |
| `local-runner/intrabar-resolve-bitstamp.ts` | **new**, read-only reconstruction |
| `docs/IPO_1M_INTRABAR_RESOLUTION.md` | this report |

No existing file is modified. Nothing under `supabase/functions/` outside the
new module is touched, and the new module has no callers in production code.

```
deno supabase/tests      1314 passed    deno supabase/functions  1569 passed
deno check               clean          vitest                    262 passed
tsc --noEmit             clean
```

---

## 8. Statement

No IPO detection, lifecycle, contraction, FVG, direction, E2 entry, S2
invalidation, 2R target, re-entry, sequencing, volatility or cost rule was
changed. No SMC code, no broker execution, no LIVE/CANARY behaviour, no cron, no
schema, no database row. Nothing deployed. The locked 1,039-trade baseline is
untouched and no replacement expectancy is published.
