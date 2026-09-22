# `getQuoteToUSDRate` / rate_map semantics audit

**Audit only.** No change to SMC rules, sizing, execution, management cadence,
IPO or provider behaviour. Dated 2026-09-22.

---

## 0. Answers up front

**Is the forming 1D bar an accident or a deliberate live-rate proxy?**
It is being used as a **live rate proxy, and it works exactly**. Measured against
a contemporaneous 1-minute close:

```
USD/JPY  1day last close 157.59084   1min last close 157.59084   divergence 0.0000%
USD/CAD  1day last close   1.40727   1min last close   1.40727   divergence 0.0000%
USD/CHF  1day last close   0.82211   1min last close   0.82211   divergence 0.0000%
```

TwelveData's current-day bar carries the live close, so `candles[last].close` is
spot. Whether that was designed or discovered, it is correct today.

**But minute-level freshness is not required.** Worst observed drift over the
last 60 minutes of 1-minute bars:

| reuse window | USD/JPY | USD/CAD | USD/CHF | worst lot-size error | on a $1,000-risk trade |
|---|---|---|---|---|---|
| 5 min | 0.0374% | 0.0419% | 0.0402% | 0.042% | **$0.42** |
| 15 min | 0.0823% | 0.0626% | 0.0828% | 0.083% | **$0.83** |
| 30 min | 0.1193% | 0.0491% | 0.0913% | 0.119% | **$1.19** |
| 60 min | 0.1490% | 0.0690% | 0.1254% | 0.149% | **$1.49** |

**And half the fetches are dead.** Of the six pairs fetched every minute, only
three can ever be read for the current instrument set.

**The real risk is the fallback, not the cache.** `FALLBACK_RATES` is hardcoded
and badly stale — if a fetch fails, sizing is wrong by up to **9.89%**.

---

## 1. Definition and semantics

```ts
export function getQuoteToUSDRate(symbol, rateMap?): number {
  if (spec.type !== "forex") return 1.0;
  const quote = symbol.split("/")[1];
  if (quote === "USD") return 1.0;          // ← the important early return
  const conv = QUOTE_CONVERSION[quote];      // JPY→USD/JPY inv, GBP→GBP/USD, …
  const rate = (liveRate && liveRate > 0) ? liveRate : FALLBACK_RATES[conv.pair];
  return conv.invert ? (1 / rate) : rate;
}
```

It converts **one unit of the quote currency into USD**, so P&L and risk
expressed in quote-currency price units can be stated in dollars.

### Three of the six fetches are never read

The rate map is consulted only when the traded pair's **quote** currency is not
USD. Against the live `instruments.enabled` set:

| instrument | quote | consults |
|---|---|---|
| EUR/USD | USD | — returns 1.0 |
| GBP/USD | USD | — returns 1.0 |
| NZD/USD | USD | — returns 1.0 |
| AUD/USD | USD | — returns 1.0 |
| USD/JPY | JPY | `USD/JPY` |
| USD/CAD | CAD | `USD/CAD` |
| USD/CHF | CHF | `USD/CHF` |

```
fetched every minute : USD/JPY  GBP/USD  AUD/USD  NZD/USD  USD/CAD  USD/CHF
actually consulted   : USD/JPY  USD/CAD  USD/CHF
never consulted      : GBP/USD  AUD/USD  NZD/USD      ← 3/min = 4,320/day
```

`GBP/USD`, `AUD/USD` and `NZD/USD` are only reachable as *quote* currencies —
i.e. for crosses like EUR/GBP, EUR/AUD, EUR/NZD. **None of those is enabled.**
They are fetched 1,440 times a day each and the value is never read.

This is config-dependent, not permanent: enabling any GBP/AUD/NZD-quoted cross
would make them live again. A correct fix derives the rate-pair set from the
enabled instruments rather than hardcoding six.

---

## 2. Every consumer, and what it affects

