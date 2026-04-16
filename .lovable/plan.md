

## Diagnosis

Two issues are preventing MT5 trade mirroring:

### 1. MetaAPI "Place manual trades" is OFF
Your MetaAPI account screenshot shows **"Place manual trades: Off"**. This setting must be **On** for trades placed via the MetaAPI REST API to execute. When it's Off, MetaAPI blocks any trade requests coming through the API (they only appear as "manual" trades from MetaAPI's perspective).

**Fix:** In your MetaAPI dashboard, change "Place manual trades" to **On**, then click **Update** and redeploy the account.

### 2. SSL error may still be occurring
The most recent log still shows the native Deno SSL error (`invalid peer certificate: UnknownIssuer`), suggesting the `undiciFetch` fix may not have been deployed or isn't being used in the MT5 mirror code path. I need to redeploy the `bot-scanner` function and verify the fix takes effect.

## Plan

1. **You (user action):** Go to MetaAPI dashboard → Edit your account → Change **"Place manual trades"** from **Off** to **On** → Click **Update** → Redeploy the account
2. **I will:** Redeploy the `bot-scanner` edge function to ensure the `undiciFetch` SSL fix is active
3. **I will:** Run a test call to verify MetaAPI connectivity from the scanner
4. **Verify:** Trigger a manual scan to confirm the full flow works end-to-end

