-- Record the link when one lifecycle candidate replaces another.
--
-- Step 4 of docs/PENDING_ORDER_PREARMING_PLAN.md.
--
-- When a setup materially changes — entry, stop, target or score moved beyond
-- tolerance — it is a NEW trading opportunity, not the old one edited. #318
-- already makes that distinction via shouldSupersedePendingOrder(); what is
-- missing is the record of it.
--
-- Without the link, a superseded candidate simply disappears and its successor
-- appears unrelated. That matters more than it sounds: measured 2026-08-12,
-- only 7 of 30 pending orders carrying a candidate_id could be matched back to
-- a watchlist row — 23 had forked identities. #322 stops new forks; this makes
-- the deliberate replacements distinguishable from the accidental ones.
--
-- An unchanged setup is NOT a handoff. #318 leaves those orders in place
-- untouched, so no row is written and the identity simply continues.

ALTER TABLE public.pending_orders
  ADD COLUMN IF NOT EXISTS superseded_candidate_id TEXT,
  ADD COLUMN IF NOT EXISTS handoff_reason TEXT;

COMMENT ON COLUMN public.pending_orders.superseded_candidate_id IS
  'Lifecycle candidate this order replaced after a material change. NULL for the first candidate in a chain and for orders that were never a replacement.';
COMMENT ON COLUMN public.pending_orders.handoff_reason IS
  'Why the predecessor was superseded, from shouldSupersedePendingOrder(): entry moved, stop moved, target moved, score changed materially.';

-- Walk a handoff chain backwards, or find every successor of a candidate.
CREATE INDEX IF NOT EXISTS idx_pending_orders_superseded_candidate
  ON public.pending_orders (user_id, bot_id, superseded_candidate_id)
  WHERE superseded_candidate_id IS NOT NULL;
