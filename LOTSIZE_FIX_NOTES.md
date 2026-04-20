# Lot Sizing Cross-Pair Fix — Analysis Notes

## Problem
`calculatePositionSize` and `calcPnl` both assume quote currency = USD.
Formula: `lots = riskAmount / (slDistance × lotUnits)` — this only works for XXX/USD pairs.

## Affected Locations

### calculatePositionSize (3 copies)
1. `_shared/smcAnalysis.ts` line 985 — shared export, used by backtest-engine
2. `bot-scanner/index.ts` line 1584 — local copy, used for paper + broker sizing
3. Both have identical logic

### calcPnl (2 copies)
1. `_shared/smcAnalysis.ts` line 1017 — shared export, used by backtest-engine
2. `paper-trading/index.ts` line 92 — local copy with local SPECS

## Quote Currency Categories

### XXX/USD pairs (no conversion needed — quote is USD):
EUR/USD, GBP/USD, AUD/USD, NZD/USD, XAU/USD, XAG/USD, BTC/USD, ETH/USD

### USD/XXX pairs (need to divide by current pair price):
USD/JPY, USD/CAD, USD/CHF
- Pip value in USD = pipSize × lotUnits / currentPrice
- For USD/JPY at 150.00: 0.01 × 100000 / 150 = $6.67 per pip per lot (not $10)

### Cross pairs (need USD/quote rate):
EUR/GBP → need GBP/USD rate (invert to get USD per GBP)
EUR/JPY, GBP/JPY, AUD/JPY, CAD/JPY → need USD/JPY rate
EUR/AUD, GBP/AUD → need AUD/USD rate (invert)
EUR/CAD, GBP/CAD, AUD/CAD → need USD/CAD rate
EUR/CHF, GBP/CHF → need USD/CHF rate
EUR/NZD, GBP/NZD → need NZD/USD rate (invert)

### Non-forex (already priced in USD, lotUnits handles it):
US30, NAS100, SPX500 — lotUnits=1, price IS in USD
US Oil — lotUnits=1000, price in USD
XAU/USD, XAG/USD — already XXX/USD

## Conversion Logic

```
getQuoteCurrencyRate(symbol, priceMap):
  quote = symbol.split("/")[1] or "USD" for indices/oil
  
  if quote === "USD" → return 1.0
  if quote === "JPY" → return priceMap["USD/JPY"] (USD per JPY = 1/USDJPY)
  if quote === "GBP" → return 1/priceMap["GBP/USD"] (USD per GBP)
  if quote === "AUD" → return 1/priceMap["AUD/USD"]
  if quote === "NZD" → return 1/priceMap["NZD/USD"]
  if quote === "CAD" → return priceMap["USD/CAD"] (already USD/CAD)
  if quote === "CHF" → return priceMap["USD/CHF"]
  
  Wait — need to be precise:
  
  Pip value per lot = pipSize × lotUnits (in quote currency)
  Pip value in USD = pipSize × lotUnits / quoteToUSDRate
  
  Where quoteToUSDRate = how many units of quote per 1 USD
  - For JPY: quoteToUSDRate = USD/JPY price (e.g., 150) → pip value = 0.01 × 100000 / 150 = $6.67
  - For GBP: quoteToUSDRate = 1 / GBP/USD price (e.g., 1/1.27 = 0.787) → pip value = 0.0001 × 100000 / 0.787 = $12.71
  - For CAD: quoteToUSDRate = USD/CAD price (e.g., 1.36) → pip value = 0.0001 × 100000 / 1.36 = $7.35
  - For CHF: quoteToUSDRate = USD/CHF price (e.g., 0.88) → pip value = 0.0001 × 100000 / 0.88 = $11.36
  
  Actually simpler:
  pipValueUSD = (pipSize × lotUnits) × quoteToUSD
  where quoteToUSD = how many USD per 1 unit of quote currency
  
  - USD quote: quoteToUSD = 1
  - JPY quote: quoteToUSD = 1/USDJPY (e.g., 1/150 = 0.00667)
  - GBP quote: quoteToUSD = GBPUSD (e.g., 1.27)
  - AUD quote: quoteToUSD = AUDUSD (e.g., 0.65)
  - NZD quote: quoteToUSD = NZDUSD (e.g., 0.60)
  - CAD quote: quoteToUSD = 1/USDCAD (e.g., 1/1.36 = 0.735)
  - CHF quote: quoteToUSD = 1/USDCHF (e.g., 1/0.88 = 1.136)
```

## Where to get the rates
- In bot-scanner: we already fetch candles for all instruments. The last close of USD/JPY, GBP/USD, etc. gives us the rate. These are in our instrument list.
- In backtest-engine: candle data is available per-symbol. Need to pass rate map.
- In paper-trading: can fetch from the same candle source or use the position's current price data.

## Fix Strategy
1. Add `getQuoteToUSDRate(symbol: string, rateMap: Record<string, number>)` to smcAnalysis.ts
2. Update calculatePositionSize to accept optional `rateMap` param
3. Update calcPnl to accept optional `rateMap` param  
4. In bot-scanner, build rateMap from the last close prices of major pairs before the sizing loop
5. In backtest-engine, build rateMap from candle data
6. In paper-trading, build rateMap from current prices
7. Replace hardcoded maxLot with a `fallbackMaxLot` that only applies when broker specs aren't available
