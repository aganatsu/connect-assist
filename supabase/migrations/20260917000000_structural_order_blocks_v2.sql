-- Structural order blocks (V2) — shadow mode storage.
--
-- Separate table from anything the legacy detector touches, deliberately. V2
-- runs beside detectOrderBlocks and nothing consumes it: it detects, scores,
-- and stores so its zones can be compared against the reference charts before
-- any part of the system acts on them.
--
-- Two things this table does NOT do, learned the hard way on 2026-09-16:
--
--   * It reuses no existing column. Writing a new record shape into a column
--     that already had a contract (frozen_strategy_context,
--     streamlined_decision_origin) cost a day and destroyed trades, because
--     BEFORE INSERT triggers refused the row and the callers swallowed the
--     error.
--   * It carries no trigger of its own. Validation stays in TypeScript, where
--     a failure is visible in a test rather than at 3am in a scan log.
--
-- Identity is the natural key (symbol, timeframe, direction, origin_time), so
-- a rescan UPSERTS the same block rather than duplicating it. The detector is
-- deterministic from candles, so re-running a scan reproduces the same row.

CREATE TABLE IF NOT EXISTS public.structural_order_blocks_v2 (
  id                        text PRIMARY KEY,
  user_id                   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bot_id                    text,

  symbol                    text NOT NULL,
  timeframe                 text NOT NULL,
  direction                 text NOT NULL,

  -- Geometry. Bodies only; the wick extreme is a separate marker, not an edge.
  proximal                  numeric(20,8) NOT NULL,
  distal                    numeric(20,8) NOT NULL,
  sweep_level               numeric(20,8),

  base_start_index          integer,
  base_end_index            integer,
  base_candle_count         integer,
  confirmed_index           integer,
  origin_time               text NOT NULL,
  confirmed_time            text,

  significance              text,

  displacement_atr_multiple numeric(20,8),
  directional_body_ratio    numeric(10,6),
  directional_candle_ratio  numeric(10,6),
  path_efficiency           numeric(10,6),
  base_compactness_atr      numeric(10,6),

  touches                   integer NOT NULL DEFAULT 0,
  max_penetration_percent   numeric(6,2) NOT NULL DEFAULT 0,
  mitigation_band           text,
  first_touch_index         integer,
  last_touch_index          integer,

  status                    text NOT NULL,
  invalidation_count        integer NOT NULL DEFAULT 0,
  invalidated_index         integer,

  score                     integer NOT NULL DEFAULT 0,
  score_breakdown           jsonb,
  -- Factors that could not be evaluated. Absent from score_breakdown rather
  -- than recorded as 0 — an unmeasured factor must never read as a measured
  -- zero, which is the failure mode this repo keeps producing.
  score_unavailable         text[],

  -- Proximity attribution. Correlational ONLY: V2 drives no entries yet, so a
  -- trade was never caused by one of these blocks. Set to 'causal' if and when
  -- V2 feeds the entry engine.
  outcome_attribution       text NOT NULL DEFAULT 'proximity',

  first_seen_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.structural_order_blocks_v2
  ADD CONSTRAINT sob_v2_direction_check CHECK (direction IN ('bullish','bearish'));
ALTER TABLE public.structural_order_blocks_v2
  ADD CONSTRAINT sob_v2_timeframe_check CHECK (timeframe IN ('D','4H','1H'));
ALTER TABLE public.structural_order_blocks_v2
  ADD CONSTRAINT sob_v2_status_check CHECK (status IN
    ('CANDIDATE','NEW','ACTIVE','MITIGATED','OLD','INVALIDATED'));
ALTER TABLE public.structural_order_blocks_v2
  ADD CONSTRAINT sob_v2_significance_check CHECK (significance IS NULL OR significance IN ('internal','external'));
ALTER TABLE public.structural_order_blocks_v2
  ADD CONSTRAINT sob_v2_band_check CHECK (mitigation_band IS NULL OR mitigation_band IN
    ('none','shallow','normal','deep','near_complete'));
ALTER TABLE public.structural_order_blocks_v2
  ADD CONSTRAINT sob_v2_attribution_check CHECK (outcome_attribution IN ('proximity','causal'));

CREATE INDEX IF NOT EXISTS idx_sob_v2_user_symbol
  ON public.structural_order_blocks_v2 (user_id, symbol, timeframe);
CREATE INDEX IF NOT EXISTS idx_sob_v2_status
  ON public.structural_order_blocks_v2 (user_id, status) WHERE status <> 'INVALIDATED';
CREATE INDEX IF NOT EXISTS idx_sob_v2_seen
  ON public.structural_order_blocks_v2 (user_id, last_seen_at DESC);

-- Trades associated with a block by PROXIMITY, not causation. Kept in its own
-- table so one trade can match several blocks for analysis while exactly one
-- is flagged primary.
CREATE TABLE IF NOT EXISTS public.structural_order_block_trades (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  block_id                  text NOT NULL REFERENCES public.structural_order_blocks_v2(id) ON DELETE CASCADE,
  position_id               text NOT NULL,

  entry_inside_block        boolean NOT NULL,
  entry_distance_from_block numeric(20,8),
  is_primary_match          boolean NOT NULL DEFAULT false,

  trade_result_r            numeric(10,4),
  trade_result_pnl          numeric(20,8),
  attribution               text NOT NULL DEFAULT 'proximity',

  created_at                timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.structural_order_block_trades
  ADD CONSTRAINT sobt_attribution_check CHECK (attribution IN ('proximity','causal'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_sobt_block_position
  ON public.structural_order_block_trades (block_id, position_id);
CREATE INDEX IF NOT EXISTS idx_sobt_primary
  ON public.structural_order_block_trades (user_id, position_id) WHERE is_primary_match;

ALTER TABLE public.structural_order_blocks_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.structural_order_block_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own structural order blocks"
  ON public.structural_order_blocks_v2 AS PERMISSIVE FOR ALL TO public
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users manage own structural order block trades"
  ON public.structural_order_block_trades AS PERMISSIVE FOR ALL TO public
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.structural_order_blocks_v2 IS
  'V2 structure-first order blocks, SHADOW MODE. Nothing consumes these; they '
  'are detected, scored and stored for comparison against the legacy detector '
  'and the reference charts. Displaying them is allowed, acting on them is not.';
COMMENT ON COLUMN public.structural_order_blocks_v2.sweep_level IS
  'Wick extreme of the base. OUTSIDE the zone by design: a wick through it that '
  'closes back inside is a liquidity sweep, whereas a body close beyond distal '
  'is acceptance. Zone edges are bodies only.';
COMMENT ON COLUMN public.structural_order_blocks_v2.score_unavailable IS
  'Factors with no input available this scan. They are omitted from '
  'score_breakdown rather than scored 0, so a low score cannot be confused '
  'with a measured-bad block.';
