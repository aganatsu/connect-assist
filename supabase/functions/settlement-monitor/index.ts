// Settlement monitor — scheduled health check for the paper settlement ledger.
//
// READ-ONLY against trading state. It reads paper_accounts,
// paper_account_ledger, paper_account_reconciliation,
// paper_balance_unledgered_writes, paper_trade_history and close_audit_log,
// and writes exactly one row to settlement_monitor_runs per invocation. It
// never touches balances, positions, orders, the guard mode or config.
//
// Modes (POST body):
//   { "mode": "periodic" }  every 4h from pg_cron (supabase/cron/settlement_monitor_cron.sql)
//   { "mode": "final" }     once, 24h after the ledger epoch started: the
//                           window verdict. Reports PASS or FAIL and STOPS —
//                           enabling blocking mode and the reset are separate
//                           changes that need the user's approval.
//
// Failures — and the final verdict either way — go to Telegram through
// telegram-notify, the same path bot-scanner uses, and to the function log.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { evaluateSettlementHealth, evaluateWindow, formatAlert, isServiceRole } from "../_shared/settlementMonitor.ts";
import { loadMonitorInput } from "../_shared/settlementMonitorLoad.ts";

const BOT_ID = "smc";
const WINDOW_HOURS = 24;
const MIN_RUNS = 5;        // 4h cadence over 24h is 6; allow one late/missed fire
const MAX_GAP_HOURS = 5;   // a gap longer than this means the window was not watched

const respond = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function must<T>(label: string, q: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await q;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data as T;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Service role only: the cron job sends it; nothing else should run this.
  // The gateway has already verified the JWT signature (verify_jwt is on), so
  // the role claim is trustworthy; an exact match with this function's own key
  // is accepted too.
  if (!isServiceRole(req.headers.get("Authorization"), serviceKey)) return respond({ error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const mode: "periodic" | "final" = body.mode === "final" ? "final" : "periodic";
  const supabase = createClient(url, serviceKey);
  const now = new Date().toISOString();

  try {
    const { input, account } = await loadMonitorInput(supabase, now);
    const epoch = account.ledger_epoch_started_at as string;
    const result = evaluateSettlementHealth(input);

    let window: ReturnType<typeof evaluateWindow> | undefined;
    if (mode === "final") {
      const runs = await must<any[]>("settlement_monitor_runs", supabase.from("settlement_monitor_runs")
        .select("run_at, pass").eq("mode", "periodic").eq("epoch_id", account.ledger_epoch_id).gte("run_at", epoch));
      window = evaluateWindow({
        epochStartedAt: epoch, now, windowHours: WINDOW_HOURS, minRuns: MIN_RUNS, maxGapHours: MAX_GAP_HOURS,
        runs, finalCheck: result,
      });
    }
    const pass = mode === "final" ? window!.pass : result.pass;

    // Notify on any failure, and on the final verdict either way.
    let notified = false;
    if (!pass || mode === "final") {
      const text = formatAlert(mode, result, window);
      console.error(`[settlement-monitor] ${mode} ${pass ? "PASS" : "FAIL"}: ${text.replace(/\n+/g, " | ")}`);
      notified = await notifyTelegram(supabase, url, serviceKey, account.user_id, text);
    } else {
      console.log(`[settlement-monitor] periodic PASS at ${now}: balance ${input.account.balance} = ledger ${result.summary.ledger_balance}`);
    }

    const { error: insErr } = await supabase.from("settlement_monitor_runs").insert({
      mode, account_id: account.id, epoch_id: account.ledger_epoch_id, pass,
      checks: result.checks, failures: mode === "final" ? (window!.reasons.length ? window!.reasons : result.failures) : result.failures,
      summary: { ...result.summary, window }, notified,
    });
    // A second final for the same epoch hits the unique index: already decided.
    if (insErr && !(mode === "final" && /duplicate key/i.test(insErr.message))) throw new Error(`record run: ${insErr.message}`);

    return respond({ mode, pass, failures: result.failures.map((f) => f.name), window, notified, already_final: !!insErr });
  } catch (e) {
    // The monitor itself failing is a failure to watch — say so loudly.
    const msg = (e as Error)?.message ?? String(e);
    console.error(`[settlement-monitor] ${mode} ERROR: ${msg}`);
    try {
      const { data: acct } = await supabase.from("paper_accounts").select("user_id").eq("bot_id", BOT_ID).maybeSingle();
      if (acct?.user_id) {
        await notifyTelegram(supabase, url, serviceKey, acct.user_id,
          `🚨 SETTLEMENT MONITOR COULD NOT RUN (${mode})\n\n${msg}\n\nThe ledger was not checked this cycle.`);
      }
      await supabase.from("settlement_monitor_runs").insert({
        mode, pass: false, checks: [], failures: [{ name: "monitor_error", detail: msg }], summary: { now },
      });
    } catch { /* already logged */ }
    return respond({ mode, pass: false, error: msg }, 500);
  }
});

async function notifyTelegram(supabase: any, url: string, serviceKey: string, userId: string, text: string): Promise<boolean> {
  const { data: settings } = await supabase.from("user_settings").select("preferences_json").eq("user_id", userId).maybeSingle();
  const prefs = (settings?.preferences_json as any) || {};
  const list = Array.isArray(prefs.telegramChatIds) ? prefs.telegramChatIds : [];
  const ids: string[] = list.map((c: any) => typeof c === "string" ? c : String(c?.id ?? "")).filter(Boolean);
  if (ids.length === 0 && prefs.telegramChatId) ids.push(String(prefs.telegramChatId));
  if (ids.length === 0) {
    console.error("[settlement-monitor] no Telegram chat configured — alert only in settlement_monitor_runs and logs");
    return false;
  }
  const results = await Promise.all(ids.map(async (chatId) => {
    try {
      const r = await fetch(`${url}/functions/v1/telegram-notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ chat_id: chatId, message: text }),
      });
      if (!r.ok) console.error(`[settlement-monitor] telegram-notify ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.ok;
    } catch (e) {
      console.error(`[settlement-monitor] telegram-notify failed: ${(e as Error).message}`);
      return false;
    }
  }));
  return results.some(Boolean);
}
