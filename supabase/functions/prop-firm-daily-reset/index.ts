/**
 * prop-firm-daily-reset — CEST Midnight Daily State Rollover
 * ──────────────────────────────────────────────────────────────────────────
 * Triggered by pg_cron at 22:00 UTC (summer) / 23:00 UTC (winter).
 *
 * Responsibilities:
 * 1. Finalize the ending day's state (set end_of_day_balance, update highest_eod_balance_ever)
 * 2. Unlock the day (clear is_locked so next day starts fresh)
 * 3. Create the new day's state row with fresh day_start_balance
 * 4. Log the day_reset event
 *
 * This function is idempotent — if the new day's state already exists
 * (e.g., from the first scan cycle after midnight), it skips creation.
 *
 * Scheduling: Two pg_cron jobs (summer + winter) with only one active at a time,
 * OR a single job at 22:00 UTC that checks if it's the correct reset time.
 */

import { corsHeaders } from "../_shared/cors.ts";
import {
  getResetHourUTC,
  getCESTTradingDay,
  createDailyState,
  type PropFirmConfig,
  type PropFirmDailyState,
} from "../_shared/propFirmRisk.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const now = new Date();
    const currentHourUTC = now.getUTCHours();
    const expectedResetHour = getResetHourUTC(now);

    // Guard: only run if current hour matches the expected reset hour
    // This allows a single cron job at both 22:00 and 23:00 UTC, with only
    // the correct one actually executing based on DST.
    if (currentHourUTC !== expectedResetHour) {
      console.log(`[daily-reset] Skipping — current hour ${currentHourUTC} !== expected reset hour ${expectedResetHour} (DST guard)`);
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: "DST guard" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get all active prop firm configs
    const { data: configs, error: cfgErr } = await supabase
      .from("prop_firm_config")
      .select("*")
      .eq("is_active", true);

    if (cfgErr) throw new Error(`Config query failed: ${cfgErr.message}`);
    if (!configs || configs.length === 0) {
      return new Response(JSON.stringify({ ok: true, processed: 0, reason: "No active configs" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: Array<{ configId: string; userId: string; status: string }> = [];

    for (const config of configs as PropFirmConfig[]) {
      try {
        // ── 1. Determine the ending day and the new day ──
        const endingDay = getCESTTradingDay(new Date(now.getTime() - 60_000), expectedResetHour); // 1 min before = ending day
        const newDay = getCESTTradingDay(now, expectedResetHour); // Now = new day

        // ── 2. Finalize the ending day's state ──
        const { data: endingState } = await supabase
          .from("prop_firm_daily_state")
          .select("*")
          .eq("config_id", config.id)
          .eq("trading_day", endingDay)
          .maybeSingle();

        if (endingState) {
          // Get current account balance for EOD
          const { data: acct } = await supabase
            .from("paper_accounts")
            .select("balance")
            .eq("user_id", config.user_id)
            .eq("bot_id", config.bot_id)
            .maybeSingle();

          const eodBalance = acct ? parseFloat(acct.balance) : endingState.day_start_balance;
          const newHighestEOD = Math.max(endingState.highest_eod_balance_ever, eodBalance);

          await supabase
            .from("prop_firm_daily_state")
            .update({
              end_of_day_balance: eodBalance,
              highest_eod_balance_ever: newHighestEOD,
              // Clear lock for the ending day (historical record)
            })
            .eq("id", endingState.id);

          // ── 3. Create new day's state (if not already created by first scan) ──
          const { data: existingNewDay } = await supabase
            .from("prop_firm_daily_state")
            .select("id")
            .eq("config_id", config.id)
            .eq("trading_day", newDay)
            .maybeSingle();

          if (!existingNewDay) {
            const newState = createDailyState(
              config.id,
              newDay,
              eodBalance,
              eodBalance, // At midnight, equity ≈ balance (no floating P&L if positions were closed)
              newHighestEOD,
            );

            await supabase
              .from("prop_firm_daily_state")
              .insert({ ...newState, trading_day: newDay });
          }

          // ── 4. Log event ──
          await supabase.from("prop_firm_events").insert({
            config_id: config.id,
            event_type: "day_reset",
            severity: "info",
            message: `Day ${endingDay} closed. EOD balance: $${eodBalance.toFixed(2)}. Highest EOD ever: $${newHighestEOD.toFixed(2)}. New day: ${newDay}.`,
            balance_at_event: eodBalance,
            equity_at_event: eodBalance,
            daily_loss_at_event: 0,
            drawdown_at_event: newHighestEOD - eodBalance,
          });

          results.push({ configId: config.id, userId: config.user_id, status: "reset_complete" });
        } else {
          // No state for ending day — might be first day or no trading happened
          results.push({ configId: config.id, userId: config.user_id, status: "no_ending_state" });
        }
      } catch (e: any) {
        console.warn(`[daily-reset] Error processing config ${config.id}: ${e?.message}`);
        results.push({ configId: config.id, userId: config.user_id, status: `error: ${e?.message}` });
      }
    }

    console.log(`[daily-reset] Processed ${results.length} configs: ${JSON.stringify(results)}`);
    return new Response(JSON.stringify({ ok: true, processed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error(`[daily-reset] Fatal error: ${e?.message}`);
    return new Response(JSON.stringify({ error: e?.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
