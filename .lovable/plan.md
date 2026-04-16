

# Add Broker Symbol Suffix Support

## The Problem
Your MT4/MT5 broker appends a suffix to symbol names (e.g., `EURUSDr` instead of `EURUSD`). The bot currently sends `EURUSD` which the broker rejects as an unknown symbol. This affects both live order execution and the broker-execute function.

## The Fix
Add a **Symbol Suffix** field to the broker connection setup. When the bot sends orders to MetaAPI, it appends this suffix to the symbol name.

### 1. Database: Add `symbol_suffix` column to `broker_connections`
- Add nullable `symbol_suffix` text column (default empty string)
- No migration needed for existing rows — they'll just have no suffix

### 2. Backend: `supabase/functions/bot-scanner/index.ts`
- Line 1587: Change `pair.replace("/", "")` → `pair.replace("/", "") + (conn.symbol_suffix || "")`
- So `EUR/USD` becomes `EURUSDr` when suffix is `r`

### 3. Backend: `supabase/functions/broker-execute/index.ts`
- Line 94: Same fix for MetaAPI `place_order` — append `conn.symbol_suffix`
- Line 129 (paper-trading): Same fix if applicable

### 4. Frontend: Broker connection UI
- Add a **Symbol Suffix** input field in the broker connection form (where API key and account ID are entered)
- Label: "Symbol Suffix (e.g., 'r', '.pro', '.raw')"
- Optional field, defaults to empty

### Files Changed
- `supabase/functions/bot-scanner/index.ts` — append suffix on MT5 mirror orders
- `supabase/functions/broker-execute/index.ts` — append suffix on all MetaAPI orders
- `src/pages/BotView.tsx` or wherever broker connection form lives — add suffix input
- Migration: add `symbol_suffix` column to `broker_connections`

