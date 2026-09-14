-- Shared API credit budget.
--
-- The TwelveData limiter in candleSource.ts is a module-level array, so it
-- exists once per Edge Function ISOLATE. bot-scanner, the every-minute manage
-- loop, zone-confirmation-scanner and paper-trading each politely stay under
-- their own 50/minute while collectively blowing far past the plan's 55.
--
-- Measured 2026-08-11: 75 credits/min average, 371 peak, 100% of quota, and the
-- bot's own throttle counter reading 0 the entire time. Six concurrent isolates
-- x 50 = 300/min permitted, which is close to the observed peak. Requests then
-- 429, twelveDataCandles returns [], the 30-candle floor fails, Polygon has no
-- key, and the pair is skipped with "Insufficient candles (0, need 20)" —
-- 44% of pair-scans.
--
-- One row per credit consumed. Counting rows inside the window is exact and
-- needs no reconciliation, and at ~55/minute the table stays tiny.

CREATE TABLE IF NOT EXISTS public.api_credit_usage (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only query shape: "how many for this provider since T".
CREATE INDEX IF NOT EXISTS api_credit_usage_provider_time
  ON public.api_credit_usage (provider, reserved_at DESC);

ALTER TABLE public.api_credit_usage ENABLE ROW LEVEL SECURITY;

-- Infrastructure accounting, not user data: service role only. No policy for
-- authenticated, so the table is invisible to the client.
DROP POLICY IF EXISTS "Service role manages api credit usage" ON public.api_credit_usage;
CREATE POLICY "Service role manages api credit usage"
  ON public.api_credit_usage FOR ALL TO service_role
  USING (true) WITH CHECK (true);

/**
 * Reserve one credit, or refuse.
 *
 * Count-then-insert races between concurrent isolates — which is the entire
 * problem being solved — so reservations are serialised per provider with a
 * transaction-scoped advisory lock. It is held only for the count and insert.
 *
 * Returns TRUE when the caller may proceed.
 */
CREATE OR REPLACE FUNCTION public.reserve_api_credit(
  p_provider TEXT,
  p_limit INT,
  p_window_seconds INT DEFAULT 60
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  used INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('api_credit:' || p_provider));

  -- Keep the table small. Two windows of history is plenty for debugging.
  DELETE FROM public.api_credit_usage
   WHERE provider = p_provider
     AND reserved_at < now() - make_interval(secs => p_window_seconds * 2);

  SELECT count(*) INTO used
    FROM public.api_credit_usage
   WHERE provider = p_provider
     AND reserved_at > now() - make_interval(secs => p_window_seconds);

  IF used >= p_limit THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.api_credit_usage (provider) VALUES (p_provider);
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_api_credit(TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_api_credit(TEXT, INT, INT) TO service_role;