| site | use | affects |
|---|---|---|
| `unifiedPositionSizing.ts:280, 312, 342` | `size = (balance × risk%) / (slDist × lotUnits × quoteToUSD)` | **lot sizing, risk sizing** |
| `bot-scanner:1599` | `riskPerUnit = |entry−SL| × lotUnits × size × quoteToUSD`, summed into portfolio heat | **exposure / concentration gate (Gate 6)** |
| `bot-scanner:1673` | commission-per-lot converted to price units → `effectiveRR` | **strategy acceptance** — a setup can be rejected on effective RR |
| `bot-scanner:3004` | `pnl = diff × lotUnits × size × quoteToUSD` on SL/TP close | **realized P&L** written to `paper_trade_history` |
| `bot-scanner:7703` | same, closing an opposite position | **realized P&L** |
| `paper-trading:184/234` | **its own duplicate copy** of the function | **P&L in the paper engine** |
| `backtest-engine:1457` | `await getQuoteToUSDRate(symbol)` — no rateMap, so always `FALLBACK_RATES` | backtest results |

**Not reporting-only.** It reaches sizing, an exposure gate, a strategy
acceptance threshold, and realized P&L.

Two things worth flagging while passing:

- `paper-trading/index.ts:184` **redefines `getQuoteToUSDRate` locally** instead
  of importing the shared one. Two implementations of a money conversion is a
  divergence waiting to happen.
- `backtest-engine` calls it with `await` on a synchronous function and passes no
  rate map, so every backtest converts at the stale fallback — see §5.

---

## 3. Per-pair request detail

Identical for all six:

```
GET https://api.twelvedata.com/time_series
    symbol=<pair>  interval=1day  outputsize=5  order=ASC  timezone=UTC
used: candles[candles.length - 1].close
```

`order=ASC` puts the newest bar last, and with `interval=1day` that bar is
**today's, still forming**. Its `close` is therefore the latest traded price,
not yesterday's settlement — which is why §0 shows zero divergence from the
1-minute close.

`outputsize=5` fetches five bars to use one. Harmless: TwelveData bills per
request, not per bar.

---

## 4. Does it need to be fresh?

**No, on every axis that matters.**

- **Lot size scales linearly** with the rate error, because `quoteToUSD` is
  `1/rate` for all three consulted pairs and size is inversely proportional to
  it. A 0.1% rate error is a 0.1% lot-size error.
- **Worst case at 60 minutes is 0.149%** → **$1.49** on a $1,000-risk trade.
  Position sizes are rounded to broker lot steps (typically 0.01 lots), and a
  0.1% change will usually not survive that rounding at all.
- **Realized P&L** carries the same proportional error, and it is applied at
  close using whatever rate is current then.
- **Portfolio heat** (Gate 6) compares a summed dollar risk to a threshold; a
  0.1% shift in one leg will not cross a sane threshold.
- **Effective RR** uses it to convert commission into price units — second-order
  on a second-order term.

**Minute-level freshness is not required anywhere in the rate map.** A 15-minute
reuse window costs at most $0.83 per $1,000 of risk, and a 60-minute window
$1.49.

---

## 5. The actual risk: the fallback is stale

If the fetch fails or is refused, `getQuoteToUSDRate` silently falls back to
hardcoded constants:

| pair | FALLBACK | live | error | lot-size error on $1,000 risk |
|---|---|---|---|---|
| USD/JPY | 142.0 | 157.59 | **−9.89%** | **$98.93** |
| USD/CHF | 0.88 | 0.82211 | **+7.04%** | **$70.42** |
| USD/CAD | 1.36 | 1.40727 | **−3.36%** | **$33.59** |

So a refused fetch is **66× worse than an hour-old cached rate** (9.89% vs
0.149%), and the scanner is currently refusing ~44 fetches per full scan. The
fallback is silent — no log, no flag, no marker on the resulting trade.

**This is the finding I would act on first.** It is a live correctness exposure
today, independent of any optimisation, and it argues *for* caching rather than
against it: a cached hour-old rate is a far better fallback than a
three-currency-regimes-ago constant.

