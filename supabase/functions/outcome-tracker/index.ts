/**
 * outcome-tracker — Counterfactual Outcome Tracking for Rejected Setups
 * ──────────────────────────────────────────────────────────────────────
 * Runs hourly via pg_cron. For each rejected setup with outcome_status='pending'
 * that is at least 1 hour old:
 *   1. Fetch 1H candles covering 24h after rejection
 *   2. Simulate: did price reach entry? If yes, did it hit TP or SL first?
 *   3. Calculate MFE/MAE in pips
 *   4. Update outcome fields
 *
 * After batch processing, checks the rolling 7-day winner-block rate.
 * If >50% of resolved rejected setups would have been winners, sends
 * a Telegram alert to the bot owner.
 *
 * Also handles 30-day retention cleanup for the rejected_setups table.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { fetchCandlesWithFallback } from "../_shared/candleSource.ts";
import { SPECS } from "../_shared/smcAnalysis.ts";

// ── Constants ──
const BATCH_SIZE = 20;           // Process up to 20 setups per invocation
const MIN_AGE_MS = 60 * 60 * 1000;  // 1 hour minimum age before checking
const OUTCOME_WINDOW_HOURS = 24;     // Look 24h ahead for outcome
const RETENTION_DAYS = 30;           // Delete records older than this
const ALERT_THRESHOLD = 0.50;        // Alert if >50% would have won
const ALERT_ROLLING_DAYS = 7;        // Rolling window for alert calculation
const MIN_SAMPLES_FOR_ALERT = 10;    // Need at least 10 resolved setups to alert

// ── Helpers ──

function getPipSize(symbol: string): number {
  return (SPECS as any)[symbol]?.pipSize ?? 0.0001;
}

interface OutcomeResult {
  outcome_status: "inconclusive" | "would_have_won" | "would_have_lost";
  price_reached_entry: boolean;
  tp_hit: boolean;
  sl_hit: boolean;
  tp_hit_time_minutes: number | null;
  mfe_pips: number;
  mae_pips: number;
}

/**
 * Simulate the outcome of a rejected setup using candle data.
 * Returns the outcome based on whether price reached entry, then hit TP or SL first.
 */
function simulateOutcome(
  candles: Array<{ datetime: string; open: number; high: number; low: number; close: number }>,
  direction: "long" | "short",
  entryPrice: number,
  stopLoss: number | null,
  takeProfit: number | null,
  rejectedAt: string,
): OutcomeResult {
  const pipSize = 0.0001; // Will be overridden per-symbol in the caller
  const result: OutcomeResult = {
    outcome_status: "inconclusive",
    price_reached_entry: false,
    tp_hit: false,
    sl_hit: false,
    tp_hit_time_minutes: null,
    mfe_pips: 0,
    mae_pips: 0,
  };

  const rejectedTime = new Date(rejectedAt).getTime();
  let entryReachedTime: number | null = null;
  let maxFavorable = 0;
  let maxAdverse = 0;

  for (const candle of candles) {
    const candleTime = new Date(candle.datetime).getTime();
    // Only look at candles after rejection
    if (candleTime <= rejectedTime) continue;
    // Only look within the outcome window (24h)
    if (candleTime > rejectedTime + OUTCOME_WINDOW_HOURS * 60 * 60 * 1000) break;

    // Check if price reached entry
    if (!result.price_reached_entry) {
      if (direction === "long" && candle.low <= entryPrice) {
        result.price_reached_entry = true;
        entryReachedTime = candleTime;
      } else if (direction === "short" && candle.high >= entryPrice) {
        result.price_reached_entry = true;
        entryReachedTime = candleTime;
      }
    }

    // Once entry is reached, track MFE/MAE and check TP/SL
    if (result.price_reached_entry && entryReachedTime !== null) {
      if (direction === "long") {
        const favorable = candle.high - entryPrice;
        const adverse = entryPrice - candle.low;
        maxFavorable = Math.max(maxFavorable, favorable);
        maxAdverse = Math.max(maxAdverse, adverse);

        if (takeProfit !== null && candle.high >= takeProfit && !result.tp_hit) {
          result.tp_hit = true;
          result.tp_hit_time_minutes = Math.round((candleTime - entryReachedTime) / 60000);
        }
        if (stopLoss !== null && candle.low <= stopLoss) {
          result.sl_hit = true;
        }
      } else {
        // Short
        const favorable = entryPrice - candle.low;
        const adverse = candle.high - entryPrice;
        maxFavorable = Math.max(maxFavorable, favorable);
        maxAdverse = Math.max(maxAdverse, adverse);

        if (takeProfit !== null && candle.low <= takeProfit && !result.tp_hit) {
          result.tp_hit = true;
          result.tp_hit_time_minutes = Math.round((candleTime - entryReachedTime) / 60000);
        }
        if (stopLoss !== null && candle.high >= stopLoss) {
          result.sl_hit = true;
        }
      }
    }
  }

  // Assign MFE/MAE in raw price units (caller converts to pips)
  result.mfe_pips = maxFavorable;
  result.mae_pips = maxAdverse;

  // Determine final outcome
  if (!result.price_reached_entry) {
    result.outcome_status = "inconclusive";
  } else if (result.tp_hit && !result.sl_hit) {
    result.outcome_status = "would_have_won";
  } else if (result.sl_hit && !result.tp_hit) {
    result.outcome_status = "would_have_lost";
  } else if (result.tp_hit && result.sl_hit) {
    // Both hit — check which was hit first by time (tp_hit_time_minutes gives TP timing)
    // If TP was hit first (tp_hit_time_minutes is set), it's a win
    result.outcome_status = result.tp_hit_time_minutes !== null ? "would_have_won" : "would_have_lost";
  } else {
    // Entry reached but neither TP nor SL hit within window
    // Use MFE vs MAE to determine likely outcome
    if (maxFavorable > maxAdverse) {
      result.outcome_status = "would_have_won";
    } else {
      result.outcome_status = "would_have_lost";
    }
  }

  return result;
}

