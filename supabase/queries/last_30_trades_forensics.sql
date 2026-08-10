-- ════════════════════════════════════════════════════════════════════════════
-- Last 30 trades — forensic dump
-- ════════════════════════════════════════════════════════════════════════════
--
-- Reconstructs, in bulk, what a single Trade Decision card shows: entry, stop,
-- target, planned vs realised R:R, how it died, and the reasoning attached at
-- open. One row per trade so patterns are visible instead of anecdotes.
--
-- WHY THIS EXISTS
--   The GBP/CHF post-mortem on 2026-08-10 found a 1.55-pip stop on a pair whose
--   spread is 2-3 pips, producing a "15.29:1" R:R that sailed through every gate
--   because R:R is reward/risk — the worse the stop, the better the setup scores.
--   Fixed in PR #288. QUERY 1 below finds any remaining trades with that shape.
--
-- READING IT
--   rr_planned  >= 10   → stop is almost certainly broken, not a great setup
--   sl_pips     <  5    → smaller than spread on most pairs; near-certain loss
--   sl_pips     <  min_sl_pips_expected → the floor did not apply on that path
--   rr_realised << rr_planned → exits are not achieving the planned target
--
-- NOTES
--   - Prices AND timestamps are stored as text; everything is cast explicitly.
--     Timestamps use (col::text)::timestamptz so the query works whether the
--     column is text or a real timestamptz.
--   - Pip size is inferred the same way the codebase does it
--     (price > 10 → 0.01 for JPY-quoted, else 0.0001).
--   - min_sl_pips_expected mirrors MIN_SL_PIPS in _shared/smcAnalysis.ts.
--     Update it here if that table changes.

-- ────────────────────────────────────────────────────────────────────────────
-- QUERY 1 — the forensic table. Export this one.
-- ────────────────────────────────────────────────────────────────────────────

with base as (
  select
    h.closed_at,
    h.open_time,
    h.symbol,
    h.direction,
    h.close_reason,
    h.size::numeric                    as size,
    h.entry_price::numeric             as entry,
    h.exit_price::numeric              as exit_px,
    h.stop_loss::numeric               as sl,
    h.take_profit::numeric             as tp,
    h.pnl::numeric                     as pnl,
    h.pnl_pips::numeric                as pnl_pips,
    h.signal_score::numeric            as score,
    h.signal_reason,
    h.position_id,
    case when h.entry_price::numeric > 10 then 0.01 else 0.0001 end as pip,
    case h.symbol
      when 'GBP/USD' then 25 when 'GBP/AUD' then 30 when 'GBP/CAD' then 30
      when 'GBP/NZD' then 30 when 'GBP/CHF' then 25 when 'GBP/JPY' then 30
      when 'EUR/USD' then 20 when 'EUR/GBP' then 15 when 'EUR/AUD' then 25
      when 'EUR/CAD' then 25 when 'EUR/NZD' then 25 when 'EUR/CHF' then 18
      else 15
    end as min_sl_pips_expected
  from paper_trade_history h
  order by (h.closed_at::text)::timestamptz desc
  limit 30
)
select
  to_char((b.closed_at::text)::timestamptz, 'MM-DD HH24:MI')                    as closed,
  b.symbol,
  b.direction,
  round(abs(b.entry - b.sl) / b.pip, 1)                    as sl_pips,
  b.min_sl_pips_expected                                   as sl_floor,
  case when abs(b.entry - b.sl) / b.pip < b.min_sl_pips_expected
       then 'BELOW FLOOR' else '' end                      as sl_flag,
  round(abs(b.tp - b.entry) / b.pip, 1)                    as tp_pips,
  round(abs(b.tp - b.entry) / nullif(abs(b.entry - b.sl), 0), 2) as rr_planned,
  round(abs(b.exit_px - b.entry) / nullif(abs(b.entry - b.sl), 0), 2) as rr_realised,
  b.close_reason,
  b.pnl,
  b.pnl_pips,
  b.score,
  r.confluence_score,
  r.session,
  r.timeframe,
  r.bias,
  left(coalesce(r.summary, ''), 140)                       as summary,
  b.signal_reason
from base b
left join trade_reasonings r on r.position_id = b.position_id
order by (b.closed_at::text)::timestamptz desc;


-- ────────────────────────────────────────────────────────────────────────────
-- QUERY 2 — the smoking gun. Every trade whose stop was too tight to survive,
-- across all history, not just the last 30. If the top of this list is mostly
-- losses, PR #288 closed a real source of drawdown.
-- ────────────────────────────────────────────────────────────────────────────

select
  to_char((closed_at::text)::timestamptz, 'YYYY-MM-DD HH24:MI')                                as closed,
  symbol,
  direction,
  round(abs(entry_price::numeric - stop_loss::numeric)
      / case when entry_price::numeric > 10 then 0.01 else 0.0001 end, 2) as sl_pips,
  round(abs(take_profit::numeric - entry_price::numeric)
      / nullif(abs(entry_price::numeric - stop_loss::numeric), 0), 2)     as rr_planned,
  close_reason,
  pnl::numeric                                                            as pnl
from paper_trade_history
where stop_loss is not null and take_profit is not null
  and abs(entry_price::numeric - stop_loss::numeric) > 0
  and abs(take_profit::numeric - entry_price::numeric)
      / abs(entry_price::numeric - stop_loss::numeric) >= 8
order by rr_planned desc
limit 60;


-- ────────────────────────────────────────────────────────────────────────────
-- QUERY 3 — the one-line summary. How much did tiny stops cost?
-- ────────────────────────────────────────────────────────────────────────────

with scored as (
  select
    pnl::numeric as pnl,
    abs(take_profit::numeric - entry_price::numeric)
      / nullif(abs(entry_price::numeric - stop_loss::numeric), 0) as rr_planned
  from paper_trade_history
  where stop_loss is not null and take_profit is not null
    and abs(entry_price::numeric - stop_loss::numeric) > 0
)
select
  count(*)                                                   as trades,
  count(*) filter (where rr_planned >= 8)                    as suspicious_rr,
  round(sum(pnl) filter (where rr_planned >= 8), 2)          as pnl_from_suspicious,
  round(sum(pnl) filter (where rr_planned <  8), 2)          as pnl_from_normal,
  round(sum(pnl), 2)                                         as pnl_total,
  round(100.0 * count(*) filter (where rr_planned >= 8 and pnl < 0)
        / nullif(count(*) filter (where rr_planned >= 8), 0), 1) as suspicious_loss_rate_pct
from scored;
