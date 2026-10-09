-- BASELINE A strategy report — SQL-editor subset. READ-ONLY (one SELECT). Spec: docs/BASELINE_A_REPORT_SPEC_V1.md.
-- Same cohorts and definitions as local-runner/baseline-a-report.ts; MAE/MFE and timing medians are CLI-only.
-- One row per cohort × dimension (overall, pair, entry source). Baseline A and historical dry-run are never pooled.
with base as (
  select *,
         case when not dry_run and config_version = '1037e6170289f865e4d6618dcf28b94d' and route = 'route2_pending_confirmation'
                   and primary_engine = 'impulse_zone' and decision_at >= '2026-10-09 17:22:40.402828+00' then 'baseline_a'
              when dry_run and decision_at < '2026-10-09 17:22:40.402828+00' then 'historical_dry_run' end as cohort
    from public.trade_attribution
), dims as (
  select 'overall' as dimension, 'all' as value, b.* from base b where cohort is not null
  union all select 'pair', symbol, b.* from base b where cohort is not null
  union all select 'entry_source', coalesce(entry_source, 'unknown'), b.* from base b where cohort is not null
)
select cohort, dimension, value,
       count(*) as orders,
       count(*) filter (where touched_at is not null) as touched,
       count(*) filter (where filled_at is not null) as fills,
       round(count(*) filter (where filled_at is not null)::numeric / nullif(count(*), 0), 3) as fill_rate,
       count(*) filter (where terminal_status = 'invalidated') as invalidated,
       count(*) filter (where terminal_status = 'cancelled') as cancelled,
       count(*) filter (where terminal_status = 'expired') as expired,
       count(*) filter (where terminal_status = 'superseded') as superseded,
       count(*) filter (where terminal_status in ('blocked_caps', 'blocked_risk_gate', 'entries_locked')) as blocked,
       count(*) filter (where terminal_status is null) as open_orders,
       count(*) filter (where closed_at is not null and realized_r_gross is not null) as closed,
       round(count(*) filter (where realized_r_gross > 0)::numeric
             / nullif(count(*) filter (where closed_at is not null and realized_r_gross is not null), 0), 3) as win_rate,
       round(avg(realized_r_gross) filter (where closed_at is not null), 3) as avg_r_gross,
       round(avg(realized_r_net) filter (where closed_at is not null), 3) as expectancy_r_net,
       round(coalesce(sum(realized_pnl_usd) filter (where closed_at is not null), 0), 2) as realized_pnl_usd,
       round(avg(intended_risk_usd), 2) as avg_intended_risk_usd,
       round(avg(fill_risk_usd) filter (where filled_at is not null), 2) as avg_fill_risk_usd,
       round(avg(stop_distance_pips), 1) as avg_stop_pips
  from dims
 group by cohort, dimension, value
 order by cohort, dimension <> 'overall', dimension, value;
