-- Store the derived engine inputs instead of re-deriving them.
--
-- WHAT THE ORIGINAL DESIGN ASSUMED. `smc_scan_context` kept only digests of the
-- HTF-confluence bundle and the liquidity pool set, on the reasoning that both
-- are pure functions of the 4H / Daily / 1H arrays, which are snapshotted — so
-- a replay could re-derive them and check itself against the digest.
--
-- WHY THAT FAILED. They are pure functions of those arrays AND of roughly eight
-- detector parameters that live in the scanner and its per-pair config:
-- structure-break inputs, zigzag depth and lookback, fib anchors, the
-- premium/discount window, and — config-driven, so not even constant —
-- the liquidity tolerance (`min(liqTolBase + 0.05, 0.35)`) and minimum touch
-- count. None were recorded. First replay on clean data:
--
--   htf_confluence:  recorded=18bb418da346e032 rederived=42e64c65e9e1157a
--   liquidity_pools: recorded=6a3cf58d53c20a98 rederived=626571eedc13962d
--
-- The digests did their job and stopped the engine from being scored on inputs
-- that were not the ones production used. But "enumerate every parameter and
-- hope none was missed" is precisely the guess that produced the Stage 2E
-- AUD/USD error, where one omitted argument moved agreement by 47 points. A
-- replay should not depend on rediscovering how an input was built.
--
-- THE COST, MEASURED RATHER THAN ASSUMED. The original estimate feared a
-- 249 MB/day jsonb table. That figure assumed 12 symbols every 5 minutes. In
-- practice the zone engine is reached only for symbols that have an SMC
-- direction — 2 of 7 pairs on the cycles observed so far, because the rest exit
-- at `no_direction`. At ~2 symbols per cycle and ~10 KB per bundle pair that is
-- roughly 6 MB/day. Worst case, all 12 symbols every cycle, ~35 MB/day.
--
-- The digests are KEPT. They now verify the stored bundle against what was
-- hashed at scan time, so silent corruption is still detectable — the check
-- just no longer doubles as a re-derivation test.

alter table public.smc_scan_context
  add column if not exists htf_confluence  jsonb,
  add column if not exists liquidity_pools jsonb;

comment on column public.smc_scan_context.htf_confluence is
  'The HTFConfluenceData bundle exactly as passed to findUnifiedZone. Stored rather than re-derived: it depends on detector parameters that are config-driven and were not recoverable after the fact.';
comment on column public.smc_scan_context.liquidity_pools is
  'The combined Daily+4H+1H liquidity pool array exactly as passed to findUnifiedZone.';
