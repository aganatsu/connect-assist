-- Preserve the provider's datetime string verbatim.
--
-- WHY. `bar_time` is timestamptz, so the round trip canonicalises: a bar the
-- provider labelled "2026-01-01T00:00:00.000Z" comes back as
-- "2026-01-01T00:00:00+00:00". The content digest is computed over the exact
-- strings the engine received, so reconstruction could never reproduce it for
-- any feed that emits sub-second precision — which the MetaAPI and Polygon
-- paths both do, building their datetime with `new Date(t).toISOString()`.
-- Twelve Data happens to emit whole seconds, which is the only reason this did
-- not fail on the first live capture.
--
-- Identity keeps the exact bytes; comparisons use the instant. `bar_time`
-- remains the queryable instant for range scans and ordering, and
-- `bar_time_raw` is what a replay feeds back to the engine.
--
-- Added not-null with a backfill default because the table is empty — the
-- observation-keyed rebuild immediately before this cleared it.

alter table public.smc_scan_bars
  add column if not exists bar_time_raw text not null default '';

alter table public.smc_scan_bars
  alter column bar_time_raw drop default;

comment on column public.smc_scan_bars.bar_time_raw is
  'The provider datetime string exactly as the engine received it. bar_time is the same moment as a timestamptz for querying; only this column reproduces the content digest.';
