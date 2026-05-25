// ═══════════════════════════════════════════════════════════════════════════
// Scheduled Tasks Manager — CRUD for cron job configuration
// ═══════════════════════════════════════════════════════════════════════════
// Actions:
//   list    → returns all scheduled tasks for the user
//   update  → update interval/enabled for a specific task
//   run_now → manually trigger a specific function immediately
//   logs    → get recent execution logs for a task
// ═══════════════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Default task definitions (seed data) ──
const DEFAULT_TASKS = [
  {
    function_name: "bot-scanner",
    action: "scan",
    display_name: "Bot Scanner",
    description: "Full pair analysis — detects setups, scores confluence, places trades",
    default_interval_minutes: 5,
    cron_expression: "*/5 * * * *",
    category: "scanning",
  },
  {
    function_name: "bot-scanner",
    action: "manage",
    display_name: "Trade Management",
    description: "Trailing SL, break-even, partial TP, pending order monitoring",
    default_interval_minutes: 1,
    cron_expression: "* * * * *",
    category: "management",
  },
  {
    function_name: "zone-confirmation-scanner",
    action: "scan",
    display_name: "Zone Confirmation (Fast)",
    description: "1-min fast-poll for CHoCH detection on orders hunting confirmation",
    default_interval_minutes: 1,
    cron_expression: "* * * * *",
    category: "scanning",
  },
  {
    function_name: "outcome-tracker",
    action: "track",
    display_name: "Outcome Tracker",
    description: "Resolves rejected setups — checks if they would have won or lost",
    default_interval_minutes: 60,
    cron_expression: "0 * * * *",
    category: "analytics",
  },
  {
    function_name: "bot-daily-review",
    action: "review",
    display_name: "Daily Review",
    description: "AI analysis of today's trades, generates Telegram summary",
    default_interval_minutes: 1440,
    cron_expression: "0 22 * * *",
    category: "analytics",
  },
  {
    function_name: "bot-weekly-advisor",
    action: "advise",
    display_name: "Weekly Advisor",
    description: "Deep strategy analysis — factor weights, regime detection, recommendations",
    default_interval_minutes: 10080,
    cron_expression: "0 23 * * 0",
    category: "analytics",
  },
  {
    function_name: "prop-firm-daily-reset",
    action: "reset",
    display_name: "Prop Firm Daily Reset",
    description: "Finalizes daily P&L, resets drawdown tracking for prop firm compliance",
    default_interval_minutes: 1440,
    cron_expression: "0 22 * * *",
    category: "management",
  },
  {
    function_name: "data-cleanup",
    action: "cleanup",
    display_name: "Data Cleanup",
    description: "Deletes old scan logs and expired data per retention policy",
    default_interval_minutes: 1440,
    cron_expression: "0 3 * * *",
    category: "maintenance",
  },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");

    // Create user-context client for auth
    const supabase = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return respond({ error: "Unauthorized" }, 401);

    // Admin client for operations
    const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "list";

    // ── LIST: Get all scheduled tasks ──
    if (action === "list") {
      const { data: tasks } = await adminClient
        .from("scheduled_tasks")
        .select("*")
        .eq("user_id", user.id)
        .order("category", { ascending: true });

      // If no tasks exist yet, seed them
      if (!tasks || tasks.length === 0) {
        const seeded = DEFAULT_TASKS.map((t) => ({
          ...t,
          user_id: user.id,
          enabled: true,
          interval_minutes: t.default_interval_minutes,
          last_run_at: null,
          last_status: null,
          last_error: null,
          run_count: 0,
        }));
        await adminClient.from("scheduled_tasks").insert(seeded);
        const { data: freshTasks } = await adminClient
          .from("scheduled_tasks")
          .select("*")
          .eq("user_id", user.id)
          .order("category", { ascending: true });
        return respond({ tasks: freshTasks });
      }

      return respond({ tasks });
    }

    // ── UPDATE: Change interval or enabled state ──
    if (action === "update") {
      const { taskId, enabled, interval_minutes, cron_expression } = body;
      if (!taskId) return respond({ error: "taskId required" }, 400);

      const updates: Record<string, any> = {};
      if (typeof enabled === "boolean") updates.enabled = enabled;
      if (typeof interval_minutes === "number" && interval_minutes > 0) updates.interval_minutes = interval_minutes;
      if (typeof cron_expression === "string") updates.cron_expression = cron_expression;
      updates.updated_at = new Date().toISOString();

      const { error } = await adminClient
        .from("scheduled_tasks")
        .update(updates)
        .eq("id", taskId)
        .eq("user_id", user.id);

      if (error) return respond({ error: error.message }, 500);

      // If this is the bot-scanner scan task and interval changed, also update bot_configs
      if (updates.interval_minutes) {
        const { data: task } = await adminClient
          .from("scheduled_tasks")
          .select("function_name, action")
          .eq("id", taskId)
          .single();
        if (task?.function_name === "bot-scanner" && task?.action === "scan") {
          // Update the scanIntervalMinutes in bot_configs
          const { data: config } = await adminClient
            .from("bot_configs")
            .select("id, config")
            .eq("user_id", user.id)
            .order("updated_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          if (config) {
            const cfg = config.config || {};
            const entry = cfg.entry || {};
            entry.scanIntervalMinutes = updates.interval_minutes;
            cfg.entry = entry;
            await adminClient
              .from("bot_configs")
              .update({ config: cfg, updated_at: new Date().toISOString() })
              .eq("id", config.id);
          }
        }
      }

      return respond({ ok: true });
    }

    // ── RUN_NOW: Manually trigger a function ──
    if (action === "run_now") {
      const { taskId } = body;
      if (!taskId) return respond({ error: "taskId required" }, 400);

      const { data: task } = await adminClient
        .from("scheduled_tasks")
        .select("*")
        .eq("id", taskId)
        .eq("user_id", user.id)
        .single();

      if (!task) return respond({ error: "Task not found" }, 404);

      // Invoke the function
      const functionBody: Record<string, any> = {};
      if (task.function_name === "bot-scanner") {
        functionBody.action = task.action === "manage" ? "manage" : "manual_scan";
      }

      try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/${task.function_name}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
            "apikey": SERVICE_ROLE_KEY,
          },
          body: JSON.stringify(functionBody),
        });

        const result = await response.text();
        const status = response.ok ? "success" : "error";

        // Update last run
        await adminClient
          .from("scheduled_tasks")
          .update({
            last_run_at: new Date().toISOString(),
            last_status: status,
            last_error: status === "error" ? result.slice(0, 500) : null,
            run_count: task.run_count + 1,
          })
          .eq("id", taskId);

        return respond({ ok: true, status, result: result.slice(0, 200) });
      } catch (err: any) {
        await adminClient
          .from("scheduled_tasks")
          .update({
            last_run_at: new Date().toISOString(),
            last_status: "error",
            last_error: err.message?.slice(0, 500),
          })
          .eq("id", taskId);
        return respond({ ok: false, error: err.message }, 500);
      }
    }

    // ── LOGS: Get recent execution history ──
    if (action === "logs") {
      const { taskId, limit = 20 } = body;
      if (!taskId) return respond({ error: "taskId required" }, 400);

      const { data: task } = await adminClient
        .from("scheduled_tasks")
        .select("function_name, action")
        .eq("id", taskId)
        .eq("user_id", user.id)
        .single();

      if (!task) return respond({ error: "Task not found" }, 404);

      // Pull from scan_logs for bot-scanner, or scheduled_task_logs for others
      if (task.function_name === "bot-scanner") {
        const { data: logs } = await adminClient
          .from("scan_logs")
          .select("id, created_at, pairs_scanned, signals_found, trades_placed, skipped_reason, scan_cycle_id")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(limit);
        return respond({ logs: logs || [] });
      }

      // Generic logs from scheduled_task_logs
      const { data: logs } = await adminClient
        .from("scheduled_task_logs")
        .select("*")
        .eq("task_id", taskId)
        .order("created_at", { ascending: false })
        .limit(limit);

      return respond({ logs: logs || [] });
    }

    return respond({ error: `Unknown action: ${action}` }, 400);
  } catch (err: any) {
    return respond({ error: err.message }, 500);
  }
});
