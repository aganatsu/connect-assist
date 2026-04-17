
The MetaAPI account `5e83d5a3-...` is returning 504 TimeoutError across ALL three regions (london, new-york, singapore) with the message: *"account is not connected to broker yet or request URL does not match account region"*. The Singapore region even fails DNS lookup.

This is NOT a code/symbol mapping issue — it's a MetaAPI account state issue. The account is **not deployed/connected** in the MetaAPI dashboard. Until the account shows status `DEPLOYED` and connection state `CONNECTED` at MetaAPI, no symbol (NAS100, EURUSD, anything) will trigger.

However, I can improve the bot so this is **visible** instead of silently failing, and confirm symbol resolution is correct.

## Plan

### 1. Surface MetaAPI connection state in `broker-execute`
Add a new action `connection_status` that calls MetaAPI's `/users/current/accounts/{id}` endpoint (provisioning API, not client API) to return the account's `state` (DEPLOYED/UNDEPLOYED) and `connectionStatus` (CONNECTED/DISCONNECTED). This tells the user exactly why trades aren't firing.

### 2. Show connection state in Settings → Broker
Add a "Check status" button per MetaAPI connection that calls `connection_status` and displays a clear toast/badge:
- ✅ Deployed + Connected — ready to trade
- ⚠️ Deployed but Disconnected — broker login issue
- ❌ Undeployed — needs deployment in MetaAPI dashboard

### 3. Log skipped brokers in scan logs
In `bot-scanner` mirror loop, when a broker returns `fallback: true`, append a clear entry to `scan_logs.details_json` like `{ broker: "...", skipped: true, reason: "MetaAPI not connected" }` so the user sees per-broker status in the scan history UI instead of silent skips.

### 4. Verify NAS100 symbol resolution
Add an explicit test: when user clicks "Validate" on a NAS100 override, log the resolved broker symbol that was tried (e.g. `USA100`, `NAS100.cash`) so user can confirm the override is correct.

## Files
- `supabase/functions/broker-execute/index.ts` — add `connection_status` action
- `supabase/functions/bot-scanner/index.ts` — log per-broker skip reasons in scan details
- `src/pages/Settings.tsx` — add "Check status" button per MetaAPI connection

## What this fixes
- You'll immediately see WHY NAS100 (and everything else) isn't triggering on MetaAPI: the account isn't connected at the broker level
- Once you deploy/connect the account in the MetaAPI dashboard, trades will fire with the existing symbol resolution
- Future broker outages will be visible in scan logs instead of silently skipped
