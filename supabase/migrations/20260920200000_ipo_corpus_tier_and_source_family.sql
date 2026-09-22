-- Confidence tier and source family for corpus rows. RESEARCH DATA ONLY.
--
-- WHY THIS EXISTS. Both facts were established by earlier audit work and then
-- written down nowhere. They lived in conversation history alone, and had to be
-- recovered by grepping a session transcript on 2026-09-20. Until now the table
-- could not answer the two questions that decide whether a row may be used:
--
--   "can anyone still go and look at the source?"   -> confidence_tier
--   "whose demonstration is this?"                  -> source_family
--
-- NEITHER IS DERIVABLE FROM evidence_source. That column says what KIND of
-- claim a row is. A VIDEO_DEMONSTRATION whose file no longer exists on disk is
-- still a video demonstration, but nothing can be checked against it. And both
-- an Ezzy row and the user's own independent judgment can carry the same
-- evidence_source, so folding teacher identity into it would let one teacher's
-- corpus be padded with the user's own trading calls — an error made once
-- already and explicitly corrected.
--
-- BOTH ARE NULLABLE, AND NULL MEANS NOT ESTABLISHED. A row whose tier or
-- teacher has never been determined must be storable as unknown. Null must
-- never be read as "probably Tier 1" or "probably Ezzy"; the CHECK constraints
-- reject wrong values precisely so a stored value can be trusted as a finding.
--
-- NOTHING READS THIS FOR TRADING. No production code path is affected.

ALTER TABLE public.ipo_corpus_examples
  ADD COLUMN IF NOT EXISTS confidence_tier text,
  ADD COLUMN IF NOT EXISTS source_family   text;

DO $$ BEGIN
  ALTER TABLE public.ipo_corpus_examples
    ADD CONSTRAINT ice_confidence_tier_check CHECK (confidence_tier IS NULL OR confidence_tier IN (
      'TIER_1_DIRECTLY_INSPECTABLE',
      'TIER_2_DERIVED_FROM_INSPECTABLE_SOURCE',
      'TIER_3_UNINSPECTABLE_LEGACY'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- TUBEPULL_UNKNOWN_SOURCE is its own family rather than "unattributed": the
-- material exists and is usable, but it has NOT been shown to come from the
-- same teacher, so it must never be pooled with EZZY when validating or
-- invalidating Ezzy's rules.
DO $$ BEGIN
  ALTER TABLE public.ipo_corpus_examples
    ADD CONSTRAINT ice_source_family_check CHECK (source_family IS NULL OR source_family IN (
      'EZZY',
      'TUBEPULL_UNKNOWN_SOURCE',
      'USER_INDEPENDENT'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.ipo_corpus_examples.confidence_tier IS
  'Whether the demonstration can still be re-checked against its own source. '
  'NULL = not established. TIER_3 rows must not be used to propose a rule.';
COMMENT ON COLUMN public.ipo_corpus_examples.source_family IS
  'Which teacher/source the demonstration came from. NULL = not yet attributed, '
  'never "probably EZZY".';

-- ── Backfill of assignments already established by audit ────────────────────
-- Keyed on the natural key (symbol, timeframe, candle_datetime, direction).
-- Only rows whose tier was actually determined are touched; anything else is
-- deliberately left NULL rather than guessed.

-- Tier 1: source frame directly inspectable. 1d 2020-05-11 and 4h 2020-05-11
-- 16:00 were TIER_2 until independent pixel measurement raised them.
UPDATE public.ipo_corpus_examples SET confidence_tier = 'TIER_1_DIRECTLY_INSPECTABLE', source_family = 'EZZY'
 WHERE symbol = 'BTC/USD' AND (
   (timeframe = '1d' AND candle_datetime = '2020-04-20T00:00:00Z' AND direction = 'demand') OR
   (timeframe = '4h' AND candle_datetime = '2020-05-08T16:00:00Z' AND direction = 'supply') OR
   (timeframe = '1d' AND candle_datetime = '2020-05-11T00:00:00Z' AND direction = 'demand') OR
   (timeframe = '4h' AND candle_datetime = '2020-05-11T16:00:00Z' AND direction = 'demand'));

-- Tier 3: no source file matching the label exists on disk, so the marked
-- candle cannot be re-verified. 2020-04-08 additionally has no containing
-- structural leg, so no origin rule can score it at all.
UPDATE public.ipo_corpus_examples SET confidence_tier = 'TIER_3_UNINSPECTABLE_LEGACY', source_family = 'EZZY'
 WHERE symbol = 'BTC/USD' AND timeframe = '1d' AND (
   (candle_datetime = '2020-03-27T00:00:00Z' AND direction = 'demand') OR
   (candle_datetime = '2020-04-08T00:00:00Z' AND direction = 'supply'));

-- The user's own trading judgments are a separate family and must not be
-- reclassified as Ezzy demonstrations. Their tier is left NULL: tier describes
-- inspectability of a recorded source, which is not what these rows are.
UPDATE public.ipo_corpus_examples SET source_family = 'USER_INDEPENDENT'
 WHERE evidence_source = 'USER_CONFIRMED' AND source_family IS NULL;
