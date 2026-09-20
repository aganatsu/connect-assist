-- Corpus of DEMONSTRATED IPOs — positives only, by construction.
--
-- WHY A SECOND TABLE. ezzy_labelled_examples exists to hold POSITIVE, NEGATIVE
-- and UNKNOWN labels for selector research. This table holds something
-- different: every IPO clearly marked green in the teaching material, recorded
-- so detector COVERAGE can be measured against it. Overloading the first table
-- would have meant adding refinement-chain columns that mean nothing for a
-- NEGATIVE row, and adding a label column here that must never be used.
--
-- THERE IS NO LABEL COLUMN, AND THAT IS THE POINT. Every row is a demonstrated
-- positive. A candle absent from this table is unexamined, not rejected, so
-- there is no place to write a negative and no way to infer one. The evaluation
-- layer computes coverage only — no precision, no false-positive rate — because
-- the negatives required for those numbers do not exist and must not be
-- invented from unmarked candles.
--
-- CORRELATED DEMONSTRATIONS. A Weekly -> Daily -> 4H refinement of one move is
-- ONE demonstration shown at three scales. example_group_id ties those rows
-- together and parent_example_id records the refinement edge, so the primary
-- coverage figure can count the group once. Without this, three rows drawn from
-- a single clip would read as three independent confirmations and inflate the
-- headline threefold.
--
-- Its own table, no trigger. Validation stays in TypeScript, where a failure is
-- visible in a test rather than swallowed by a caller — the failure mode that
-- destroyed closed trades on 2026-09-16.
--
-- NOTHING READS THIS FOR TRADING. Research data only.

CREATE TABLE IF NOT EXISTS public.ipo_corpus_examples (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- provenance of the demonstration itself
  evidence_source        text NOT NULL DEFAULT 'VIDEO_DEMONSTRATION',
  source_video           text,          -- title / URL of the clip
  source_timestamp       text,          -- position within the clip, e.g. "12:04"
  reference_url          text,          -- screenshot or chart image

  symbol                 text NOT NULL,
  timeframe              text NOT NULL,
  candle_datetime        text,          -- null when the exact bar is unrecoverable
  direction              text NOT NULL, -- demand | supply

  -- Zone bounds AS DRAWN in the demonstration, when readable. Left null when
  -- they are not; the evaluator reports NOT_DEMONSTRATED rather than treating a
  -- missing value as agreement with whatever the detector produced.
  demonstrated_zone_low  double precision,
  demonstrated_zone_high double precision,

  -- correlated refinement chain
  example_group_id       uuid,          -- one demonstration, however many scales
  parent_example_id      uuid REFERENCES public.ipo_corpus_examples(id) ON DELETE SET NULL,

  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ipo_corpus_examples
  ADD CONSTRAINT ice_direction_check CHECK (direction IN ('demand','supply'));

-- The four provenance sources. OPERATIONAL_INTERPRETATION is permitted so a row
-- reconstructed rather than read directly off the chart cannot masquerade as a
-- demonstration.
ALTER TABLE public.ipo_corpus_examples
  ADD CONSTRAINT ice_evidence_check CHECK (evidence_source IN
    ('DIRECT_TEACHING','USER_CONFIRMED','VIDEO_DEMONSTRATION','OPERATIONAL_INTERPRETATION'));

-- Both bounds or neither. One bound alone cannot be compared to a zone and
-- would silently evaluate as a mismatch on the missing side.
ALTER TABLE public.ipo_corpus_examples
  ADD CONSTRAINT ice_zone_bounds_paired CHECK (
    (demonstrated_zone_low IS NULL) = (demonstrated_zone_high IS NULL));
ALTER TABLE public.ipo_corpus_examples
  ADD CONSTRAINT ice_zone_bounds_ordered CHECK (
    demonstrated_zone_low IS NULL OR demonstrated_zone_low < demonstrated_zone_high);

-- A row cannot be its own parent. Deeper cycles are prevented in TypeScript,
-- where the chain is walked and the error is testable.
ALTER TABLE public.ipo_corpus_examples
  ADD CONSTRAINT ice_no_self_parent CHECK (parent_example_id IS NULL OR parent_example_id <> id);

-- A child in a refinement chain belongs to the same demonstration as its parent,
-- so it must carry a group. Enforced in TypeScript against the parent row.
ALTER TABLE public.ipo_corpus_examples
  ADD CONSTRAINT ice_child_has_group CHECK (parent_example_id IS NULL OR example_group_id IS NOT NULL);

-- Conflict target for upserts. NON-PARTIAL, and NULLS NOT DISTINCT (PG15+; this
-- project runs 17.6) so a row with an unrecoverable candle_datetime still
-- deduplicates instead of being insertable without limit. PostgREST infers
-- on_conflict from the column list, and a partial index is not inferable, so a
-- partial index here would fail at runtime rather than at deploy.
ALTER TABLE public.ipo_corpus_examples
  ADD CONSTRAINT ice_unique_example
  UNIQUE NULLS NOT DISTINCT (user_id, symbol, timeframe, candle_datetime, direction);

CREATE INDEX IF NOT EXISTS idx_ice_group ON public.ipo_corpus_examples (user_id, example_group_id);
CREATE INDEX IF NOT EXISTS idx_ice_symbol_tf ON public.ipo_corpus_examples (user_id, symbol, timeframe);

ALTER TABLE public.ipo_corpus_examples ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own ipo corpus examples"
  ON public.ipo_corpus_examples AS PERMISSIVE FOR ALL TO public
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.ipo_corpus_examples IS
  'Demonstrated IPOs from teaching material. POSITIVES ONLY — there is no label '
  'column, so a negative cannot be recorded or inferred from an unmarked candle. '
  'Used to measure detector COVERAGE; no precision or false-positive rate is '
  'derivable from it. Nothing reads this for trading.';
COMMENT ON COLUMN public.ipo_corpus_examples.example_group_id IS
  'One demonstration shown at several timeframes. A Weekly->Daily->4H refinement '
  'is ONE correlated demonstration, not three independent confirmations, and the '
  'primary coverage metric counts the group once.';
COMMENT ON COLUMN public.ipo_corpus_examples.demonstrated_zone_low IS
  'Zone bound as drawn in the demonstration. Null means unrecorded, which the '
  'evaluator reports as NOT_DEMONSTRATED rather than as agreement.';
