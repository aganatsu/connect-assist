-- Store OHLC as numeric, because double precision does not round-trip here.
--
-- WHY. The content digest is computed over the exact values the engine saw. A
-- JS double such as 1.001 + 2e-5 is 1.0010199999999998; stored as
-- `double precision` and read back through PostgREST it returns as 1.00102,
-- because float output is rendered at 15 significant digits and the final unit
-- in the last place is lost. Every reconstruction therefore differed from the
-- array production scored, in a way no amount of care elsewhere could fix:
--
--   orig  1.001019999999999 8 | 1.000519999999999 9
--   store 1.00102            | 1.00052
--
-- `numeric` is exact decimal: the value arrives as its shortest round-trip
-- decimal, is stored verbatim, and parses back to the identical double. The
-- cost is a few bytes per bar against a guarantee that a replay scores the
-- numbers production actually used — and at the margin of a zone boundary or a
-- stop, one ulp is the difference between a match and an unexplained divergence.
--
-- Safe to alter in place: the table is empty.

alter table public.smc_scan_bars
  alter column open   type numeric using open::numeric,
  alter column high   type numeric using high::numeric,
  alter column low    type numeric using low::numeric,
  alter column close  type numeric using close::numeric,
  alter column volume type numeric using volume::numeric;
