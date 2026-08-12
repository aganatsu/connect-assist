-- Candidate uniqueness applies to ACTIVE pending orders only.
--
-- Prerequisite for pre-arming zone setups. See
-- docs/PENDING_ORDER_PREARMING_PLAN.md — this is step 2, and it must land
-- BEFORE step 3 populates candidate_id.
--
-- The existing index spans every status:
--
--   CREATE UNIQUE INDEX idx_pending_orders_candidate
--     ON public.pending_orders (user_id, bot_id, candidate_id)
--     WHERE candidate_id IS NOT NULL;
--
-- Today that is dormant: only 30 of 1,325 rows carry a candidate_id, which is
-- why 511 supersede cancel-and-reinsert cycles succeeded without ever tripping
-- it. The moment step 3 populates identity, a cancelled or expired row owns
-- that candidate_id permanently, and the legitimate supersede path from #318
-- starts failing with a CONSTRAINT VIOLATION rather than a cancellation — a
-- failure that would appear to be a regression in #318 rather than a schema
-- problem.
--
-- Same for expiry: a candidate whose order expired could never be re-armed,
-- because the expired row still holds the key.
--
-- Terminal rows are history. They must not reserve identity.
--
-- This is a no-op while candidate_id is almost entirely null, which is exactly
-- why it is safe to do first and unsafe to do later.
--
-- Status vocabulary (pending_orders_status_check): pending,
-- awaiting_confirmation, filled, invalidated, expired, cancelled.
-- Active = pending, awaiting_confirmation — matching the predicate already used
-- by idx_pending_orders_unique_active, so both partial indexes agree on what
-- "active" means.
--
-- NOTE for step 3/4: paper_positions.candidate_id is unique across ALL statuses,
-- so one candidate can only ever produce one position. A candidate that already
-- filled must therefore be re-detected as a NEW lifecycle candidate (the
-- explicit handoff), not re-armed under the old id — otherwise it would arm a
-- pending order that can never become a position.

DROP INDEX IF EXISTS public.idx_pending_orders_candidate;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_orders_candidate_active
  ON public.pending_orders (user_id, bot_id, candidate_id)
  WHERE candidate_id IS NOT NULL
    AND status IN ('pending', 'awaiting_confirmation');

COMMENT ON INDEX public.idx_pending_orders_candidate_active IS
  'One active pending order per lifecycle candidate. Deliberately excludes terminal statuses so a cancelled or expired candidate does not permanently reserve its identity — see docs/PENDING_ORDER_PREARMING_PLAN.md step 2.';

-- staged_setups has the same problem and the same fix. Its candidate index has
-- no status predicate at all, so a candidate whose watchlist row expired could
-- never be staged again.
DROP INDEX IF EXISTS public.idx_staged_setups_candidate;

CREATE UNIQUE INDEX IF NOT EXISTS idx_staged_setups_candidate_active
  ON public.staged_setups (user_id, bot_id, candidate_id)
  WHERE status IN ('watching', 'qualified', 'pending', 'awaiting_confirmation');

COMMENT ON INDEX public.idx_staged_setups_candidate_active IS
  'One active watchlist row per lifecycle candidate. Terminal rows (filled, expired, invalidated, cancelled, blocked_after_qualification, promoted) are history and do not reserve identity.';
