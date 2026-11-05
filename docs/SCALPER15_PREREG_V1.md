# SCALPER15_PREREG_V1 — 15m impulse scalper with 1H direction, pre-registered

**Written 2026-11-05, before any data for this study was fetched.** Owner spec
(2026-11-05): impulse detected on 15m by the production Impulse engine; 1H
high/low as a direction filter; entry on 5m with the existing confirmation;
stop beyond the zone; target the opposite 1H level. Everything below is frozen.
A disappointing result rejects the idea; parameters are not changed afterwards.

## What it has to beat

#677 (2026-10-27) dropped 15m zones after a pre-registered six-month replay:
**15m −0.20R**, 5m −0.17R, 1H −0.08R, stable in both halves and with any pair
removed. The new elements here are the 1H direction filter and the 1H-level
target. This study asks whether they turn 15m zones positive.

## Universe, data, periods

- **Pairs:** EUR/USD, USD/JPY, GBP/USD, AUD/USD, USD/CAD, USD/CHF, NZD/USD — the
  same seven as the #677 corpus, so the comparison is like for like.
- **Data:** TwelveData 1m / 5m / 15m / 1h, fetched by
  `local-runner/scalper15-fetch.ts` into `local-runner/.cache/scalper15/`.
  Weekend FX tape is dropped (`tradeableAt`, the rule from `smc-corpus-fetch.ts`).
- **In-sample (IS):** decisions 2026-03-29 → 2026-09-25 — the #677 window.
- **Holdout:** decisions 2026-09-26 → 2026-11-04 — six weeks no study has used.
  Evaluated **once**, only if G1 passes; the runner refuses `--holdout` otherwise.

## Rules

Only **closed** bars are used: a bar is visible at time *t* only once
`open + timeframe ≤ t`.

**1H direction (the filter).**
- Swing high: a 1H bar whose high is strictly above the highs of the two bars
  on each side; it is known at the close of the second bar after it. Swing low
  mirrored.
- Bias turns **long** when a 1H bar closes above the most recent confirmed swing
  high, and **short** when one closes below the most recent confirmed swing
  low. It stays until the opposite break.
- Leg extreme: the highest high (long) or lowest low (short) of closed 1H bars
  since the bar that set the bias, inclusive.

**15m zone.** At every 15m close, while flat and not hunting a touched zone:
`planScalper15` (`supabase/functions/_shared/scalper15.ts` — the same function
bot-scanner trades with) → `findBestEntryZone(last 480 closed 15m bars, last
1440 closed 5m bars, bias direction, last 5m close, no HTF data, { pipSize })`,
the production engine unmodified with the 15m series in the impulse slot. The
1H bias is read over the last 120 closed 1H bars — the window the live
scanner's 1H fetch returns. A zone is armed if the engine returns one with
`sideOk` or `priceInsideZone` **and** the planned R from the zone midpoint to
the 1H target is ≥ 1.0 (placement check; stop and target are fixed on the
order from here on, as Route 2 stores them). Zone = the POI's
high/low. An untouched armed zone is replaced by the next 15m result; it
expires 480 minutes after arming (the Route 2 lifetime). A bias flip cancels it.

**Touch → 5m confirmation (existing).** At each 5m close:
- untouched: touched when the bar trades into the zone (long: low ≤ zone high;
  short: high ≥ zone low);
- touched: `detectZoneConfirmation(last 300 closed 5m bars, dir,
  DEFAULT_ZONE_CONFIRMATION_CONFIG, touchIndex, symbol, zone bounds)` —
  production's call. A signal triggers entry. With no signal,
  `classifyZoneExit(close, …)`: `inside` keeps hunting; `left_breach` cancels
  the zone (price went through it); `left_favourable` resets to untouched.

Confirmation is checked before the exit classification on the same bar. This
is slightly more permissive than production, which classifies the exit first
on its 1-minute poll.

**Entry, stop, target.**
- Entry: market, at the open of the first 1m bar at or after the confirming 5m
  bar's close.
- Stop: 1 pip beyond the zone's far edge (long: zone low − 1 pip). No floor.
- Target: the 1H leg extreme at placement (long: leg high), fixed on the order.
- **Admission:** planned R ≥ 1.0 at placement (from the zone midpoint) and again
  at the fill: (target − entry fill) / (entry fill − stop), measured from the
  cost-inclusive fill. Otherwise the setup is skipped and
  logged. *(This rule is the analyst's addition to the owner spec: a
  variable-R target needs a floor, or setups with a target inside the spread
  get admitted.)*
- Weekends: like the live bot, positions are held over the weekend (the weekend
  tape is skipped; a Monday open beyond the stop fills at that open). No
  Friday cutoff — the live bot has none, and this backtest must measure it.
- One position per pair. No portfolio caps (raw setup edge, like #677).

## Execution and costs (1m-resolved)

- **All-in round-trip cost S** (spread + commission), pips: EUR/USD 1.5,
  GBP/USD 2.0, USD/JPY 1.8, AUD/USD 2.0, NZD/USD 2.5, USD/CAD 2.0, USD/CHF 2.0.
  (EUR/GBP/JPY from the iov3 research table; the rest from `SPECS.typicalSpread`
  + 0.5.) Stop fills slip a further 0.3 pip.
- Bars are mid prices. A long buys at mid + S/2 and its exits trigger on the
  bid (mid − S/2); a short mirrors. So the stop and target trigger realistically,
  and the full S is paid on every trade. Putting the commission into the
  trigger offset is slightly conservative.
- A bar that opens beyond the stop fills at that open (gap).
- **Ambiguous:** stop and target both reachable in one 1m bar. Reported both
  ways. **Gates use the conservative count: ambiguous = stop.**
- `netR = dir × (exit fill − entry fill) / (entry fill − stop)`.

## Decision gates

**G1 — in-sample. All must hold (conservative ambiguity):**
1. at least 100 trades (fewer = inconclusive, treated as fail);
2. net expectancy > 0R;
3. profit factor ≥ 1.10;
4. net expectancy > 0 on at least 4 of the 7 pairs.

**G2 — holdout (once, only after G1):** net expectancy > 0R.

Pass both → a production shadow arm (separate design) for ≥ 100 trades before
any real money. Fail either → rejected.

## Reported, not decisive

Excluding ambiguous trades; 2× cost; by pair, session, month, exit reason and
planned-R bucket; skip counts at each stage (no bias, no zone, no touch, no
confirmation, admission).

## Limitations, up front

- The live bot also applies the account's enabled-sessions setting and its
  risk gates (caps, daily loss, news); this backtest takes every session and
  no account state, like #677.
- The production lifecycle's minimum-observation window and deferred resets
  are not reproduced; the hunt is simplified as above.
- HTF confluence data (4H OBs etc.) is not passed, so zone ranking uses
  Fib/S-R/LTF refinement only.
- The six-week holdout is small; G2 can reject, but it cannot prove an edge
  alone — that is the shadow arm's job.
- Same instruments and period as #677: the IS result is a comparison, not
  fresh evidence. Only the holdout is unseen.
