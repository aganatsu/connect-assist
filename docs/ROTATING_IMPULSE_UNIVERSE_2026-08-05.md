# Rotating Impulse Universe - 2026-08-05

## Purpose

Cover a large configured instrument universe while limiting full Gameplan, Impulse Zone, liquidity, confirmation, and entry analysis to a bounded batch per scan cycle.

## Runtime rules

1. Bot Config contains the complete eligible universe and an active-slot count (default 8).
2. The first cycle selects never-scanned pairs in configured order.
3. A pair with a valid Impulse Zone graduates to the Watchlist/Zone Setup lifecycle and releases its discovery slot.
4. Active Watchlist, pending-order, and open-position symbols are excluded from discovery.
5. Up to six Watchlist records per cycle receive an oldest-first entry-timeframe price and invalidation refresh; only near/inside-zone setups escalate to deep confirmation analysis.
6. The next cycle fills discovery slots with never-scanned pairs first, then the least-recently-scanned pairs.
7. Provider and insufficient-data failures are recorded as `data_error`, never as `no_impulse`, and cannot invalidate a frozen lifecycle setup.
8. Rotation state is persisted per user and bot in `kv_cache` for 90 days.

## Observability

Every scan log includes `impulseRotation` with the universe size, slot count, selected pairs, pinned pairs, and discovery pairs. `pairs_scanned` reports the actual selected batch size.

## Deployment

Deploy the frontend and `bot-scanner`. No database migration is required.
