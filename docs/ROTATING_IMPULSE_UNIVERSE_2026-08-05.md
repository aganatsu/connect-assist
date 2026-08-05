# Rotating Impulse Universe - 2026-08-05

## Purpose

Cover a large configured instrument universe while limiting full Gameplan, Impulse Zone, liquidity, confirmation, and entry analysis to a bounded batch per scan cycle.

## Runtime rules

1. Bot Config contains the complete eligible universe and an active-slot count (default 8).
2. The first cycle selects never-scanned pairs in configured order.
3. A pair with a valid Impulse Zone remains pinned and is rescanned next cycle.
4. A pair without an Impulse Zone releases its slot after the cycle.
5. The next cycle fills released slots with never-scanned pairs first, then the least-recently-scanned pairs.
6. Provider and insufficient-data failures are recorded as `data_error`, never as `no_impulse`; they re-enter the fair rotation later.
7. Gameplan generation and deep candle fetching use only the selected batch.
8. Rotation state is persisted per user and bot in `kv_cache` for 90 days.

## Observability

Every scan log includes `impulseRotation` with the universe size, slot count, selected pairs, pinned pairs, and discovery pairs. `pairs_scanned` reports the actual selected batch size.

## Deployment

Deploy the frontend and `bot-scanner`. No database migration is required.
