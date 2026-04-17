
User confirmed to proceed with the symbol mapping audit fixes from the previous (cancelled) message.

## Plan: Fix Symbol Mapping

### Issues
1. `resolveSymbol` in `broker-execute` is case-sensitive — UI uppercases keys but lookup may miss
2. OANDA `place_order` bypasses `symbol_overrides` (hardcodes `replace("/", "_")`)
3. `bot-scanner` mirror loop only filters MetaAPI — OANDA connections ignored
4. Symbols with spaces (e.g. "US Oil") not normalized
5. No validation that overrides exist at broker

### Changes

**`supabase/functions/broker-execute/index.ts`**
- Make `resolveSymbol` normalize: trim + uppercase both pair and override keys, strip spaces and `/`
- Use `resolveSymbol` for OANDA `place_order` too (instead of hardcoded `.replace("/", "_")`)
- Apply same normalization in `account_summary`, `open_trades`, `symbol_specs` where symbol is referenced
- Add a new `validate_symbol` action that calls broker symbol_specs and returns ok/error so UI can verify an override before saving

**`supabase/functions/bot-scanner/index.ts`**
- Update mirror query to include both `metaapi` AND `oanda` connections
- Ensure resolved symbol passed to `place_order` uses the override map

**`src/pages/Settings.tsx`**
- Normalize override keys consistently (trim + uppercase, strip spaces/slashes) before saving
- Add a "Validate" button per override row that calls `validate_symbol` to confirm broker accepts it

### Files
- `supabase/functions/broker-execute/index.ts`
- `supabase/functions/bot-scanner/index.ts`
- `src/pages/Settings.tsx`
