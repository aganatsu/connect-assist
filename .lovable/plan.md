

# Per-Broker Settings & Symbol Overrides

## What You Get

Each broker connection gets its own independent configuration — different instruments, risk settings, SL/TP methods, sessions, and symbol overrides. Your "No Spread" demo account can trade EUR/USD with structure-based SL, while your "Try" account trades XAU/USD with ATR-based SL and suffix `r`.

## Architecture

Currently there's **one global bot config** per user. We'll add an optional `connection_id` foreign key to `bot_configs` so each broker connection can have its own config. The global config remains as a fallback.

```text
┌──────────────────────┐
│  Global Bot Config   │  ← connection_id = NULL (fallback)
└──────────────────────┘
┌──────────────────────┐
│  "No Spread" Config  │  ← connection_id = abc-123
└──────────────────────┘
┌──────────────────────┐
│  "Try" Config        │  ← connection_id = def-456
└──────────────────────┘
```

## Changes

### 1. Database Migration
- Add `symbol_overrides` (jsonb, default `'{}'`) to `broker_connections`
- Add `connection_id` (uuid, nullable, FK to `broker_connections.id ON DELETE CASCADE`) to `bot_configs`
- Add unique constraint on `(user_id, connection_id)` — one config per connection

### 2. Backend: `bot-config/index.ts`
- `get` action accepts optional `connectionId` — returns connection-specific config if it exists, else global
- `update` action accepts optional `connectionId` — upserts per-connection config
- `reset` action accepts optional `connectionId`

### 3. Backend: `bot-scanner/index.ts`
- `loadConfig()` updated: when executing for a specific broker connection, load that connection's config first, fall back to global
- Add `resolveSymbol(pair, conn)` helper that checks `symbol_overrides` before default suffix

### 4. Backend: `broker-connections/index.ts` & `broker-execute/index.ts`
- CRUD includes `symbol_overrides` field
- `resolveSymbol()` used for all order execution

### 5. Frontend: `Settings.tsx` (Broker Connections)
- Each broker connection card gets an **"Edit Settings"** button that opens `BotConfigModal` scoped to that connection
- Add a **Symbol Overrides** key-value editor (e.g., `XAUUSD → m`) below the existing suffix field
- Connection list shows whether it has custom config or uses global

### 6. Frontend: `BotConfigModal.tsx`
- Accepts optional `connectionId` prop
- When set, loads/saves config for that specific connection
- Shows a banner: "Configuring: [connection name]" vs "Global Configuration"
- Add "Copy from Global" button to initialize a connection config from the global one

### 7. Frontend: `api.ts`
- `botConfigApi.get(connectionId?)` and `.update(config, connectionId?)`
- `brokerApi.create/update` includes `symbol_overrides`

## Files Changed
- **Migration**: add `symbol_overrides` column + `connection_id` column + unique constraint
- `supabase/functions/bot-config/index.ts`
- `supabase/functions/bot-scanner/index.ts`
- `supabase/functions/broker-connections/index.ts`
- `supabase/functions/broker-execute/index.ts`
- `src/pages/Settings.tsx`
- `src/components/BotConfigModal.tsx`
- `src/lib/api.ts`

