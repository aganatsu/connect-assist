-- Shadow telemetry for the canonical structure engine.
--
-- ANSWER TO "is structureShadow persisted?": it was NOT. Traced the full live
-- scanner path — bot-scanner/index.ts:4980 is the only production caller of
-- runConfluenceAnalysis, `structureShadow` appears zero times in that file,
-- and both scan_logs inserts build hand-picked objects that never touch the
-- analysis result. The diff was computed on every scan and discarded.
--
-- Its own table, deliberately. Reusing an existing column for a new record
-- shape cost a day and destroyed closed trades on 2026-09-16, because BEFORE
-- INSERT triggers refused the rows and the callers swallowed the error. So:
-- no reused column, and NO TRIGGER on this table. Validation stays in
-- TypeScript where a failure shows up in a test rather than at 3am.
--
-- Compact by design. No candles, no swing list, no ledger. One row is a
-- verdict, not a snapshot — the ledger runs to ~100 entries per symbol per
-- scan and would bury the signal while costing more than the comparison.
--
-- WRITE-ONLY FROM THE BOT'S PERSPECTIVE. No trading decision may read this.
-- The live engine stays authoritative; this records where the candidate
-- disagrees with it.

CREATE TABLE IF NOT EXISTS public.structure_shadow_telemetry (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id                    text,

  observed_at               timestamptz NOT NULL DEFAULT now(),
  symbol                    text NOT NULL,
  timeframe                 text,
  site                      text NOT NULL,
  bars                      integer,

  -- Policy that produced the canonical side, recorded per row so a later
  -- change of candidate cannot silently mix two populations.
  policy                    text NOT NULL,
  max_event_age_bars        integer,

  current_trend             text,
  canonical_trend           text,
  trend_agrees              boolean NOT NULL,

  latest_event_reason       text NOT NULL,
  latest_bos_reason         text NOT NULL,
  latest_choch_reason       text NOT NULL,

  -- Latest event under each engine. Nullable throughout: "no event" is a real
  -- and common state, and must not be confused with "not measured".
  current_index             integer,
  current_datetime          text,
  current_level             numeric(20,8),
  current_significance      text,
  current_type              text,

  canonical_index           integer,
  canonical_datetime        text,
  canonical_level           numeric(20,8),
  canonical_significance    text,
  canonical_type            text,
  canonical_bars_since_confirmation integer,

  current_bos_count         integer,
  current_choch_count       integer,
  canonical_bos_count       integer,
  canonical_choch_count     integer,
  canonical_ledger_entries  integer,
  canonical_ineligible_by_age integer
);

ALTER TABLE public.structure_shadow_telemetry
  ADD CONSTRAINT sst_reason_check CHECK (
    latest_event_reason IN ('same','current_missing','current_late','current_early','different_primary_level','different_BOS_CHoCH')
    AND latest_bos_reason IN ('same','current_missing','current_late','current_early','different_primary_level','different_BOS_CHoCH')
    AND latest_choch_reason IN ('same','current_missing','current_late','current_early','different_primary_level','different_BOS_CHoCH')
  );

CREATE INDEX IF NOT EXISTS idx_sst_user_time
  ON public.structure_shadow_telemetry (user_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sst_symbol
  ON public.structure_shadow_telemetry (user_id, symbol, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sst_reason
  ON public.structure_shadow_telemetry (user_id, latest_event_reason);

ALTER TABLE public.structure_shadow_telemetry ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own structure shadow telemetry"
  ON public.structure_shadow_telemetry AS PERMISSIVE FOR ALL TO public
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.structure_shadow_telemetry IS
  'Disagreements between the live structure engine and the canonical shadow '
  'candidate. Written only when STRUCTURE_CANONICAL_SHADOW=true AND at least '
  'one comparison disagrees — agreements are not recorded, so row count is a '
  'disagreement count and NOT a scan count. Nothing reads this; no trading '
  'decision may depend on it. Retention 30 days via data-cleanup.';
COMMENT ON COLUMN public.structure_shadow_telemetry.policy IS
  'Canonical policy for this row. Recorded per row so changing the candidate '
  'later cannot silently pool two different populations.';
