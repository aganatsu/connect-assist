# Post-CHoCH Retracement Entry

## Authority flow

`HTF bias -> frozen impulse -> frozen parent zone -> liquidity interaction ->
candidate-owned CHoCH -> frozen confirmation FVG/OB -> fill authorization`

The confirmation entry zone refines execution only. It cannot replace the
impulse, change direction, create another Watchlist item, or survive its
candidate's protected-pivot failure.

## Modes

- `confirmation_close`: existing behavior; fill at the confirmation close.
- `observe_retracement`: record the deterministic FVG/OB plan and keep the
  existing fill behavior.
- `wait_retracement`: persist the plan and fill only after its first touch.

Existing accounts default to `confirmation_close`.

## Zone priority

1. CHoCH displacement FVG overlapping its micro order block.
2. CHoCH displacement FVG.
3. Last opposing micro order block.
4. Narrow band around the displacement leg's 50% level.

## Invalidation

- Parent impulse invalidation remains terminal.
- A close through the frozen CHoCH protected pivot invalidates the plan.
- An untouched plan expires after the configured retracement window.
- Final thesis, premium/discount, risk, duplicate, spread and broker gates run
  again at the actual retracement fill.
