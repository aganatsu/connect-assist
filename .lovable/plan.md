

## Problem Analysis

**Yes, this is a critical issue.** Currently the bot:

1. Calculates position size using the **paper account balance** (line 1377, 1509)
2. Sends the **same lot size** to ALL connected broker accounts (lines 1676-1678)

**Your scenario:**
- $100 account + $10,000 account both connected
- Bot calculates size for $10,000 risk (say 0.5 lots)
- **Both accounts get 0.5 lots** — the $100 account is severely over-leveraged

## Solution

Fetch **per-broker account balance** and calculate **custom lot size for each broker**:

```text
Current flow:
  calculatePositionSize(paperBalance) → size → send same size to all brokers

New flow:
  For each broker:
    fetchBrokerBalance(conn) → brokerBalance
    calculatePositionSize(brokerBalance) → brokerSpecificSize
    send trade with brokerSpecificSize
```

## Implementation

### 1. Add `account_balance` action to `broker-execute` edge function
- MetaAPI: `GET /users/current/accounts/{id}/account-information` → return `balance`, `equity`
- OANDA: `GET /v3/accounts/{id}/summary` → return `balance`, `NAV`

### 2. Update `bot-scanner` broker mirror loop
- Before placing trade on each broker, fetch its account balance
- Recalculate `brokerVolume` using `calculatePositionSize(brokerBalance, ...)`
- Log: `"[BrokerA $100] size=0.01, [BrokerB $10k] size=0.5"`

### 3. Add safety cap
- Max 5% account risk per trade per broker (configurable)
- If broker balance fetch fails, skip that broker (don't default to paper balance)

## Files Changed
- `supabase/functions/broker-execute/index.ts` — add `account_balance` action
- `supabase/functions/bot-scanner/index.ts` — fetch per-broker balance, recalculate size per broker

## What This Fixes
- $100 account gets 0.01 lots, $10k account gets 0.5 lots — proportional sizing
- No more over-leverage on small accounts
- Each broker independently managed

