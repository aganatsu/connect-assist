/**
 * prop-firm-daily-reset — RETIRED as a day-boundary owner (step 13).
 * ──────────────────────────────────────────────────────────────────────────
 * Two pg_cron jobs (prop-firm-daily-reset-summer at 22:00 UTC and
 * prop-firm-daily-reset-winter at 23:00 UTC) called this function, which kept
 * its own DST rule and wrote prop_firm_daily_state with the paper balance at
 * the moment it ran — a second owner of the trading day next to the gate.
 *
 * The trading day now has exactly one definition, `tradingDayAt()` in
 * _shared/accountRiskLimits.ts (midnight in the profile's day_boundary_tz,
 * Europe/Prague), and the day-start balance is read from the settlement ledger
 * at that boundary by the account risk gate in bot-scanner. Nothing has to run
 * at midnight: the boundary and the balance are derived, not snapshotted.
 *
 * This endpoint is kept (no deletion) but writes nothing. It reports the
 * current trading day so a stray cron call is visible and harmless. Both cron
 * jobs are unscheduled by docs/STEP13_EQUITY_RISK_LIMITS_V1.md.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { tradingDayAt } from "../_shared/accountRiskLimits.ts";

Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const day = tradingDayAt(new Date());
  console.log(`[daily-reset] retired — no-op. Trading day ${day.tradingDay} (${day.startsAt.toISOString()} → ${day.endsAt.toISOString()}) is owned by the account risk gate.`);
  return new Response(JSON.stringify({
    ok: true,
    retired: true,
    owner: "bot-scanner account risk gate (tradingDayAt + settlement ledger)",
    tradingDay: day.tradingDay,
    startsAt: day.startsAt.toISOString(),
    endsAt: day.endsAt.toISOString(),
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
