-- ROUTE 2 PROVENANCE BACKFILL — deterministic rows only
--
-- DATA ONLY. No schema change: every column written here already exists.
--
-- Until this release, buildEntryTelemetry hard-coded strategy_version, so a
-- Route 2 fill from a `smc-route2-confirmation-lifecycle-v2` pending order
-- was stamped `smc-zone-impulse-control-v1`, and source_pending_order_id —
-- a column with an FK and a unique index — was never written by anything.
-- Observed: NZD/CAD short 9394117f, pending V2, position V1, source NULL.
--
-- WHAT COUNTS AS PROVEN. A row is touched only when ALL hold:
--   * the pending order is `filled` and belongs to the smc bot;
--   * the position/history row has entry_route = 'route2_pending', i.e. it
--     was written by a Route 2 fill path with the telemetry block present;
--   * position_id = pending.order_id — both fill paths set
--     `positionId = pending.order_id`, so this is the fill's own identity;
--   * user, symbol and direction also match.
-- A legacy row lacking entry_route is NOT touched: nothing ties it to a
-- pending order deterministically, and inferring the link would be exactly
-- the fabrication this telemetry exists to prevent.
--
-- WHAT IS WRITTEN.
--   * source_pending_order_id  <- pending.id, only where currently NULL.
--   * strategy_version         <- pending.strategy_version, only where the
--     pending order HAS one. A V1-era order with NULL keeps its current stamp.
--   * entry_decision_snapshot.route2       <- provenance from the pending row.
--   * entry_decision_snapshot.confirmation <- the confirmation already stored
--     in the row's own signal_reason, reshaped to the canonical record.
--   * pending_orders.entry_confirmation    <- the same record, where NULL.
-- Keys are only ADDED, never replaced: a row that already has `route2` or
-- `confirmation` is left alone, so this is safe to re-run.
--
-- `significance` is written as JSON null when the stored confirmation lacks
-- it. It was never persisted before this release (JSON.stringify drops
-- undefined), so null means "not recorded", not "none".
--
-- NOT touched: prices, stops, targets, sizes, P&L, status, or any column a
-- trading decision reads.

do $$
declare
  p          record;
  t          record;
  sr         jsonb;
  c          jsonb;
  rec        jsonb;
  prov       jsonb;
  n_pos      int := 0;
  n_hist     int := 0;
  n_pending  int := 0;
begin
  for p in
    select * from public.pending_orders
    where bot_id = 'smc' and status = 'filled'
  loop
    prov := jsonb_build_object(
      'contract',                'route2-provenance.v1',
      'pendingOrderId',          p.order_id,
      'pendingRowId',            p.id,
      'strategyVersion',         p.strategy_version,
      'configHash',              p.config_hash,
      'lifecycleVersion',        case when p.strategy_version like '%lifecycle%' then p.strategy_version end,
      'wouldHaveBeenRoute1',     p.would_have_been_route1,
      'zoneId',                  p.zone_id,
      'pendingCreatedAt',        p.placed_at,
      'pendingEntryPrice',       p.entry_price,
      'pendingDistanceAtr',      p.pending_distance_atr,
      'zoneTouchTime',           coalesce(p.zone_touch_time, p.last_touch_detection_time),
      'confirmationArmCount',    p.confirmation_arm_count,
      'confirmationChecksCount', p.confirmation_checks_count
    );

    -- ── open positions ──
    for t in
      select * from public.paper_positions
      where position_id = p.order_id and entry_route = 'route2_pending'
        and user_id = p.user_id and symbol = p.symbol and direction = p.direction
    loop
      begin sr := t.signal_reason::jsonb; exception when others then sr := null; end;
      c := sr -> 'confirmation';
      rec := case when jsonb_typeof(c) = 'object' and c ? 'type' and c ? 'tier' then
        jsonb_build_object(
          'contract', 'route2-confirmation.v1',
          'type', c -> 'type', 'tier', c -> 'tier',
          'timeframe', coalesce(c -> 'timeframe', to_jsonb(p.confirmation_timeframe)),
          'price', c -> 'price', 'displacement', c -> 'displacement',
          'significance', coalesce(c -> 'significance', 'null'::jsonb),
          'closeBased', c -> 'closeBased',
          'supportingSignals', coalesce(c -> 'supportingSignals', '[]'::jsonb))
        end;

      update public.paper_positions set
        source_pending_order_id = coalesce(source_pending_order_id, p.id),
        strategy_version = coalesce(p.strategy_version, strategy_version),
        entry_decision_snapshot = coalesce(entry_decision_snapshot, '{}'::jsonb)
          || case when coalesce(entry_decision_snapshot, '{}'::jsonb) ? 'route2' then '{}'::jsonb
                  else jsonb_build_object('route2', prov) end
          || case when rec is null or coalesce(entry_decision_snapshot, '{}'::jsonb) ? 'confirmation' then '{}'::jsonb
                  else jsonb_build_object('confirmation', rec) end
      where id = t.id
        and not exists (select 1 from public.paper_positions x
                        where x.source_pending_order_id = p.id and x.id <> t.id);
      n_pos := n_pos + 1;

      if rec is not null and p.entry_confirmation is null then
        update public.pending_orders set entry_confirmation = rec where id = p.id;
        n_pending := n_pending + 1;
      end if;
    end loop;

    -- ── closed trades ──
    for t in
      select * from public.paper_trade_history
      where position_id = p.order_id and entry_route = 'route2_pending'
        and user_id = p.user_id and symbol = p.symbol and direction = p.direction
    loop
      begin sr := t.signal_reason::jsonb; exception when others then sr := null; end;
      c := sr -> 'confirmation';
      rec := case when jsonb_typeof(c) = 'object' and c ? 'type' and c ? 'tier' then
        jsonb_build_object(
          'contract', 'route2-confirmation.v1',
          'type', c -> 'type', 'tier', c -> 'tier',
          'timeframe', coalesce(c -> 'timeframe', to_jsonb(p.confirmation_timeframe)),
          'price', c -> 'price', 'displacement', c -> 'displacement',
          'significance', coalesce(c -> 'significance', 'null'::jsonb),
          'closeBased', c -> 'closeBased',
          'supportingSignals', coalesce(c -> 'supportingSignals', '[]'::jsonb))
        end;

      update public.paper_trade_history set
        source_pending_order_id = coalesce(source_pending_order_id, p.id),
        strategy_version = coalesce(p.strategy_version, strategy_version),
        entry_decision_snapshot = coalesce(entry_decision_snapshot, '{}'::jsonb)
          || case when coalesce(entry_decision_snapshot, '{}'::jsonb) ? 'route2' then '{}'::jsonb
                  else jsonb_build_object('route2', prov) end
          || case when rec is null or coalesce(entry_decision_snapshot, '{}'::jsonb) ? 'confirmation' then '{}'::jsonb
                  else jsonb_build_object('confirmation', rec) end
      where id = t.id;
      n_hist := n_hist + 1;

      if rec is not null and p.entry_confirmation is null then
        update public.pending_orders set entry_confirmation = rec
        where id = p.id and entry_confirmation is null;
        n_pending := n_pending + 1;
      end if;
    end loop;
  end loop;

  raise notice 'route2 provenance backfill: % position rows, % history rows, % pending rows',
    n_pos, n_hist, n_pending;
end $$;
