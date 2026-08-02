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
import { verifyCronCaller } from "../_shared/cronAuth.ts";
import { fetchCandlesWithFallback } from "../_shared/candleSource.ts";
import { SPECS } from "../_shared/smcAnalysis.ts";
import {
  simulateOutcome,
} from "../_shared/outcomeSimulation.ts";

export { simulateOutcome } from "../_shared/outcomeSimulation.ts";

// ── Constants ──
const BATCH_SIZE = 20;           // Process up to 20 setups per invocation
const SHADOW_BATCH_SIZE = 100;    // Disagreement winners only; cached by symbol
const MIN_AGE_MS = 60 * 60 * 1000;  // 1 hour minimum age before checking
const OUTCOME_WINDOW_HOURS = 24;     // Look 24h ahead for outcome
const SHADOW_MIN_AGE_MS = OUTCOME_WINDOW_HOURS * 60 * 60 * 1000;
const RETENTION_DAYS = 30;           // Delete records older than this
const ALERT_THRESHOLD = 0.50;        // Alert if >50% would have won
const ALERT_ROLLING_DAYS = 7;        // Rolling window for alert calculation
const MIN_SAMPLES_FOR_ALERT = 10;    // Need at least 10 resolved setups to alert
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // Max one gate-effectiveness alert per user per 24h

// ── Helpers ──

function getPipSize(symbol: string): number {
  return (SPECS as any)[symbol]?.pipSize ?? 0.0001;
}

