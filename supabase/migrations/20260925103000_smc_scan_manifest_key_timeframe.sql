-- Fix the manifest natural key: a slot is identified by its INTERVAL too.
--
-- THE BUG. The key was (scan_cycle_id, symbol, slot). But `context` is a ROLE,
-- not a single array — one scan snapshots three context arrays (4H, Daily, 1H)
-- because the HTF-confluence and liquidity bundles are derived from all three.
-- Three rows with slot='context' therefore collided inside a single upsert:
--
--   23505  Key (scan_cycle_id, symbol, slot)=(..., context) already exists
--
-- Postgres cannot apply ON CONFLICT DO UPDATE to the same row twice in one
-- statement, so the whole manifest write failed. Observed live on the first
-- post-deploy scan: 1,500 bar rows written, 0 manifest rows, 0 context rows.
--
-- The scanner's fail-open behaviour worked exactly as designed — the write
-- threw, was caught, counted and warned, and the scan continued to completion
-- without any effect on a trading decision. The data loss was confined to the
-- observability tables, which is the whole point of that design.
--
-- THE FIX. (scan_cycle_id, symbol, slot, timeframe). Every real input is a
-- (slot, interval) pair: the scalper legitimately passes 5m as both `low` and
-- `entry` (distinct slots, same interval), and `context` legitimately appears
-- three times (same slot, distinct intervals). Only the pair is unique.
--
-- Safe to swap outright: the manifest table holds zero rows, because the
-- constraint prevented every insert it ever attempted.

alter table public.smc_scan_manifest
  drop constraint if exists smc_scan_manifest_key;

alter table public.smc_scan_manifest
  add constraint smc_scan_manifest_key
  unique (scan_cycle_id, symbol, slot, timeframe);
