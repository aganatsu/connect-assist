// Admin users — read-only overview of every account in the app.
//
// Called from the Admin page with the signed-in user's session token. Like
// system-reset, every call verifies SERVER-SIDE that the caller is a human user
// listed in app_admins; a service-role token is refused.
//
//   { action: "overview" }  every auth user with sign-up/sign-in facts, paper
//                           accounts, bot status and activity counts, plus
//                           paper accounts whose user no longer exists, and every
//                           active scanner_operational_alerts row (nothing else shows them).

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import {
  buildUserRows, orphanAccounts, type ActivityFacts, type AuthUserFacts, type PaperAccountFacts,
} from "../_shared/adminUsers.ts";

const respond = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function count(db: SupabaseClient, table: string, userId: string, filter?: (q: any) => any): Promise<number> {
  let q = db.from(table).select("id", { count: "exact", head: true }).eq("user_id", userId);
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return n ?? 0;
}

async function activityFor(db: SupabaseClient, userId: string): Promise<ActivityFacts> {
  const [scans, lastScan, trades, openPositions, backtests, configs, brokers, tasks] = await Promise.all([
    count(db, "scan_logs", userId),
    db.from("scan_logs").select("scanned_at").eq("user_id", userId).order("scanned_at", { ascending: false }).limit(1),
    db.from("paper_trade_history").select("pnl, closed_at").eq("user_id", userId).order("closed_at", { ascending: false }).limit(5000),
    count(db, "paper_positions", userId),
    count(db, "backtest_runs", userId),
    count(db, "bot_configs", userId),
    count(db, "broker_connections", userId),
    count(db, "scheduled_tasks", userId, (q) => q.eq("enabled", true)),
  ]);
  if (lastScan.error) throw new Error(`scan_logs latest: ${lastScan.error.message}`);
  if (trades.error) throw new Error(`paper_trade_history: ${trades.error.message}`);
  const t = trades.data ?? [];
  return {
    scans,
    last_scan_at: lastScan.data?.[0]?.scanned_at ?? null,
    closed_trades: t.length,
    realized_pnl: Math.round(t.reduce((s, r) => s + (Number(r.pnl) || 0), 0) * 100) / 100,
    last_trade_at: t[0]?.closed_at ?? null,
    open_positions: openPositions,
    backtests,
    has_bot_config: configs > 0,
    broker_connections: brokers,
    enabled_tasks: tasks,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, serviceKey);

  // ── Who is calling? A real user session, and an admin. ──
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  if (!token || token === serviceKey) return respond({ error: "admin user session required" }, 403);
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  const callerId = userData?.user?.id;
  if (userErr || !callerId) return respond({ error: "invalid session" }, 401);
  const { data: isAdmin, error: adminErr } = await db.rpc("is_app_admin", { p_user_id: callerId });
  if (adminErr || isAdmin !== true) return respond({ error: "admin only" }, 403);

  const body = await req.json().catch(() => ({}));
  if (body.action !== "overview") return respond({ error: `unknown action: ${body.action}` }, 400);

  try {
    const { data: list, error: listErr } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) throw new Error(`list users: ${listErr.message}`);
    const users: AuthUserFacts[] = list.users.map((u) => ({
      id: u.id,
      email: u.email ?? null,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      email_confirmed_at: u.email_confirmed_at ?? null,
      provider: (u.app_metadata?.provider as string | undefined) ?? null,
    }));
    const { data: accounts, error: accErr } = await db.from("paper_accounts")
      .select("id, user_id, bot_id, balance, peak_balance, is_running, is_paused, execution_mode, created_at");
    if (accErr) throw new Error(`paper_accounts: ${accErr.message}`);
    const adminIds = new Set<string>();
    const activity = new Map<string, ActivityFacts>();
    await Promise.all(users.map(async (u) => {
      activity.set(u.id, await activityFor(db, u.id));
      const { data: a } = await db.rpc("is_app_admin", { p_user_id: u.id });
      if (a === true) adminIds.add(u.id);
    }));
    const acc = (accounts ?? []) as PaperAccountFacts[];
    const { data: alerts, error: alErr } = await db.from("scanner_operational_alerts")
      .select("id, user_id, bot_id, alert_type, severity, title, message, occurrences, first_detected_at, last_detected_at")
      .eq("status", "active").order("last_detected_at", { ascending: false }).limit(50);
    if (alErr) throw new Error(`scanner_operational_alerts: ${alErr.message}`);
    const emailOf = new Map(users.map((u) => [u.id, u.email]));
    return respond({
      generated_at: new Date().toISOString(),
      users: buildUserRows(users, acc, activity, adminIds, new Date()),
      orphan_accounts: orphanAccounts(users, acc),
      active_alerts: (alerts ?? []).map((x) => ({ ...x, email: emailOf.get(x.user_id) ?? null })),
    });
  } catch (e) {
    return respond({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
