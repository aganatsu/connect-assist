-- ════════════════════════════════════════════════════════════════════════════
-- Gate 9 impact — is the raw-score check rejecting setups that already passed?
-- ════════════════════════════════════════════════════════════════════════════
--
-- THE QUESTION
--   Gate 9 (bot-scanner/index.ts, runSafetyGates) tests:
--       analysis.score  <  config.minConfluence            ← RAW score, BASE threshold
--
--   Eligibility (bot-scanner/index.ts:7495) tests:
--       effectiveScore >= conflictAdjustedMinConfluence    ← ADJUSTED score & threshold
--
--   effectiveScore = analysis.score
--                  + fotsiPenalty + impulseZonePenaltyVal + zoneLocalScoreAdj
--                  + crossTimeframeScoreAdj + ictTotalAdj + verdictScoreAdj
--
--   Several of those adjustments are POSITIVE (verdict bonus up to maxBonus,
--   killzone prime bonus, impulse-zone credit). So a setup can clear the bar
--   because of its credits and then be rejected by Gate 9 on the un-credited
--   number.
--
-- WHY EVERY HIT IS SUSPICIOUS
--   runSafetyGates is only ever called INSIDE the eligibility check:
--
--       if ((legacyScannerEligible || singleOwnershipEnforcementRequested) && ...) {
--         const gates = await runSafetyGates(...)   // Gate 9 lives in here
--
--   So Gate 9 can only fire on a setup that already cleared the adjusted
--   threshold. Gate 9 firing IS the false-rejection condition, except via the
--   singleOwnershipEnforcementRequested side door.
--
-- HOW THIS QUERY WORKS
--   rejected_setups.confluence_score stores the EFFECTIVE score (see the
--   logRejectedSetup call at bot-scanner/index.ts:10307).
--   Gate 9's reason string is stored verbatim in failed_gates and embeds both
--   the raw score and the base threshold:
--       "Score 47.2 < 55 threshold"
--   So both numbers can be recovered without a schema change.
--
-- NOTES (all confirmed against the live database on 2026-08-10)
--   1. failed_gates is a Postgres text[], so these use unnest(). If it is ever
--      migrated to jsonb, swap in jsonb_array_elements_text().
--   2. The unnested column is aliased explicitly as t(g). A bare `as g` makes
--      `g` ambiguous between the table alias and its single column.
--   3. Use substring(... from '(pattern)') rather than regexp_match(...)[1] —
--      regexp_match returned NULL in the Supabase editor for rows that the `~`
--      operator matched, which silently produced empty score columns.
--
-- RESULT (2026-08-10)
--   10 of 10 sampled Gate 9 rejections had an effective score at or above the
--   threshold. Credits ranged +1.79 to +2.20 (avg +1.97). Confirmed bug; fixed
--   in bot-scanner runSafetyGates, pinned by
--   supabase/tests/_shared/gate9EffectiveScore.test.ts.
--
-- ────────────────────────────────────────────────────────────────────────────
-- QUERY 1 — the summary. Run this one first and share the row.
-- ────────────────────────────────────────────────────────────────────────────

with gate9 as (
  select
    r.id,
    r.created_at,
    r.symbol,
    r.direction,
    r.confluence_score::numeric                                            as effective_score,
    substring(g from 'Score ([0-9.]+)')::numeric          as raw_score,
    substring(g from '< ([0-9.]+) threshold')::numeric    as base_threshold
  from rejected_setups r
  cross join lateral unnest(r.failed_gates) as t(g)
  where g ~ 'Score [0-9.]+ < [0-9.]+ threshold'
)
select
  count(*)                                                  as gate9_rejections,
  count(*) filter (where effective_score >= base_threshold) as cleared_bar_but_rejected,
  round(avg(effective_score - raw_score), 2)                as avg_credit_applied,
  round(max(effective_score - raw_score), 2)                as max_credit_applied,
  min(created_at)                                           as first_seen,
  max(created_at)                                           as last_seen
from gate9;

-- HOW TO READ IT
--   gate9_rejections = 0
--       Academic. Gate 9 never fires. Rename it to rawConfluenceFloor,
--       document the intent, move on.
--
--   gate9_rejections > 0 and cleared_bar_but_rejected ≈ the same number
--       Confirmed bug. avg_credit_applied is how much edge it has been
--       suppressing — it is the score the credit system awarded and Gate 9
--       then ignored. Two-line fix plus a regression test.


-- ────────────────────────────────────────────────────────────────────────────
-- QUERY 2 — the individual setups it killed, worst first.
-- ────────────────────────────────────────────────────────────────────────────

with gate9 as (
  select
    r.id,
    r.created_at,
    r.symbol,
    r.direction,
    r.tier1_count,
    r.session_name,
    r.confluence_score::numeric                                            as effective_score,
    substring(g from 'Score ([0-9.]+)')::numeric          as raw_score,
    substring(g from '< ([0-9.]+) threshold')::numeric    as base_threshold
  from rejected_setups r
  cross join lateral unnest(r.failed_gates) as t(g)
  where g ~ 'Score [0-9.]+ < [0-9.]+ threshold'
)
select
  created_at,
  symbol,
  direction,
  raw_score,
  effective_score,
  base_threshold,
  round(effective_score - raw_score, 2) as credit,
  tier1_count,
  session_name
from gate9
where effective_score >= base_threshold
order by credit desc
limit 40;


-- ────────────────────────────────────────────────────────────────────────────
-- QUERY 3 — sanity check. Confirms the regex is matching real rows before you
-- trust a zero from Query 1. If this returns nothing, either Gate 9 has never
-- fired or the reason string has changed and the regex needs updating.
-- ────────────────────────────────────────────────────────────────────────────

select
  r.created_at,
  r.symbol,
  g as gate_reason
from rejected_setups r
cross join lateral unnest(r.failed_gates) as t(g)
where g like 'Score %threshold%'
order by r.created_at desc
limit 10;