// ── Main Handler ──

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const results: Record<string, any> = { processed: 0, updated: 0, errors: 0, cleaned: 0 };

    // ── Step 1: Fetch pending outcomes older than 1 hour ──
    const cutoff = new Date(Date.now() - MIN_AGE_MS).toISOString();
    const { data: pendingSetups, error: fetchErr } = await supabase
      .from("rejected_setups")
      .select("*")
      .eq("outcome_status", "pending")
      .lt("rejected_at", cutoff)
      .order("rejected_at", { ascending: true })
      .limit(BATCH_SIZE);

    if (fetchErr) {
      console.error("[outcome-tracker] Fetch error:", fetchErr.message);
      return new Response(JSON.stringify({ error: fetchErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Step 2: Process each pending setup ──
    if (pendingSetups && pendingSetups.length > 0) {
      console.log(`[outcome-tracker] Processing ${pendingSetups.length} pending setups`);

      for (const setup of pendingSetups) {
        results.processed++;
        try {
          // Fetch 1H candles for the symbol (covers 24h+ after rejection)
          const { candles } = await fetchCandlesWithFallback({
            symbol: setup.symbol,
            interval: "1h",
            limit: 48, // 48 hours of 1H candles — plenty of coverage
          });

          if (candles.length < 5) {
            console.warn(`[outcome-tracker] Insufficient candles for ${setup.symbol} (${candles.length})`);
            results.errors++;
            continue;
          }

          const pipSize = getPipSize(setup.symbol);
          const outcome = simulateOutcome(
            candles,
            setup.direction as "long" | "short",
            parseFloat(setup.entry_price),
            setup.stop_loss ? parseFloat(setup.stop_loss) : null,
            setup.take_profit ? parseFloat(setup.take_profit) : null,
            setup.rejected_at,
          );

          // Convert MFE/MAE from price units to pips
          const mfePips = outcome.mfe_pips / pipSize;
          const maePips = outcome.mae_pips / pipSize;

          // Update the record
          const { error: updateErr } = await supabase
            .from("rejected_setups")
            .update({
              outcome_status: outcome.outcome_status,
              outcome_checked_at: new Date().toISOString(),
              price_reached_entry: outcome.price_reached_entry,
              tp_hit: outcome.tp_hit,
              sl_hit: outcome.sl_hit,
              tp_hit_time_minutes: outcome.tp_hit_time_minutes,
              mfe_pips: parseFloat(mfePips.toFixed(2)),
              mae_pips: parseFloat(maePips.toFixed(2)),
            })
            .eq("id", setup.id);

          if (updateErr) {
            console.warn(`[outcome-tracker] Update error for ${setup.id}: ${updateErr.message}`);
            results.errors++;
          } else {
            results.updated++;
          }
        } catch (e: any) {
          console.warn(`[outcome-tracker] Error processing ${setup.symbol}: ${e?.message}`);
          results.errors++;
        }
      }
    }

    // ── Step 3: Check rolling 7-day winner-block rate and alert ──
    try {
      const sevenDaysAgo = new Date(Date.now() - ALERT_ROLLING_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentResolved, error: alertErr } = await supabase
        .from("rejected_setups")
        .select("outcome_status, user_id")
        .neq("outcome_status", "pending")
        .neq("outcome_status", "inconclusive")
        .gte("rejected_at", sevenDaysAgo);

      if (!alertErr && recentResolved && recentResolved.length >= MIN_SAMPLES_FOR_ALERT) {
        const winners = recentResolved.filter((r: any) => r.outcome_status === "would_have_won");
        const winnerRate = winners.length / recentResolved.length;

        if (winnerRate > ALERT_THRESHOLD) {
          console.log(`[outcome-tracker] ⚠️ HIGH WINNER-BLOCK RATE: ${(winnerRate * 100).toFixed(1)}% (${winners.length}/${recentResolved.length}) over ${ALERT_ROLLING_DAYS} days`);
          results.alert_triggered = true;
          results.winner_block_rate = parseFloat((winnerRate * 100).toFixed(1));

          // Send Telegram alert to all users with rejected setups in this window
          const userIds = [...new Set(recentResolved.map((r: any) => r.user_id))];
          for (const uid of userIds) {
            try {
              const { data: userSettings } = await supabase
                .from("user_settings")
                .select("preferences_json")
                .eq("user_id", uid)
                .maybeSingle();
              const prefs = (userSettings?.preferences_json as any) || {};
              const chatIds: string[] = (() => {
                const list = Array.isArray(prefs.telegramChatIds) ? prefs.telegramChatIds : [];
                const ids = list.map((c: any) => typeof c === "string" ? c : String(c?.id ?? "")).filter(Boolean);
                if (ids.length > 0) return ids;
                return prefs.telegramChatId ? [String(prefs.telegramChatId)] : [];
              })();

              if (chatIds.length > 0) {
                const msg = `📊 <b>Gate Effectiveness Alert</b>\n\n` +
                  `<b>Winner-block rate:</b> ${(winnerRate * 100).toFixed(1)}%\n` +
                  `<b>Period:</b> Last ${ALERT_ROLLING_DAYS} days\n` +
                  `<b>Resolved setups:</b> ${recentResolved.length}\n` +
                  `<b>Would-have-won:</b> ${winners.length}\n\n` +
                  `⚠️ Gates may be too strict — more than half of blocked setups would have been profitable.\n` +
                  `Consider reviewing gate thresholds.`;

                for (const chatId of chatIds) {
                  try {
                    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-notify`, {
                      method: "POST",
                      headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
                      },
                      body: JSON.stringify({ chat_id: chatId, message: msg }),
                    });
                  } catch { /* non-fatal */ }
                }
              }
            } catch { /* non-fatal */ }
          }
        } else {
          results.winner_block_rate = parseFloat((winnerRate * 100).toFixed(1));
          results.alert_triggered = false;
        }
      }
    } catch (alertErr: any) {
      console.warn(`[outcome-tracker] Alert check error: ${alertErr?.message}`);
    }

    // ── Step 4: 30-day retention cleanup ──
    try {
      const retentionCutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { count: cleaned, error: cleanErr } = await supabase
        .from("rejected_setups")
        .delete({ count: "exact" })
        .lt("rejected_at", retentionCutoff);

      if (cleanErr) {
        console.warn(`[outcome-tracker] Cleanup error: ${cleanErr.message}`);
      } else {
        results.cleaned = cleaned || 0;
      }
    } catch (cleanErr: any) {
      console.warn(`[outcome-tracker] Cleanup error: ${cleanErr?.message}`);
    }

    console.log(`[outcome-tracker] Complete:`, JSON.stringify(results));
    return new Response(JSON.stringify({ success: true, ...results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("[outcome-tracker] Fatal error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
