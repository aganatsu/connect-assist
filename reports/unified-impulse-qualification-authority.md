# Unified Impulse Qualification Authority

Status: implemented on 2026-08-10.

## Ownership

The Impulse Zone Engine is the only module that selects a structural leg and decides whether it is a qualified impulse. The canonical impulse module is metrics-only and cannot select a competing leg.

## States

- `developing`: structure exists but BOS, displacement, body strength, recency, or POI evidence is incomplete.
- `qualified`: close-based BOS, protected origin, ATR range, directional displacement, body strength, recency, and FVG/OB evidence pass.
- `invalidated`: the protected origin was broken by a later close.

Only `qualified` impulses may proceed to zone ranking and entry authorization.

## Runtime parity

The same contract is consumed by the live scanner, backtest engine, cascade zone engine, multi-timeframe zone engine, Watchlist frozen context, and Zone Story UI.

## Configuration ownership

Qualification reuses existing Bot Config controls:

- Zone displacement ATR
- OB body strength
- Zone maximum age
- Canonical structure ownership

No second impulse mode or duplicate detector was added.

## Verification

- Supabase: 2,971 tests passed
- Frontend: 141 tests passed
- Production build passed
