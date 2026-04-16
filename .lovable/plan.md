

# Add More Instruments: Forex Pairs + Indices + Commodities + Crypto

## New Instruments to Add

### Additional Forex (11 new pairs)
| Symbol | Name | Pip Size | Yahoo |
|--------|------|----------|-------|
| EUR/AUD | Euro / Australian Dollar | 0.0001 | EURAUD=X |
| EUR/CAD | Euro / Canadian Dollar | 0.0001 | EURCAD=X |
| EUR/CHF | Euro / Swiss Franc | 0.0001 | EURCHF=X |
| EUR/NZD | Euro / New Zealand Dollar | 0.0001 | EURNZD=X |
| GBP/AUD | British Pound / Australian Dollar | 0.0001 | GBPAUD=X |
| GBP/CAD | British Pound / Canadian Dollar | 0.0001 | GBPCAD=X |
| GBP/CHF | British Pound / Swiss Franc | 0.0001 | GBPCHF=X |
| GBP/NZD | British Pound / New Zealand Dollar | 0.0001 | GBPNZD=X |
| AUD/CAD | Australian Dollar / Canadian Dollar | 0.0001 | AUDCAD=X |
| AUD/JPY | Australian Dollar / Japanese Yen | 0.01 | AUDJPY=X |
| CAD/JPY | Canadian Dollar / Japanese Yen | 0.01 | CADJPY=X |

### Indices (3 new)
| Symbol | Name | Point Size | Yahoo |
|--------|------|-----------|-------|
| US30 | Dow Jones Industrial | 1.0 | YM=F |
| NAS100 | Nasdaq 100 | 0.25 | NQ=F |
| SPX500 | S&P 500 | 0.25 | ES=F |

### Additional Commodities & Crypto (3 new)
| Symbol | Name | Point Size | Yahoo |
|--------|------|-----------|-------|
| XAG/USD | Silver / US Dollar | 0.001 | SI=F |
| US Oil | Crude Oil | 0.01 | CL=F |
| ETH/USD | Ethereum / US Dollar | 0.01 | ETH-USD |

## Asset-Class Profiles (Bot Scanner)

Each asset class gets parameter adjustments applied **before** style overrides:

- **Indices** — wider SL buffer (×3), higher ATR threshold, weight NY session heavily
- **Commodities** — wider SL buffer (×2), adjusted proximity thresholds
- **Crypto** — skip session/kill-zone safety gates (24/7 market), wider SL buffer (×2)
- **Forex** — no adjustment (baseline)

```text
Flow:  Instrument Type → Asset Profile → Style Override → Scanner Analysis
```

## Interface Changes

Add `'index'` to the Instrument type union, plus `pointValue` and `contractSize` fields:
```typescript
type: 'forex' | 'crypto' | 'commodity' | 'index';
pointValue?: number;   // default 1
contractSize?: number; // default 100000 for forex
```

## Files to Modify

### `src/lib/marketData.ts`
- Expand `Instrument` interface with `'index'` type, `pointValue`, `contractSize`
- Add all 17 new instruments
- Keep `FOREX_PAIRS` filter working

### `supabase/functions/market-data/index.ts`
- Add Yahoo symbol mappings for all new instruments

### `supabase/functions/bot-scanner/index.ts`
- Add Yahoo symbol mappings + SPECS for new instruments
- Add `ASSET_PROFILES` object with per-type parameter multipliers
- Apply asset profile adjustments in scan loop before style overrides
- Skip session/kill-zone gate for crypto instruments

### `src/components/BotConfigModal.tsx`
- Group instrument selection by type (Forex / Indices / Commodities / Crypto)
- Show type badges next to instruments

### `src/components/InstrumentSearch.tsx`
- Group search results by instrument type with section headers

## What Does NOT Change
- 9-factor confluence scoring logic
- 10 safety gates logic
- Trading style system (layers on top as before)
- No new database tables

