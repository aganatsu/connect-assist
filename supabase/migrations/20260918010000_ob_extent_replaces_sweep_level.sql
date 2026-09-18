-- The zone is the proximal HALF of the base, not its bodies.
--
-- Measured off two hand-drawn AUD/USD daily boxes using TradingView's own
-- coordinates — both directions, four edges, every one within 1.4 pips:
--
--   supply 19 Mar   low  0.70007 / 50% 0.70548    box 0.70002 / 0.70534
--   demand 30 Mar   high 0.68758 / 50% 0.685525   box 0.68761 / 0.68549
--
-- The 30 March high was PREDICTED at 0.68761 from the drawn box and came back
-- 0.68758 from the raw candle, so the rule was derived rather than fitted.
--
-- This replaces a body-based rule inferred from a single zoomed screenshot of
-- one box on one side, generalised further than that evidence supported.
--
-- sweep_level becomes extent, and it is not a rename of convenience — the
-- meaning changed:
--
--   before   sweep_level  a wick marker OUTSIDE a body-bounded zone
--   after    extent       the far wick extreme, and the INVALIDATION level
--
-- distal is now the midpoint, so closing past it is deep mitigation rather
-- than death. Invalidating there would kill zones roughly twice as fast as the
-- reference charts show, which is why acceptance is measured against extent.
--
-- Existing rows carry body-rule geometry and cannot be converted — the wick
-- extremes they would need were never stored. They are deleted rather than
-- left to be compared against new rows measured a different way.

ALTER TABLE public.structural_order_blocks_v2
  RENAME COLUMN sweep_level TO extent;

COMMENT ON COLUMN public.structural_order_blocks_v2.extent IS
  'Far wick extreme of the base. Price closing beyond this invalidates the '
  'block. NOT beyond distal, which is only the 50% of the base range and marks '
  'the far edge of the tradeable half.';

COMMENT ON COLUMN public.structural_order_blocks_v2.distal IS
  'The 50% of the base''s full wick range — far edge of the tradeable zone, '
  'not the invalidation level. See extent.';

COMMENT ON COLUMN public.structural_order_blocks_v2.proximal IS
  'The wick extreme price meets first: the base high for a bullish block, the '
  'base low for a bearish one.';

-- Blocks stored under the body rule describe a different shape at the same
-- prices. Keeping them would silently mix two geometries in every comparison.
--
-- structural_order_block_trades.block_id is ON DELETE CASCADE, so the
-- proximity-attribution rows go with them. That is correct rather than
-- collateral: entry_inside_block and entry_distance_from_block were computed
-- against boundaries that have just been disproved, so those measurements are
-- wrong, not merely orphaned.
DELETE FROM public.structural_order_blocks_v2;
