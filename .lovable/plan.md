

# Show All Active Broker Connections (MT4 + MT5)

## Problem
The bot view only looks for **one** MetaAPI connection (`broker_type === "metaapi"`) and displays a hardcoded "MT5 Connected" badge. If you have both MT4 and MT5 accounts connected (both use MetaAPI under the hood), only one shows up and the label is always "MT5".

## Solution
Show **all active broker connections** as individual badges using each connection's `display_name`, and update the text references from "MT5" to "Broker" for generality.

## Changes

### `src/pages/BotView.tsx`

1. **Replace single `mt5Connection`** variable with a filtered array of all active connections:
   ```typescript
   const activeConnections = Array.isArray(brokerConns) 
     ? brokerConns.filter((c: any) => c.is_active) 
     : [];
   ```

2. **Replace the single badge** (lines 163-171) with a loop that renders one badge per active connection, showing the `display_name`:
   ```text
   Before:  [MT5 Connected]
   After:   [Try ✓] [No Spread ✓]   (or "Connect Broker" if none)
   ```

3. **Update mode-switch banners** (lines 117, 119): Change "MT5 mirroring" text to "broker mirroring" since it could be MT4 or MT5.

4. **Update "Connect MT5" fallback** button text to "Connect Broker".

### Files Changed
- `src/pages/BotView.tsx` — show all active connections by name, generalize MT5 references

