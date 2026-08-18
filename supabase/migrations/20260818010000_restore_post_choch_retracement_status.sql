-- Restore post-CHoCH plans that the legacy five-minute pending monitor
-- reset to the original-zone waiting state. The one-minute confirmation scanner
-- is the sole owner after the first zone touch.
UPDATE public.pending_orders
SET status = $s$awaiting_confirmation$s$,
    resolved_at = NULL
WHERE status = $s$pending$s$
  AND post_confirmation_entry ->> $s$state$s$ IN (
    $s$awaiting_retracement$s$,
    $s$ready$s$
  )
  AND (expires_at IS NULL OR expires_at > now());
