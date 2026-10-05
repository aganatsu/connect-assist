// M12: Data Retention Policy — scheduled daily cleanup
// Run via Supabase cron: SELECT cron.schedule('daily-cleanup', '0 3 * * *', $$SELECT net.http_post(...)$$);
//
// Retention rules:
// - scan_logs: delete rows older than 30 days
// - structure_shadow_telemetry: delete rows older than 30 days
//
// NOT pruned, on purpose:
// - close_audit_log. It is the independent record of every close attempt —
//   the only evidence that USD/JPY 0e76555c was closed twice on 2026-09-16,
//   and the source its lost history row was rebuilt from. At ~80 rows a
//   month it costs nothing to keep. Deleting it after 30 days had already
//   removed everything before 2026-09-05.
// - paper_trade_history. Every settled trade's history row is referenced by
//   paper_account_ledger.history_id. The old 90-day "archive" step upserted
//   46-column history rows into the 18-column trade_archive, which failed on
//   every run (trade_archive has 0 rows), so it never deleted anything — but
//   it would have the day the upsert succeeded.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

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

    // 2. Delete structure_shadow_telemetry older than 30 days
    // Shadow diagnostics, not trading records — nothing reads them and they
    // have no archival value once the candidate engine is decided.
    const { count: shadowDeleted, error: sstErr } = await supabase
      .from("structure_shadow_telemetry")
      .delete({ count: "exact" })
      .lt("observed_at", thirtyDaysAgo);
    if (sstErr) console.error("[data-cleanup] structure_shadow_telemetry error:", sstErr.message);
    results.structure_shadow_telemetry_deleted = shadowDeleted || 0;

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
