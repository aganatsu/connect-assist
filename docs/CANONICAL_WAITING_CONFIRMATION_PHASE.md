# Canonical Waiting and Confirmation Phase

Status: implemented on `fix/canonical-waiting-confirmation`, pending review and deployment.

## Ownership

The scanner now separates three outcomes:

- `allow`: entry may continue to final authorization.
- `wait`: preserve the staged/pending candidate; do not create rejected analytics.
- `terminal`: blocked, invalidated, expired, or otherwise finished.

## Liquidity confirmation v2

The v2 contract is observation-only. Stable event IDs derive from market
timestamps and prices rather than rolling candle indexes.

Ordering is:

```text
sweepTime >= zoneTouchTime
confirmationTime > sweepTime
```

Observation reason codes distinguish a legitimate missing sweep from an
identity migration failure. Legacy or unresolvable contracts fail closed and
require a fresh sequence.

## Executable entry ownership

When a frozen pending entry exists, it owns premium/discount evaluation and the
displayed Entry/SL/TP plan. Current market price remains a separate observation.
Final authorization still recalculates location at the actual fill price.

## Deployment

1. Apply `20260812130000_add_liquidity_confirmation_observation.sql`.
2. Deploy `bot-scanner`.
3. Deploy the frontend.

## Verification

```sql
select status, count(*) as n, max(created_at) as latest
from pending_orders
where created_at > now() - interval '2 hours'
group by 1;

select
  liquidity_confirmation_observation->>'reasonCode' as reason_code,
  count(*)
from pending_orders
where created_at > now() - interval '1 day'
group by 1
order by 2 desc;
```

Expected behavior: `awaiting_*` candidates remain active until their absolute
expiry or structural invalidation. Only terminal outcomes enter rejected setup
analytics.
