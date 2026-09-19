-- Labelled Ezzy examples: POSITIVE / NEGATIVE / UNKNOWN.
--
-- WHY THIS EXISTS. Three candidate selector rules have now been eliminated the
-- same way: each looked strong on the ten labelled boxes and collapsed against
-- either a held-out set (BTC 0/3) or a background population (791 candidates,
-- ~18 per 100 bars, with the known six in the lower third). The common cause is
-- ten labelled POSITIVES and zero labelled NEGATIVES. Without examples that
-- were explicitly rejected, "what makes a box" cannot be answered — every
-- measurement so far has compared known boxes against unexamined candles.
--
-- UNKNOWN IS NOT NEGATIVE, and the constraint below keeps that honest. An
-- unboxed candle is one nobody evaluated, not one that was turned down.
-- Conflating them is precisely the error the earlier diagnostics avoided by
-- naming their pool "comparison" rather than "negative", and it must not be
-- reintroduced through the labelling schema.
--
-- Its own table, no trigger. Reusing an existing column for a new record shape
-- cost a day and destroyed closed trades on 2026-09-16 when BEFORE INSERT
-- triggers refused the rows and the callers swallowed the error. Validation
-- stays in TypeScript where a failure is visible in a test.
--
-- NOTHING READS THIS FOR TRADING. It is research data only.

CREATE TABLE IF NOT EXISTS public.ezzy_labelled_examples (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- provenance
  source_video       text,          -- title / URL of the clip
  source_timestamp   text,          -- position within the clip, e.g. "12:04"
  reference_url      text,          -- screenshot or chart image

  symbol             text NOT NULL,
  timeframe          text NOT NULL,
  candle_datetime    text,          -- null when the exact bar is not recoverable
  side               text,          -- demand | supply | null for UNKNOWN

  label              text NOT NULL, -- POSITIVE | NEGATIVE | UNKNOWN
  label_basis        text NOT NULL, -- explicit | inferred
  reason             text,          -- the teaching statement, verbatim where possible

  -- development vs reserved validation. Validation rows must not be inspected
  -- while rules are being chosen; the read path refuses to return them without
  -- an explicit unseal, so the discipline is structural rather than remembered.
  split              text NOT NULL DEFAULT 'development',

  -- Set true for data already examined diagnostically, so it cannot be reused
  -- as a clean holdout later. The three BTC 2020 boxes are contaminated: the
  -- 0/3 result stands as a recorded finding, but they have since been measured
  -- across many diagnostics and are no longer pristine.
  contaminated       boolean NOT NULL DEFAULT false,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ezzy_labelled_examples
  ADD CONSTRAINT ele_label_check CHECK (label IN ('POSITIVE','NEGATIVE','UNKNOWN'));
ALTER TABLE public.ezzy_labelled_examples
  ADD CONSTRAINT ele_basis_check CHECK (label_basis IN ('explicit','inferred'));
ALTER TABLE public.ezzy_labelled_examples
  ADD CONSTRAINT ele_split_check CHECK (split IN ('development','validation'));
ALTER TABLE public.ezzy_labelled_examples
  ADD CONSTRAINT ele_side_check CHECK (side IS NULL OR side IN ('demand','supply'));
-- A NEGATIVE must be explicit. An inferred rejection is an assumption about
-- what someone would have said, which is the exact failure this table exists
-- to prevent.
ALTER TABLE public.ezzy_labelled_examples
  ADD CONSTRAINT ele_negative_must_be_explicit
  CHECK (label <> 'NEGATIVE' OR label_basis = 'explicit');

CREATE UNIQUE INDEX IF NOT EXISTS idx_ele_unique_candle
  ON public.ezzy_labelled_examples (user_id, symbol, timeframe, candle_datetime, side)
  WHERE candle_datetime IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ele_label ON public.ezzy_labelled_examples (user_id, label, split);

ALTER TABLE public.ezzy_labelled_examples ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own ezzy labelled examples"
  ON public.ezzy_labelled_examples AS PERMISSIVE FOR ALL TO public
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

COMMENT ON TABLE public.ezzy_labelled_examples IS
  'Labelled Ezzy examples for selector research. UNKNOWN is NOT a negative — it '
  'means nobody evaluated that candle. Nothing reads this for trading. Target '
  'before further feature work: >=20 POSITIVE, >=15 explicit NEGATIVE, across FX '
  'and crypto and multiple timeframes, with >=5 of each reserved as validation.';
COMMENT ON COLUMN public.ezzy_labelled_examples.split IS
  'development | validation. Validation rows are reserved and must not be '
  'inspected while rules are chosen; the read path requires an explicit unseal.';
COMMENT ON COLUMN public.ezzy_labelled_examples.contaminated IS
  'Already examined diagnostically, so unusable as a clean holdout. True for the '
  'three BTC 2020 boxes: the 0/3 result stands, but the set is no longer pristine.';
