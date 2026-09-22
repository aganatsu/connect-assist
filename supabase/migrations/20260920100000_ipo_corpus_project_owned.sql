-- The IPO corpus becomes PROJECT-OWNED research data.
--
-- WHY. ipo_corpus_examples was modelled on ezzy_labelled_examples, which is
-- per-user: each account labels its own candles and RLS keeps them apart. The
-- IPO corpus is not that. It is the canonical record of what the teaching
-- material demonstrates — one set of facts about the method, identical for
-- everyone, and the thing detector coverage is measured against. Keyed by
-- user_id it could hold two contradictory versions of the same demonstration
-- and report different coverage depending on who asked.
--
-- Done NOW because the table is still empty (verified: 0 rows before this
-- migration). After the first corpus load, dropping the ownership column would
-- mean rewriting real rows and re-deriving their unique keys.
--
-- WHAT IS PRESERVED. Every other column, every check constraint, the
-- parent/child self-reference, example_group_id chains, positive-only semantics
-- (there is still no label column) and all TypeScript validation. Only the
-- ownership dimension is removed.
--
-- ACCESS MODEL AFTER THIS MIGRATION.
--   RLS stays ENABLED with no policy for anon or authenticated, so neither can
--   read or write a row through PostgREST. Their table grants are also revoked,
--   because RLS and grants fail differently: a future policy added for some
--   other purpose should not silently hand back access that was never intended.
--   service_role bypasses RLS and is used only inside the edge function, behind
--   a research-key check. No client ever reaches this table directly.

-- The old policy names user_id, so it must go before the column does.
DROP POLICY IF EXISTS "Users manage own ipo corpus examples" ON public.ipo_corpus_examples;

-- Dropping the column takes its FK and the composite unique with it.
ALTER TABLE public.ipo_corpus_examples
  DROP CONSTRAINT IF EXISTS ice_unique_example;
DROP INDEX IF EXISTS public.idx_ice_group;
DROP INDEX IF EXISTS public.idx_ice_symbol_tf;
ALTER TABLE public.ipo_corpus_examples
  DROP COLUMN IF EXISTS user_id;

-- One demonstration per bar per direction, project-wide.
--
-- NULLS NOT DISTINCT (PG15+; this project runs 17.6) is what makes the nullable
-- candle_datetime deduplicate. Under the default NULLS DISTINCT an example with
-- an unrecoverable bar could be inserted without limit and the "unique" index
-- would permit it silently. The constraint must also be NON-PARTIAL: PostgREST
-- infers on_conflict from the column list, and a partial index is not
-- inferable, so the upsert would fail at runtime rather than at deploy.
ALTER TABLE public.ipo_corpus_examples
  ADD CONSTRAINT ice_unique_example
  UNIQUE NULLS NOT DISTINCT (symbol, timeframe, candle_datetime, direction);

CREATE INDEX IF NOT EXISTS idx_ice_group ON public.ipo_corpus_examples (example_group_id);
CREATE INDEX IF NOT EXISTS idx_ice_symbol_tf ON public.ipo_corpus_examples (symbol, timeframe);

-- RLS on, no policies: PostgREST callers get nothing, whatever their JWT says.
ALTER TABLE public.ipo_corpus_examples ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ipo_corpus_examples FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.ipo_corpus_examples FROM anon, authenticated;
GRANT ALL ON public.ipo_corpus_examples TO service_role;

COMMENT ON TABLE public.ipo_corpus_examples IS
  'PROJECT-OWNED canonical corpus of demonstrated IPOs from teaching material. '
  'Not per-user: there is exactly one record of what was demonstrated, and '
  'detector coverage is measured against it. POSITIVES ONLY — there is no label '
  'column, so a negative cannot be recorded or inferred from an unmarked candle. '
  'No client reaches this table: RLS is enabled with no anon/authenticated '
  'policy and their grants are revoked. Access is service_role only, from the '
  'smc-analysis edge function, behind an X-IPO-Research-Key check. Nothing reads '
  'this for trading.';