// ── Main Handler ──

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Gate 0: Only the cron scheduler may invoke this function.
  const authError = verifyCronCaller(req);
  if (authError) return authError;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const results: Record<string, any> = {
      processed: 0,
      updated: 0,
      errors: 0,
      cleaned: 0,
      shadow_processed: 0,
      shadow_updated: 0,
      shadow_errors: 0,
      shadow_cleaned: 0,
    };

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

    // ── Step 3: Resolve observe-only zone-ranking disagreement outcomes ──
    try {
      const shadowCutoff = new Date(
        Date.now() - SHADOW_MIN_AGE_MS,
      ).toISOString();
      const { data: shadowRows, error: shadowFetchErr } = await supabase
        .from("zone_candidate_shadow_observations")
        .select(
          "id, symbol, direction, entry_price, stop_loss, take_profit, observed_at",
        )
        .eq("evidence_source", "forward_observation")
        .eq("outcome_status", "pending")
        .lt("observed_at", shadowCutoff)
        .order("observed_at", { ascending: true })
        .limit(SHADOW_BATCH_SIZE);

      if (shadowFetchErr) {
        console.warn(
          `[outcome-tracker] Zone shadow fetch error: ${
            shadowFetchErr.message
          }`,
        );
        results.shadow_errors++;
      } else if (shadowRows && shadowRows.length > 0) {
        const candleCache = new Map<string, any[]>();
        for (const row of shadowRows) {
          results.shadow_processed++;
          try {
            let candles = candleCache.get(row.symbol);
            if (!candles) {
              const fetched = await fetchCandlesWithFallback({
                symbol: row.symbol,
                interval: "1h",
                limit: 72,
              });
              candles = fetched.candles;
              candleCache.set(row.symbol, candles);
            }
            if (candles.length < 24) {
              results.shadow_errors++;
              continue;
            }
            const outcome = simulateOutcome(
              candles,
              row.direction as "long" | "short",
              Number(row.entry_price),
              row.stop_loss == null ? null : Number(row.stop_loss),
              row.take_profit == null ? null : Number(row.take_profit),
              row.observed_at,
            );
            const pipSize = getPipSize(row.symbol);
            const status = outcome.price_reached_entry
              ? outcome.outcome_status
              : "no_entry";
            const { error: shadowUpdateErr } = await supabase
              .from("zone_candidate_shadow_observations")
              .update({
                outcome_status: status,
                outcome_checked_at: new Date().toISOString(),
                price_reached_entry: outcome.price_reached_entry,
                tp_hit: outcome.tp_hit,
                sl_hit: outcome.sl_hit,
                tp_hit_time_minutes: outcome.tp_hit_time_minutes,
                mfe_pips: Number(
                  (outcome.mfe_pips / pipSize).toFixed(2),
                ),
                mae_pips: Number(
                  (outcome.mae_pips / pipSize).toFixed(2),
                ),
              })
              .eq("id", row.id);
            if (shadowUpdateErr) {
              console.warn(
                `[outcome-tracker] Zone shadow update error ${row.id}:`
                + ` ${shadowUpdateErr.message}`,
              );
              results.shadow_errors++;
            } else {
              results.shadow_updated++;
            }
          } catch (shadowErr: any) {
            console.warn(
              `[outcome-tracker] Zone shadow error ${row.symbol}:`
              + ` ${shadowErr?.message}`,
            );
            results.shadow_errors++;
          }
        }
      }
    } catch (shadowErr: any) {
      console.warn(
        `[outcome-tracker] Zone shadow batch error: ${shadowErr?.message}`,
      );
      results.shadow_errors++;
    }

    // ── Step 4: Check rolling 7-day winner-block rate and alert ──
    try {
      const sevenDaysAgo = new Date(Date.now() - ALERT_ROLLING_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentResolved, error: alertErr } = await supabase
        .from("rejected_setups")
        .select("outcome_status, user_id, symbol, rejection_reason")
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
              // Respect category toggle (default ON, explicit OFF skips)
              const notifyCategories: Record<string, boolean> = prefs.telegramNotifyCategories || {};
              if (notifyCategories.gate_effectiveness === false) continue;
              // 24h cooldown per user to prevent spam
              const lastAtRaw = prefs.lastGateEffectivenessAlertAt;
              const lastAt = lastAtRaw ? Date.parse(lastAtRaw) : 0;
              if (lastAt && Date.now() - lastAt < ALERT_COOLDOWN_MS) continue;
              const chatIds: string[] = (() => {
                const list = Array.isArray(prefs.telegramChatIds) ? prefs.telegramChatIds : [];
                const ids = list.map((c: any) => typeof c === "string" ? c : String(c?.id ?? "")).filter(Boolean);
                if (ids.length > 0) return ids;
                return prefs.telegramChatId ? [String(prefs.telegramChatId)] : [];
              })();

              if (chatIds.length > 0) {
                const topOf = (key: string) => {
                  const counts = new Map<string, number>();
                  for (const w of winners as any[]) {
                    const v = String(w?.[key] ?? "").trim();
                    if (!v) continue;
                    counts.set(v, (counts.get(v) || 0) + 1);
                  }
                  return [...counts.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([v, c]) => `${v} (${c})`)
                    .join(", ");
                };
                const topReasons = topOf("rejection_reason");
                const topSymbols = topOf("symbol");
                const msg = `📊 <b>Gate Effectiveness Alert</b>\n\n` +
                  `<b>Winner-block rate:</b> ${(winnerRate * 100).toFixed(1)}%\n` +
                  `<b>Period:</b> Last ${ALERT_ROLLING_DAYS} days\n` +
                  `<b>Resolved setups:</b> ${recentResolved.length}\n` +
                  `<b>Would-have-won:</b> ${winners.length}\n` +
                  (topReasons ? `<b>Top blocking gates:</b> ${topReasons}\n` : "") +
                  (topSymbols ? `<b>Most affected pairs:</b> ${topSymbols}\n` : "") +
                  `\n` +
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
                // Record cooldown timestamp
                try {
                  await supabase
                    .from("user_settings")
                    .update({
                      preferences_json: {
                        ...prefs,
                        lastGateEffectivenessAlertAt: new Date().toISOString(),
                      },
                    })
                    .eq("user_id", uid);
                } catch { /* non-fatal */ }
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

    // ── Step 5: 30-day retention cleanup ──
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

      const { count: shadowCleaned, error: shadowCleanErr } =
        await supabase
          .from("zone_candidate_shadow_observations")
          .delete({ count: "exact" })
          .eq("evidence_source", "forward_observation")
          .lt("observed_at", retentionCutoff);
      if (shadowCleanErr) {
        console.warn(
          `[outcome-tracker] Zone shadow cleanup error: ${
            shadowCleanErr.message
          }`,
        );
      } else {
        results.shadow_cleaned = shadowCleaned || 0;
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
