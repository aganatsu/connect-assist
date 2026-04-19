// M12: Data Retention Policy — scheduled daily cleanup
// Run via Supabase cron: SELECT cron.schedule('daily-cleanup', '0 3 * * *', $$SELECT net.http_post(...)$$);
//
// Retention rules:
// - scan_logs: delete rows older than 30 days
// - close_audit_log: delete rows older than 30 days
// - paper_trade_history: archive rows older than 90 days to trade_archive

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

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
