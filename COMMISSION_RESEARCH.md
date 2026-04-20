# Commission Research Notes

## OANDA REST API v20 — OrderFillTransaction

The `OrderFillTransaction` object contains these cost-related fields:

### Fields available on every order fill:
1. **`commission`** (AccountUnits) — The commission charged in the Account's home currency as a result of filling the Order. Always represented as a positive quantity of the Account's home currency, however it reduces the balance in the Account.
2. **`halfSpreadCost`** (AccountUnits) — The half spread cost for the OrderFill, which is the sum of the halfSpreadCost values in the tradeOpened, tradesClosed and tradeReduced fields. Can be positive or negative, represented in the home currency of the Account.
3. **`financing`** (AccountUnits) — The financing paid or collected when the Order was filled.
4. **`baseFinancing`** (DecimalNumber) — Financing in Instrument's base currency.
5. **`quoteFinancing`** (DecimalNumber) — Financing in Instrument's quote currency.
6. **`guaranteedExecutionFee`** (AccountUnits) — Total guaranteed execution fees for all Trades opened/closed/reduced with guaranteed SL Orders.
7. **`pl`** (AccountUnits) — The profit or loss incurred when the Order was filled.
8. **`quotePL`** (DecimalNumber) — P/L in the Instrument's quote currency.

### TradeOpen sub-object also has:
- `halfSpreadCost` — The half spread cost for the trade open.

### Key Findings:
- **OANDA provides `commission` directly on the fill transaction** — no need to calculate it manually
- Commission is already in account home currency (USD typically)
- `halfSpreadCost` is also provided — this is the spread cost in account currency
- Both are available AFTER the trade is filled (not before)
- For PRE-TRADE estimation, we need to know the commission rate per lot

### OANDA Pricing Models:
1. **Spread-only accounts** — commission = 0, wider spreads
2. **Core Pricing + Commission** — near-zero spreads, commission per million units traded
   - Typical: $50 per million units ($5 per 100k lot = $5 per standard lot)
   - Minimum: $0.01 per trade

### Pre-trade estimation approach:
- OANDA doesn't have a "get commission rate" endpoint
- Must be configured manually per broker connection
- For spread-only accounts: commission = 0 (cost is in the spread, which we already handle)
- For core pricing accounts: user enters commission per lot (e.g., $5/lot round-trip)

---

## MetaApi — Research Complete

### MetatraderDeal model has:
- **`commission`** (number) — deal commission. Available on every deal (history).
  - Example: `"commission": -0.42` on a 0.12 lot AUDNZD buy
  - That's $3.50/lot ($0.42 / 0.12 lots = $3.50 per lot per side)
- **`swap`** (number) — deal swap
- **`profit`** (number) — deal profit

### MetatraderPosition model has:
- **`realizedCommission`** (number) — commission from partially closed portions
- **`unrealizedCommission`** (number) — estimated commission for remaining position

### MetatraderSymbolSpecification does NOT have commission fields
- No commission rate in the symbol spec
- Commission is only available after a deal is executed
- MT5 has SYMBOL_TRADE_COMMISSION in MQL5, but MetaApi doesn't expose it in the REST API

### Key Finding:
- MetaApi provides commission per deal AFTER execution, not before
- Can auto-learn commission rate from first trade: `commissionPerLot = abs(deal.commission) / deal.volume`
- Same approach as OANDA — read from fill data, store for future estimation

## Design Decision:
- **Auto-detect from fill data**: Read `commission` from OANDA OrderFillTransaction after first trade, store it for future estimation
- **Manual config fallback**: User enters `commissionPerLot` when setting up broker connection
- **Pre-trade estimation**: `estimatedCommission = lots × commissionPerLot × 2` (round-trip: open + close)
- **Factor into lot sizing**: `effectiveRisk = riskAmount - estimatedCommission`
- **Factor into R:R**: `effectiveReward = rawReward - (2 × commissionCost)` (spread already handled separately)
