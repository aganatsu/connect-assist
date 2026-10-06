// System reset — admin-only readiness, dry run, and the approved reset.
//
// Called from the "System Reset & Ledger Health" card in the web app with the
// signed-in user's session token. Every action verifies, SERVER-SIDE, that the
// caller is a human user listed in app_admins; a service-role token is
// refused, so no cron or script can trigger a reset.
//
//   { action: "readiness" }   read-only: every metric, condition, and the
//                             old-period positions/orders/setups + fingerprint
//   { action: "dry_run" }     read-only: readiness + what the reset WOULD do
//                             (each close at market with its P&L)
//   { action: "execute", confirmation: "RESET 100000", fingerprint, requested_at }
//                             runs _shared/systemReset.ts runSystemReset —
//                             only if system_reset_controls.execute_enabled,
//                             readiness is all green, and the fingerprint the
//                             dialog showed still matches.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";
import { corsHeaders } from "../_shared/cors.ts";
import { evaluateSettlementHealth } from "../_shared/settlementMonitor.ts";
import { loadMonitorInput, SMC_BOT_ID } from "../_shared/settlementMonitorLoad.ts";
import { interpretSettlement } from "../_shared/paperSettlement.ts";
import { carryToHistory } from "../_shared/smcTradeTelemetry.ts";
import { parseRateCache, rateCacheKey, requiredRatePairs } from "../_shared/rateMapPolicy.ts";
import {
  evaluateResetReadiness, fingerprint, flattenPnl, MARKET_DATA_MAX_AGE_MIN, runSystemReset,
  type OldOrder, type OldPosition, type OldSetup, type ResetDeps,
} from "../_shared/systemReset.ts";

const LIVE_PENDING = ["pending", "awaiting_confirmation", "triggered"];
const ACTIVE_SETUPS = ["watching", "qualified", "pending", "awaiting_confirmation"];

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
  const db = createClient(url, serviceKey);

  // ── Who is calling? A real user session, and an admin. ──
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  if (!token || token === serviceKey) return respond({ error: "admin user session required" }, 403);
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  const userId = userData?.user?.id;
  if (userErr || !userId) return respond({ error: "invalid session" }, 401);
  const { data: isAdmin, error: adminErr } = await db.rpc("is_app_admin", { p_user_id: userId });
  if (adminErr || isAdmin !== true) return respond({ error: "admin only" }, 403);

  const body = await req.json().catch(() => ({}));
  const deps = makeDeps(db);

  try {
    if (body.action === "readiness") {
      const [readiness, recent] = await Promise.all([
        deps.readiness(),
        must<any[]>("recent reset runs", db.from("account_reset_runs")
          .select("reset_id, status, requested_at, started_at, completed_at, failed_step, failure_reason, pre_reset_balance, post_reset_balance, success")
          .order("requested_at", { ascending: false }).limit(5)),
      ]);
      return respond({ ...readiness, recent_runs: recent });
    }
    if (body.action === "dry_run") {
      const readiness = await deps.readiness();
      const rates = await deps.rates();
      const plan = readiness.old_period.positions.map((p) => {
        const px = p.current_price ?? 0;
        const f = flattenPnl(p, px, rates.rateMap);
        return { position_id: p.position_id, symbol: p.symbol, direction: p.direction, size: p.size, entry: p.entry_price, exit: px, pnl: f.pnl, missing_rate: f.missingRate };
      });
      return respond({
        readiness, rates: { ok: rates.ok, detail: rates.detail },
        plan: {
          close_at_market: plan,
          old_period_pnl_from_closes: Number(plan.reduce((s, p) => s + p.pnl, 0).toFixed(2)),
          cancel_orders: readiness.old_period.pending, cancel_setups: readiness.old_period.setups,
          then: ["verify old-period settlements", "in-DB snapshot", "reset_paper_account(100000)", "clear active state", "verify", "stay PAUSED and entries-LOCKED until the new configuration is approved"],
        },
      });
    }
    if (body.action === "execute") {
      const account = await must<any>("account", db.from("paper_accounts").select("id").eq("bot_id", SMC_BOT_ID).single());
      const result = await runSystemReset(deps, {
        requestedBy: userId,
        requestedAt: typeof body.requested_at === "string" ? body.requested_at : new Date().toISOString(),
        confirmation: String(body.confirmation ?? ""),
        fingerprint: String(body.fingerprint ?? ""),
        accountId: account.id,
      });
      return respond(result, result.status === "succeeded" ? 200 : result.status === "aborted" ? 409 : 500);
    }
    return respond({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(`[system-reset] ${body.action} error: ${(e as Error).message}`);
    return respond({ error: (e as Error).message }, 500);
  }
});

