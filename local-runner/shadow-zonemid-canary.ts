/**
 * Candidate C shadow — canary monitor. READ-ONLY (SELECT via PostgREST); prints aggregates, writes nothing.
 * Spec: docs/SHADOW_ZONEMID_V1.md. Reports the canary's stop conditions, the second-poller invalidation check,
 * C's lifecycle counts and cache coverage against the ≥90% overall / ≥80% per-pair validity gate.
 *
 *   deno run --allow-read --allow-net --allow-env local-runner/shadow-zonemid-canary.ts <windowStartIso>
 *   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from local-runner/.env.local, or the file named by LOCAL_RUNNER_ENV)
 *
 * Credits: C has no fetch path (cache peek only). The check here is behavioural: every C minute that saw candles
 * must coincide with an A poll of the same symbol in the same cycle that also saw candles — the fetch C read from.
 */
import { shadowCoverage } from "../supabase/functions/_shared/shadowZoneMid.ts";

const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(Deno.env.get("LOCAL_RUNNER_ENV") ?? new URL("./.env.local", import.meta.url)).split("\n")) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const url = env.SUPABASE_URL, key = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: key, Authorization: "Bearer " + key };
const START = Deno.args[0];
if (!START) throw new Error("window start required");
const SHADOW = "smc_shadow_zonemid", SP = "bot-scanner:shadow-zonemid";
const PAIRS = ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF"];

async function all(path: string): Promise<any[]> {
  const out: any[] = [];
  for (let a = 0; ; a += 1000) {
    let r: Response | null = null;
    for (let t = 1; t <= 5; t++) {
      try { r = await fetch(`${url}/rest/v1/${path}`, { headers: { ...H, Range: `${a}-${a + 999}` } }); if (r.ok) break; } catch { /* retry */ }
      await new Promise((s) => setTimeout(s, 2000 * t));
    }
    if (!r || !r.ok) throw new Error(`${path}: ${r?.status}`);
    const b = await r.json(); out.push(...b); if (b.length < 1000) return out;
  }
}
const tally = (xs: string[]) => xs.reduce((m: Record<string, number>, x) => (m[x] = (m[x] ?? 0) + 1, m), {});

// ── orders ──
const cOrders = await all(`pending_orders?select=id,order_id,symbol,direction,status,terminal_reason,entry_price,placed_at,zone_touch_time,confirmation_arm_count,confirmation_checks_count,filled_at,fill_price,dry_run,bot_id&bot_id=eq.${SHADOW}&order=placed_at.asc,order_id.asc`);
const aOrdersWin = await all(`pending_orders?select=order_id,symbol,direction,status,terminal_reason,entry_source,placed_at,resolved_at&bot_id=eq.smc&or=(placed_at.gte.${START},resolved_at.gte.${START},status.in.(pending,awaiting_confirmation))&order=placed_at.asc,order_id.asc`);
const cAttr = await all(`trade_attribution?select=signal_id,order_id,symbol,dry_run,fill_kind,filled_at,closed_at,position_row_id,outcome_kind,realized_r_net,decision_id,entry_source,strategy_version&bot_id=eq.${SHADOW}&order=decision_at.asc,signal_id.asc`);
const cIds = new Set(cOrders.map((o) => o.order_id));
const cRowIds = new Set(cOrders.map((o) => o.id));
const symOf = new Map<string, string>([...cOrders.map((o) => [o.order_id, o.symbol] as [string, string])]);
const aSym = new Map<string, string>();
for (const o of await all(`pending_orders?select=order_id,symbol&bot_id=eq.smc&placed_at=gte.2026-10-07T00:00:00Z&order=placed_at.asc,order_id.asc`)) aSym.set(o.order_id, o.symbol);

// ── polls ──
const polls = await all(`route2_poll_log?select=id,pending_id,poll_timestamp,poller_name,candles_available,branch_taken,status_before,status_after&poll_timestamp=gte.${START}&order=id.asc`);
const cPolls = polls.filter((p) => p.poller_name === SP);
const aPolls = polls.filter((p) => p.poller_name === "bot-scanner");
const zcsPolls = polls.filter((p) => p.poller_name === "zone-confirmation-scanner");
const other = polls.filter((p) => ![SP, "bot-scanner", "zone-confirmation-scanner"].includes(p.poller_name));

// INVARIANCE: no cross-tagging
const aPollOnC = aPolls.filter((p) => String(p.pending_id).startsWith("zm") || cIds.has(p.pending_id)).length;
const cPollOnA = cPolls.filter((p) => !cIds.has(p.pending_id)).length;
const aErrors = aPolls.filter((p) => String(p.branch_taken).startsWith("error:"));
const cErrors = cPolls.filter((p) => String(p.branch_taken).startsWith("error:"));

