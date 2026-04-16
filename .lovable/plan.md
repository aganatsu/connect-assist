

# Auto-Fetch Broker Symbol Specs for Lot Sizing

## Problem
The bot uses a hardcoded `SPECS` table for position sizing — same values for every broker. But brokers differ: one might require min 0.1 lots for NAS100, another accepts 0.01. The current code silently gets rejected when it sends invalid volumes.

## Solution
Before placing a trade on each broker, fetch the symbol specification from MetaAPI (contract size, min/max volume, volume step) and use it to clamp and round the lot size correctly.

## Implementation

### 1. Add `symbol_specs` action to `broker-execute` edge function
- **MetaAPI**: Call `GET /users/current/accounts/{id}/symbols/{symbol}/specification`
- **OANDA**: Call `GET /v3/accounts/{id}/instruments/{symbol}` (returns minimumTradeSize, maximumTradeSize)
- Return: `{ contractSize, minVolume, maxVolume, volumeStep, digits, stopsLevel }`

### 2. Update `bot-scanner` to fetch specs before sizing
In the broker mirror section (where trades are sent to each broker):
1. Call `symbol_specs` for the resolved symbol on that broker
2. Replace the hardcoded `SPECS` values with the broker's actual values for that trade
3. Clamp lot size to `[minVolume, maxVolume]` and round to `volumeStep`
4. Log the broker specs used so you can see exactly why a size was chosen

### 3. Cache specs to avoid repeated calls
- Store fetched specs in a local map during each scan run
- Key: `{connectionId}:{brokerSymbol}`
- Specs don't change mid-scan, so one fetch per symbol per broker per run is enough

### Technical Details

```text
Current flow:
  calculatePositionSize() → hardcoded SPECS → same lot for all brokers → send

New flow:
  calculatePositionSize() → base lot estimate
  Per broker:
    fetchSymbolSpec(conn, resolvedSymbol) → { minVolume, maxVolume, volumeStep }
    clampedLot = clamp(baseLot, minVolume, maxVolume)
    roundedLot = round(clampedLot / volumeStep) * volumeStep
    send with roundedLot
```

### Files Changed
- `supabase/functions/broker-execute/index.ts` — add `symbol_specs` action
- `supabase/functions/bot-scanner/index.ts` — fetch specs per broker before placing, clamp/round lot size

### What This Fixes
- No more `ERR_INVALID_TRADE_VOLUME` rejections
- Each broker gets a lot size it actually accepts
- Different contract sizes (1 for BTC vs 100000 for forex) are handled automatically
- No need to manually maintain the hardcoded SPECS table for broker-specific values