function makeDeps(db: any): ResetDeps {
  let cachedUser: string | null = null;
  const account = async () => must<any>("paper_accounts", db.from("paper_accounts").select("*").eq("bot_id", SMC_BOT_ID).single());
  const userIdOf = async () => cachedUser ??= (await account()).user_id;

  const rates = async () => {
    const userId = await userIdOf();
    const positions = await must<any[]>("positions", db.from("paper_positions").select("symbol").eq("user_id", userId).eq("bot_id", SMC_BOT_ID));
    const needed = requiredRatePairs(positions.map((p) => p.symbol));
    const { data: kv } = await db.from("kv_cache").select("value").eq("key", rateCacheKey(userId, SMC_BOT_ID)).maybeSingle();
    const cache = parseRateCache(typeof kv?.value === "string" ? kv.value : kv?.value ? JSON.stringify(kv.value) : null);
    const rateMap: Record<string, number> = {};
    const problems: string[] = [];
    for (const pair of needed) {
      const c = cache[pair];
      if (!c) { problems.push(`${pair} missing`); continue; }
      const ageMin = (Date.now() - Date.parse(c.at)) / 60000;
      if (ageMin > MARKET_DATA_MAX_AGE_MIN) problems.push(`${pair} ${ageMin.toFixed(0)}min old`);
      rateMap[pair] = c.rate;
    }
    return { ok: problems.length === 0, rateMap, detail: problems.length ? problems.join(", ") : needed.length ? `${needed.join(", ")} fresh` : "no FX conversion needed" };
  };

  const openPositions = async (): Promise<OldPosition[]> => {
    const userId = await userIdOf();
    const rows = await must<any[]>("positions", db.from("paper_positions")
      .select("id, position_id, symbol, direction, size, entry_price, current_price, stop_loss, take_profit, open_time, created_at")
      .eq("user_id", userId).eq("bot_id", SMC_BOT_ID).order("created_at", { ascending: true }));
    const r = await rates();
    return rows.map((p) => {
      const pos = { ...p, size: Number(p.size), entry_price: Number(p.entry_price), current_price: p.current_price === null ? null : Number(p.current_price) };
      const f = pos.current_price ? flattenPnl(pos, pos.current_price, r.rateMap) : null;
      return { ...pos, unrealized_usd: f && !f.missingRate ? f.pnl : null };
    });
  };
  const livePending = async (): Promise<OldOrder[]> => must<any[]>("pending_orders", db.from("pending_orders")
    .select("id, order_id, symbol, direction, status, entry_price, placed_at, expires_at")
    .eq("user_id", await userIdOf()).eq("bot_id", SMC_BOT_ID).in("status", LIVE_PENDING).order("placed_at", { ascending: true }));
  const activeSetups = async (): Promise<OldSetup[]> => must<any[]>("staged_setups", db.from("staged_setups")
    .select("id, symbol, direction, status, created_at")
    .eq("user_id", await userIdOf()).eq("bot_id", SMC_BOT_ID).in("status", ACTIVE_SETUPS));

  return {
    now: () => new Date().toISOString(),

    async readiness() {
      const now = new Date().toISOString();
      const { input, account: acct, recon } = await loadMonitorInput(db, now);
      const [runs, guard, objects, positions, pending, setups, running, controls, telemetry, r] = await Promise.all([
        must<any[]>("monitor runs", db.from("settlement_monitor_runs").select("id, run_at, mode, pass, failures, epoch_id")
          .gte("run_at", acct.ledger_epoch_started_at).order("run_at", { ascending: true })),
        must<any>("guard", db.from("paper_ledger_guard").select("mode").eq("id", 1).single()),
        must<Record<string, boolean>>("objects", db.rpc("accounting_objects_present")),
        openPositions(), livePending(), activeSetups(),
        must<any[]>("reset runs", db.from("account_reset_runs").select("reset_id").eq("status", "running")),
        must<any>("controls", db.from("system_reset_controls").select("execute_enabled").eq("id", 1).single()),
        db.from("kv_cache").select("updated_at").eq("key", `smc_mgmt_telemetry:${SMC_BOT_ID}:${acct.user_id}`).maybeSingle(),
        rates(),
      ]);
      const mgmtAgeMin = telemetry?.data?.updated_at ? (Date.now() - Date.parse(telemetry.data.updated_at)) / 60000 : Infinity;
      const marketOk = r.ok && mgmtAgeMin <= MARKET_DATA_MAX_AGE_MIN;
      const readiness = evaluateResetReadiness({
        now,
        account: {
          id: acct.id, balance: Number(acct.balance), peak_balance: Number(acct.peak_balance), daily_pnl_base: Number(acct.daily_pnl_base),
          is_paused: acct.is_paused, ledger_epoch_id: acct.ledger_epoch_id, ledger_epoch_started_at: acct.ledger_epoch_started_at, ledger_reset_at: acct.ledger_reset_at,
        },
        monitorRuns: runs,
        liveHealth: evaluateSettlementHealth(input),
        reconDrift: recon.drift === null ? null : Number(recon.drift),
        guardMode: guard.mode,
        objectsPresent: objects,
        openPositions: positions, livePending: pending, activeSetups: setups,
        marketData: { ok: marketOk, detail: `${r.detail}; prices refreshed ${Number.isFinite(mgmtAgeMin) ? `${mgmtAgeMin.toFixed(1)}min ago` : "never"}` },
        resetRunning: running.length > 0,
        executeEnabled: controls.execute_enabled === true,
      });
      return { ...readiness, fingerprint: await fingerprint(readiness.fingerprint_basis) };
    },

    async insertRun(row) {
      const data = await must<any>("insert reset run", db.from("account_reset_runs").insert(row).select("reset_id").single());
      return data.reset_id;
    },
    async updateRun(resetId, patch) {
      await must("update reset run", db.from("account_reset_runs").update(patch).eq("reset_id", resetId));
    },
    async setPaused(paused) {
      await must("pause", db.from("paper_accounts").update({ is_paused: paused }).eq("bot_id", SMC_BOT_ID));
    },
    async lockEntries(reason) {
      await must("lock entries", db.from("paper_accounts")
        .update({ entries_locked: true, entries_locked_reason: reason, entries_locked_at: new Date().toISOString() })
        .eq("bot_id", SMC_BOT_ID));
    },
    async cancelOldPending(boundary) {
      return must<any[]>("cancel pending", db.from("pending_orders")
        .update({ status: "cancelled", cancel_reason: "account_reset", resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("user_id", await userIdOf()).eq("bot_id", SMC_BOT_ID).in("status", LIVE_PENDING).lt("placed_at", boundary)
        .select("id, order_id, symbol, direction, status, entry_price, placed_at, expires_at"));
    },
    async cancelOldSetups(boundary) {
      return must<any[]>("cancel setups", db.from("staged_setups")
        .update({ status: "cancelled", lifecycle_reason: "account_reset", resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("user_id", await userIdOf()).eq("bot_id", SMC_BOT_ID).in("status", ACTIVE_SETUPS).lt("created_at", boundary)
        .select("id, symbol, direction, status, created_at"));
    },
    openPositions,
    livePending,
    rates,
    async settleFlatten(pos, exitPrice, pnl, pnlPips, resetId) {
      const full = await must<any>("position", db.from("paper_positions").select("*").eq("id", pos.id).maybeSingle());
      if (!full) return { outcome: "already_settled", detail: "position no longer open" };
      const { data, error } = await db.rpc("settle_paper_position", {
        p_position_row_id: pos.id, p_user_id: full.user_id, p_bot_id: SMC_BOT_ID, p_source: "account_reset_flatten",
        p_history: {
          ...carryToHistory(full, { exitPrice, direction: full.direction }),
          symbol: full.symbol, direction: full.direction, size: full.size, entry_price: full.entry_price,
          exit_price: exitPrice, pnl: pnl.toFixed(2), pnl_pips: pnlPips.toFixed(1),
          open_time: full.open_time, closed_at: new Date().toISOString(), close_reason: "account_reset_flatten",
          signal_reason: full.signal_reason || "", signal_score: full.signal_score || "0", order_id: full.order_id || "",
          stop_loss: full.stop_loss, take_profit: full.take_profit,
        },
      });
      const o = interpretSettlement(data, error);
      return o.outcome === "settled" ? { outcome: "settled", amount: o.amount, balance: o.balance }
        : { outcome: o.outcome, detail: o.outcome === "failed" ? o.error : o.outcome === "rejected" ? `${o.code} ${o.reason ?? ""}` : `reset ${resetId}` };
    },
    async ledgerHealth() {
      const { input, recon } = await loadMonitorInput(db);
      return { health: evaluateSettlementHealth(input), balance: input.account.balance, realizedThisEpoch: Number(recon.realized_pnl_this_epoch ?? 0) };
    },
    async takeSnapshot(resetId, data) {
      const acct = await account();
      const [ledger, recon, history, config, lastHash] = await Promise.all([
        must<any[]>("ledger", db.from("paper_account_ledger").select("*").eq("account_id", acct.id).order("seq", { ascending: true }).limit(10000)),
        must<any>("recon", db.from("paper_account_reconciliation").select("*").eq("account_id", acct.id).single()),
        must<any[]>("history", (acct.ledger_reset_at
          ? db.from("paper_trade_history").select("*").eq("user_id", acct.user_id).gte("closed_at", acct.ledger_reset_at)
          : db.from("paper_trade_history").select("*").eq("user_id", acct.user_id)).order("closed_at", { ascending: true }).limit(10000)),
        db.from("bot_configs").select("id, config_json, updated_at").eq("user_id", acct.user_id).is("connection_id", null).maybeSingle(),
        db.from("bot_config_change_log").select("next_hash, changed_at").eq("user_id", acct.user_id).order("changed_at", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const row = await must<any>("snapshot", db.from("account_reset_snapshots").insert({
        reset_id: resetId, account: acct, ledger, reconciliation: recon, period_history: history,
        closed_positions: data.closed_positions, cancelled_orders: data.cancelled_orders, cancelled_setups: data.cancelled_setups,
        config: config?.data ?? null, config_hash: lastHash?.data?.next_hash ?? null,
        row_counts: { ledger: ledger.length, period_history: history.length },
      }).select("id").single());
      return row.id;
    },
    async resetAccount(amount, reason) {
      const acct = await account();
      return must<any>("reset_paper_account", db.rpc("reset_paper_account", { p_user_id: acct.user_id, p_bot_id: SMC_BOT_ID, p_new_balance: amount, p_reason: reason }));
    },
    async clearActiveState() {
      const acct = await account();
      await must("clear counters", db.from("paper_accounts").update({
        scan_count: 0, signal_count: 0, rejected_count: 0, kill_switch_active: false, scan_lock_until: null, started_at: new Date().toISOString(),
      }).eq("id", acct.id));
      const deleted = await must<any[]>("conviction state", db.from("kv_cache").delete().like("key", `thesis_conviction:${acct.user_id}:${SMC_BOT_ID}:%`).select("key"));
      return { counters_reset: true, conviction_keys_deleted: deleted.length };
    },
    async postResetState() {
      const acct = await account();
      const [recon, positions, oldPositions, pending, setups, history, last] = await Promise.all([
        must<any>("recon", db.from("paper_account_reconciliation").select("drift, realized_pnl_this_epoch, unledgered_writes_this_epoch").eq("account_id", acct.id).single()),
        must<any[]>("positions", db.from("paper_positions").select("id").eq("user_id", acct.user_id).eq("bot_id", SMC_BOT_ID)),
        must<any[]>("old positions", db.from("paper_positions").select("id").eq("user_id", acct.user_id).lt("created_at", acct.ledger_reset_at ?? "9999-01-01")),
        must<any[]>("pending", db.from("pending_orders").select("id").eq("user_id", acct.user_id).eq("bot_id", SMC_BOT_ID).in("status", LIVE_PENDING)),
        must<any[]>("setups", db.from("staged_setups").select("id").eq("user_id", acct.user_id).eq("bot_id", SMC_BOT_ID).in("status", ACTIVE_SETUPS)),
        must<any[]>("history since reset", db.from("paper_trade_history").select("pnl").eq("user_id", acct.user_id).gte("closed_at", acct.ledger_reset_at ?? "9999-01-01")),
        must<any>("last ledger", db.from("paper_account_ledger").select("kind").eq("account_id", acct.id).order("seq", { ascending: false }).limit(1).single()),
      ]);
      const balance = Number(acct.balance);
      return {
        balance, peak_balance: Number(acct.peak_balance), daily_pnl_base: Number(acct.daily_pnl_base),
        equity: positions.length === 0 ? balance : NaN,
        realized_pnl_this_epoch: Number(recon.realized_pnl_this_epoch ?? 0), unrealized_pnl: positions.length === 0 ? 0 : NaN,
        open_positions: positions.length, positions_opened_before_reset: oldPositions.length,
        pending_orders: pending.length, active_setups: setups.length,
        daily_pnl: history.reduce((s, h) => s + Number(h.pnl ?? 0), 0),
        drift: recon.drift === null ? null : Number(recon.drift),
        unledgered_writes_this_epoch: Number(recon.unledgered_writes_this_epoch ?? 0),
        last_ledger_kind: last.kind, ledger_reset_at: acct.ledger_reset_at,
        is_paused: acct.is_paused === true, entries_locked: acct.entries_locked === true,
      };
    },
  };
}
