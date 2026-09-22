-- POST-DEPLOY VERIFICATION — read-only. Run in the SQL editor.
--
-- Covers the D.2 Step 2 criteria that need a database, which the deployment
-- checks could not reach from outside.

select '1. IPO TABLES (expect 0,0,0)' as section, 'ipo_paper_positions' as item,
       count(*)::text as value from public.ipo_paper_positions
union all select '1. IPO TABLES (expect 0,0,0)', 'ipo_paper_trade_history',
       count(*)::text from public.ipo_paper_trade_history
union all select '1. IPO TABLES (expect 0,0,0)', 'ipo_execution_events',
       count(*)::text from public.ipo_execution_events

-- Baseline was paper_positions 0, paper_trade_history 461, pending_orders 13.
-- paper_trade_history and pending_orders belong to the live SMC bot, so a
-- change here is only a finding if it cannot be explained by normal SMC
-- activity between the two readings.
union all select '2. SMC BASELINE', 'paper_positions',
       count(*)::text from public.paper_positions
union all select '2. SMC BASELINE', 'paper_trade_history',
       count(*)::text from public.paper_trade_history
union all select '2. SMC BASELINE', 'pending_orders',
       count(*)::text from public.pending_orders

-- ipo-observation passes persistSymbolOverrides:false and never completed a
-- fetch anyway, so any recent write here came from SMC, not from IPO.
union all select '3. broker_connections UNCHANGED', id::text,
       'updated_at=' || coalesce(updated_at::text,'(null)')
  from public.broker_connections

-- The observation cache. Rows here would mean a run completed; after a
-- WORKER_RESOURCE_LIMIT kill there should be none.
union all select '4. OBSERVATION CACHE (expect none)', key,
       'expires_at=' || expires_at::text
  from public.kv_cache where key like 'ipo_observation:%'

order by section, item;
