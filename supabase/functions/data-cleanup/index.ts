// M12: Data Retention Policy — scheduled daily cleanup
// Run via Supabase cron: SELECT cron.schedule('daily-cleanup', '0 3 * * *', $$SELECT net.http_post(...)$$);
//
// Retention rules:
// - scan_logs: delete rows older than 30 days
// - close_audit_log: delete rows older than 30 days
// - paper_trade_history: archive rows older than 90 days to trade_archive

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronCaller } from "../_shared/cronAuth.ts";
import {
  buildCompactSummary,
  type EvidenceRow,
} from "../_shared/zoneTimeframeEvidence.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Gate 0: Only the cron scheduler may invoke this function.
  const authError = verifyCronCaller(req);
  if (authError) return authError;

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const results: Record<string, any> = {};

    // 1. Delete scan_logs older than 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { count: scanLogsDeleted, error: slErr } = await supabase
      .from("scan_logs")
      .delete({ count: "exact" })
      .lt("scanned_at", thirtyDaysAgo);
    if (slErr) console.error("[data-cleanup] scan_logs error:", slErr.message);
    results.scan_logs_deleted = scanLogsDeleted || 0;

    // 2. Delete close_audit_log older than 30 days
    const { count: auditDeleted, error: alErr } = await supabase
      .from("close_audit_log")
      .delete({ count: "exact" })
      .lt("created_at", thirtyDaysAgo);
    if (alErr) console.error("[data-cleanup] close_audit_log error:", alErr.message);
    results.audit_log_deleted = auditDeleted || 0;

    // 3. Archive paper_trade_history older than 90 days
    // First, copy to trade_archive table (create if not exists via migration)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: oldTrades, error: fetchErr } = await supabase
      .from("paper_trade_history")
      .select("*")
      .lt("closed_at", ninetyDaysAgo)
      .limit(1000); // Process in batches of 1000

    if (fetchErr) {
      console.error("[data-cleanup] paper_trade_history fetch error:", fetchErr.message);
    } else if (oldTrades && oldTrades.length > 0) {
      // Insert into archive table
      const { error: archiveErr } = await supabase
        .from("trade_archive")
        .upsert(oldTrades, { onConflict: "id" });

      if (archiveErr) {
        console.error("[data-cleanup] trade_archive insert error:", archiveErr.message);
        // If archive table doesn't exist, just log and skip
        results.trade_archive_error = archiveErr.message;
      } else {
        // Delete archived records from source
        const ids = oldTrades.map((t: any) => t.id);
        const { count: tradesDeleted, error: delErr } = await supabase
          .from("paper_trade_history")
          .delete({ count: "exact" })
          .in("id", ids);
        if (delErr) console.error("[data-cleanup] paper_trade_history delete error:", delErr.message);
        results.trades_archived = tradesDeleted || 0;
      }
    } else {
      results.trades_archived = 0;
    }

    console.log("[data-cleanup] Results:", JSON.stringify(results));

    // 4. Zone timeframe evidence — adaptive retention.
    //    Raw payloads: 30 days, or 90 days when linked to a setup, trade,
    //    lifecycle event, disagreement or golden replay. Compact summaries
    //    preserve lineage indefinitely.
    try {
      const linkedFilter =
        "linked_setup_id.not.is.null,linked_trade_id.not.is.null,event_linked.eq.true,has_disagreement.eq.true,golden_replay_linked.eq.true";
      const routineFilter =
        "linked_setup_id.is.null,linked_trade_id.is.null,event_linked.eq.false,has_disagreement.eq.false,golden_replay_linked.eq.false";
      let compacted = 0;
      let batches = 0;
      const maxBatches = 20;
      const batchSize = 500;

      while (batches < maxBatches) {
        const { data: expiring, error: expErr } = await supabase
          .from("zone_timeframe_evidence")
          .select("*")
          .or(
            `and(observed_at.lt.${thirtyDaysAgo},${routineFilter}),`
            + `and(observed_at.lt.${ninetyDaysAgo},or(${linkedFilter}))`,
          )
          .order("observed_at", { ascending: true })
          .limit(batchSize);
        if (expErr) throw new Error(expErr.message);
        if (!expiring || expiring.length === 0) break;

        const summaries = expiring.map((row: EvidenceRow) => ({
          evidence_id: row.id,
          user_id: row.user_id,
          bot_id: row.bot_id,
          symbol: row.symbol,
          direction: row.direction,
          scan_cycle_id: row.scan_cycle_id,
          observed_at: row.observed_at,
          parent_evidence_id: row.parent_evidence_id ?? null,
          evidence_source: row.evidence_source,
          contract_version: row.contract_version ?? null,
          trading_style: row.trading_style ?? null,
          style_policy_version: row.style_policy_version ?? null,
          style_base_policy_hash: row.style_base_policy_hash ?? null,
          style_policy_hash: row.style_policy_hash ?? null,
          style_policy_snapshot: row.style_policy_snapshot ?? null,
          canonical_detector_version:
            row.canonical_detector_version ?? null,
          canonical_parity: row.canonical_parity ?? null,
          pending_order_id: row.pending_order_id ?? null,
          confirmation_attempt: row.confirmation_attempt ?? 0,
          event_linked: row.event_linked ?? false,
          has_disagreement: row.has_disagreement ?? false,
          golden_replay_linked: row.golden_replay_linked ?? false,
          ...buildCompactSummary(row),
        }));
        const { error: sumErr } = await supabase
          .from("zone_timeframe_evidence_summary")
          .upsert(summaries, { onConflict: "evidence_id", ignoreDuplicates: true });
        if (sumErr) throw new Error(sumErr.message);
        const { count: evidenceDeleted, error: delEvErr } = await supabase
          .from("zone_timeframe_evidence")
          .delete({ count: "exact" })
          .in("id", expiring.map((r: any) => r.id));
        if (delEvErr) throw new Error(delEvErr.message);
        compacted += evidenceDeleted || 0;
        batches++;
        if (expiring.length < batchSize) break;
      }
      results.zone_evidence_compacted = compacted;
      results.zone_evidence_compaction_batches = batches;
      results.zone_evidence_backlog_possible = batches === maxBatches;

      const { count: countersDeleted, error: counterErr } = await supabase
        .from("zone_confirmation_evidence_counters")
        .delete({ count: "exact" })
        .lt("updated_at", ninetyDaysAgo);
      if (counterErr) throw new Error(counterErr.message);
      results.zone_confirmation_counters_deleted = countersDeleted || 0;
    } catch (evErr: any) {
      console.error("[data-cleanup] zone_timeframe_evidence error:", evErr?.message);
      results.zone_evidence_error = evErr?.message;
    }

    console.log("[data-cleanup] Evidence retention:", JSON.stringify({
      compacted: results.zone_evidence_compacted,
      error: results.zone_evidence_error ?? null,
    }));

    return new Response(JSON.stringify({ success: true, ...results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("[data-cleanup] Fatal error:", error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