It also means `backtest-engine`, which never passes a rate map, sizes every
non-USD-quote backtest at these constants.

---

## 6. Three sources, compared

| | A. forming 1D close (current) | B. reuse data already fetched | C. dedicated quote endpoint |
|---|---|---|---|
| requests | 6/min = **8,640/day** | 0 extra, but only sometimes available | 3/min = **4,320/day** (`/price`, 1 credit each) |
| with dead pairs dropped | 3/min = **4,320/day** | — | 3/min = 4,320/day |
| with 15-min reuse | **288/day** | — | 288/day |
| freshness | exact (0.0000% vs spot) | exact when available | exact |
| consistency | one source for all pairs | **mixed sources per pair** | one source |
| strategy/execution impact | none (status quo) | none if the bar is the same source | none |
| catch | 3 of 6 values never read | **usually unavailable** | same per-request cost as A |

**On B specifically.** The only other candle fetched in a management cycle is
the 15m series for each open-position symbol. Today's open position is
**USD/JPY**, and its 15m forming bar close *is* USD/JPY spot — so that one rate
is already in hand and the separate 1d fetch for it is pure duplication. But
this only holds when a position happens to exist on a rate pair. As a general
mechanism B is unreliable; as an opportunistic optimisation it is free when it
applies. Mixing sources per pair is the cost: two pairs from 1d bars and one
from a 15m bar is harder to reason about than one consistent source.

**On C.** TwelveData bills per request regardless of endpoint, so `/price`
saves no credits over `/time_series` — it saves payload and states the intent.
The real saving in every column comes from **fetching fewer pairs** and
**reusing across invocations**, not from changing endpoint.

---

## 7. `open_position_price_refresh` — a different answer

```ts
const candles = await cachedFetch(sym, "15m", "5d", "open_position_price_refresh");
livePriceMap[sym] = candles[candles.length - 1].close;
```

**Why every minute:** it writes `paper_positions.current_price`, and the block
immediately downstream (`bot-scanner:2958`) uses that price to detect SL and TP
breaches and **close paper positions**. In paper mode there is no broker
enforcing the stop, so this loop *is* the stop.

**What it drives:** position closure, realized P&L, and the trailing /
break-even / partial management engine.

**Does it need minute freshness? Yes.** This is the opposite conclusion to the
rate map. A stale price here does not shift a number by 0.1% — it **delays a
stop or target detection by however stale it is**. At a 15-minute reuse the
worst case is a stop detected 15 minutes and potentially many pips late, which
changes the fill price actually recorded. That is a direct execution change.

**Can it reuse an existing quote safely?** Not from a closed-bar cache — it
depends on the **forming** bar, which is precisely what a closed-bar store must
never serve. It could share a live-quote source with the rate map, since both
want spot. It is also already minimal: one fetch per *distinct symbol*, not per
position, so two positions on one symbol cost one fetch.

Two smaller notes:

- The comment says *"Fetch a minimal 1-day candle"* but the code fetches **15m**.
  Stale comment; the behaviour is fine.
- It is bounded by open positions, so it is 1/min today and would be ~7/min at
  full occupancy — still small next to the rate map's unconditional 6/min.

---

## 8. Summary for the decision

1. **`rate_map` is a live-rate proxy that does not need to be live.** Worst
   60-minute error is 0.149%; 15 minutes is 0.083%.
2. **Three of its six fetches are never read** under the current instrument set
   — 4,320 requests/day for values nothing consults.
3. **The fallback is the real exposure**, not staleness: up to 9.89% sizing
   error, silently, whenever a fetch is refused — and refusals are currently
   routine.
4. **`open_position_price_refresh` genuinely needs minute freshness** and must
   not be folded into any closed-bar caching scheme. It is also already
   deduplicated per symbol.
5. A general "cache closed bars" plan therefore addresses the rate map and
   **not** the price refresh. They look alike and are not.

Nothing changed. No recommendation is implemented; §6 and §8 are for your
decision.
