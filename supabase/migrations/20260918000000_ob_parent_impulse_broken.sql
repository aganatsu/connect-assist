-- An order block outlives the impulse that created it.
--
-- V2 inherited findImpulseLeg's validity rule: a leg is discarded once price
-- retraces past its origin. That is the right answer to "would I trade this
-- impulse now" and the wrong answer to "does this zone still exist".
--
-- Worked example from the AUD/USD daily reference chart. A bearish move began
-- in late March and produced a supply zone at 0.70584 -> 0.70000. In May price
-- rallied above where that move started, so the leg was marked dead and the
-- zone with it — while the hand-drawn chart still carries that box months
-- later, because price never accepted through the BOX.
--
-- The two lifetimes are now separate:
--   impulse validity  -> would I trade this leg right now?
--   block validity    -> does this price zone still exist?
--
-- parent_impulse_broken records the first without acting on it. A parent
-- impulse must not retroactively delete its child zone; only the block's own
-- invalidation rule (consecutive body closes through distal) can.

ALTER TABLE public.structural_order_blocks_v2
  ADD COLUMN IF NOT EXISTS parent_impulse_broken boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.structural_order_blocks_v2.parent_impulse_broken IS
  'Price has since retraced past the origin of the impulse that created this '
  'block. Metadata only — the block remains valid until its own distal '
  'boundary is accepted through. Useful for asking whether zones from undone '
  'impulses perform differently, which is not yet known.';

CREATE INDEX IF NOT EXISTS idx_sob_v2_parent_broken
  ON public.structural_order_blocks_v2 (user_id, parent_impulse_broken)
  WHERE parent_impulse_broken;
