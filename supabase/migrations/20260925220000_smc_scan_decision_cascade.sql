-- Cascade-zone observability: the last straightforward input gap.
--
-- `findCascadeZone` runs the Daily→4H→1H waterfall and, when it reaches
-- "triggered", OVERRIDES the unified zone gate — so it is decision-relevant
-- wherever it runs. Its OUTPUT is already recorded in
-- `scan_logs.details_json[].cascadeZone` (state, reason, hasDailyZone,
-- hasConfirmation, hasEntryZone, priceAtEntry, distancePips, entry, sl); the
-- input was never recorded, which is the same gap the rest of this table
-- closes.
--
-- WORTH KNOWING: the call is gated on `resolvedStyle === "swing_trader"` and
-- production runs scalper, so this stage does not execute under the current
-- configuration and will capture nothing until the style changes. Recorded now
-- because the capture is cheap and because a stage that silently never runs is
-- exactly the kind of thing that later gets mistaken for a stage that runs and
-- finds nothing.

alter table public.smc_scan_decision
  add column if not exists cascade_input       jsonb,
  add column if not exists cascade_output      jsonb,
  add column if not exists cascade_input_hash  text,
  add column if not exists cascade_output_hash text;

comment on column public.smc_scan_decision.cascade_input is
  'Inputs to findCascadeZone. NULL when the stage did not run — which is every scan while the active style is scalper.';