// CREDITS: every observed C minute must be explained by an A fetch of the same symbol in the same cycle
const aFetched = new Set(aPolls.filter((p) => p.candles_available > 0).map((p) => `${p.poll_timestamp}|${aSym.get(p.pending_id) ?? "?"}`));
const cObserved = cPolls.filter((p) => p.candles_available > 0);
const unexplained = cObserved.filter((p) => !aFetched.has(`${p.poll_timestamp}|${symOf.get(p.pending_id)}`));

// COVERAGE (expiry polls need no data; they count as observed, as in shadowCoverage)
const cov = shadowCoverage(cPolls.filter((p) => symOf.has(p.pending_id)).map((p) => ({ symbol: symOf.get(p.pending_id)!, branch: p.branch_taken })));
const noDataBySym = tally(cPolls.filter((p) => p.branch_taken === "shadow_no_data").map((p) => symOf.get(p.pending_id) ?? "?"));

// POSITIONS
const shadowPositions = await all(`paper_positions?select=id,position_id,bot_id,source_pending_order_id&bot_id=eq.${SHADOW}`);
const allPos = await all(`paper_positions?select=id,position_id,bot_id,source_pending_order_id,open_time&order=open_time.asc`);
const posFromC = allPos.filter((p) => p.source_pending_order_id && cRowIds.has(p.source_pending_order_id));
const histFromC = await all(`paper_trade_history?select=id,bot_id&bot_id=eq.${SHADOW}`);
const realAttrC = cAttr.filter((a) => a.dry_run !== true || (a.fill_kind && a.fill_kind !== "hypothetical") || a.position_row_id || a.outcome_kind === "real");

// A LOGS: no C ids in A's scan logs since start
const logs = await all(`scan_logs?select=created_at,details_json&bot_id=eq.smc&created_at=gte.${START}&order=created_at.asc`);
const logsWithC = logs.filter((l) => /zm[0-9a-f]{10}/.test(JSON.stringify(l.details_json))).length;

// CREDIT RATE (rolling 30-min table): per caller, last 30 minutes
const credits = await all(`api_credit_usage?select=provider,caller,reserved_at&order=reserved_at.asc`);
const creditsByCaller = tally(credits.map((c) => `${c.provider}:${c.caller ?? "null"}`));

const out = {
  at: new Date().toISOString(), window_start: START,
  validity: {
    zone_confirmation_scanner_polls: zcsPolls.length,
    comparison_invalid_second_poller: zcsPolls.length > 0,
    other_pollers: tally(other.map((p) => p.poller_name)),
  },
  stop_conditions: {
    a_poll_rows_tagged_on_C_orders: aPollOnC,
    c_poll_rows_on_non_C_orders: cPollOnA,
    c_observations_unexplained_by_A_fetch: unexplained.length,
    shadow_positions: shadowPositions.length,
    positions_sourced_from_C_orders: posFromC.length,
    shadow_trade_history_rows: histFromC.length,
    c_attribution_rows_not_hypothetical: realAttrC.length,
    a_scan_logs_mentioning_C_ids: logsWithC,
    a_error_polls: aErrors.length,
  },
  c_setups: { orders: cOrders.length, attribution_rows: cAttr.length, by_pair: tally(cOrders.map((o) => o.symbol)),
    status: tally(cOrders.map((o) => o.status)), terminal: tally(cOrders.map((o) => o.terminal_reason ?? o.status)),
    paired_decisions: new Set(cAttr.map((a) => a.decision_id)).size },
  c_lifecycle: {
    touched: cOrders.filter((o) => o.zone_touch_time || (o.confirmation_arm_count ?? 0) > 0).length,
    confirmation_checks: cOrders.reduce((s, o) => s + (o.confirmation_checks_count ?? 0), 0),
    hypothetical_fills: cOrders.filter((o) => o.status === "filled").length,
    resolved_outcomes: cAttr.filter((a) => a.closed_at).length,
    poll_branches: tally(cPolls.map((p) => p.branch_taken)),
  },
  coverage: { overall: cov.overall, polls: cov.polls, per_pair: Object.fromEntries(PAIRS.map((s) => [s, cov.perPair[s] ?? null])),
    excluded_pairs: cov.excludedPairs, gate_passed: cov.valid, shadow_no_data_total: cPolls.filter((p) => p.branch_taken === "shadow_no_data").length,
    shadow_no_data_by_pair: noDataBySym },
  a: { orders_in_window: aOrdersWin.length, a_polls: aPolls.length, a_poll_branches: tally(aPolls.map((p) => p.branch_taken)),
    a_terminal: tally(aOrdersWin.map((o) => o.terminal_reason ?? o.status)), c_error_polls: cErrors.length },
  credits_last_30min_by_caller: creditsByCaller,
};
console.log(JSON.stringify(out, null, 1));
