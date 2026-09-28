-- Keep the forming bar out of the immutable bar store.
--
-- THE BUG. `smc_scan_bars` is deduplicated on (symbol, timeframe, bar_time) and
-- written with ignoreDuplicates, on the reasoning that a bar is immutable once
-- observed. That is true of a CLOSED bar and false of the one still forming:
-- it is re-observed every scan with different OHLC until its interval ends.
--
-- Observed live on the first post-deploy scan. At 10:25 the 15m bar opening
-- 10:15 was 10 minutes old; its partial OHLC was written and, being a duplicate
-- thereafter, was never corrected. At 10:45 the same bar was complete, so the
-- manifest digest covered the FINAL values while the table still held the
-- PARTIAL ones. Replay returned BARS_UNRECOVERABLE:
--
--   slot confirm (15m): content_hash 23081926b0d4bf2a != 76da7da78dfe931a
--
-- Nothing was lost but observability, and no trading decision was touched —
-- the digest did exactly the job it exists for, refusing to let a replay score
-- an array that was not the one production saw.
--
-- THE FIX. Only closed bars go in the immutable store. The forming bar — at
-- most one per slot, and the manifest already records whether there is one —
-- is kept inline on the manifest row that used it.
--
-- This is strictly better for the open question it serves. Stage 2D measured
-- that the SMC path scores against a forming bar in ~61% of scans and could
-- only infer the bar's shape afterwards by re-fetching. Now each scan preserves
-- the exact partial OHLC it actually scored, which is what the ~21.6%
-- price-outside-the-forming-bar anomaly needs in order to be settled.

alter table public.smc_scan_manifest
  add column if not exists forming_bar jsonb;

comment on column public.smc_scan_manifest.forming_bar is
  'OHLC of the final, still-forming bar of this slot''s array, as scored. NULL when the array ended on a closed bar. Held here rather than in smc_scan_bars because its values change until the interval closes, and the bar table is immutable-on-first-write.';
