/**
 * STEP 15 PR 2 — attribution builder, placement helper and scanner wiring.
 * The database side (triggers, route2_place_order, fills, settlement) is
 * proven on real Postgres in paperSettlementLedger.test.ts.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildAttribution, classifyGate, gamePlanAlignment, primaryEngine, type AttributionInput } from "../../functions/_shared/attribution.ts";
import { placeRoute2Order } from "../../functions/_shared/route2Placement.ts";
import { toRow } from "../../functions/_shared/smcDecisionCapture.ts";

// ─── primary engine ─────────────────────────────────────────────────────────

Deno.test("primary engine by rule: Impulse admits today; Unified never primary with modifiers off; score never primary", () => {
  assertEquals(primaryEngine({ entrySource: "refinedEntry", izGateMode: "hard", unifiedModifiersEnabled: false }), "impulse_zone");
  assertEquals(primaryEngine({ entrySource: "zoneMid", izGateMode: "hard", unifiedModifiersEnabled: false }), "impulse_zone");
  assertEquals(primaryEngine({ entrySource: "unified", izGateMode: "hard", unifiedModifiersEnabled: false }), "impulse_zone");
  assertEquals(primaryEngine({ entrySource: "unified", izGateMode: "off", unifiedModifiersEnabled: false }), "ob_fvg");
  assertEquals(primaryEngine({ entrySource: "unified", izGateMode: "hard", unifiedModifiersEnabled: true }), "unified");
  assertEquals(primaryEngine({ entrySource: "legacy", izGateMode: "hard", unifiedModifiersEnabled: false }), "ob_fvg");
  for (const pe of ["impulse_zone", "unified", "ob_fvg"]) assert(pe !== "smc_score");
});

// ─── gates, from the reason strings production writes ───────────────────────

Deno.test("every gate reason recorded at 13:00 UTC 2026-10-07 (CHF/JPY) classifies to a gate id", () => {
  const recorded: [string, string][] = [
    ["Direction OK: LONG (conf: 75%, adj: +0.75, agreement: 50%)", "direction"],
    ["P/D zone OK (discount, 3.9% of the 5m 5-swing box 189.748–190.391)", "premium_discount"],
    ["Structural Conviction: DISABLED by config", "structural_conviction"],
    ["CHF/JPY enabled", "instrument"],
    ["0/3 positions", "caps_global"],
    ["0/1 for CHF/JPY", "caps_per_symbol"],
    ["Already long on CHF/JPY — no duplicate (enable stacking to allow)", "stacking"],
    ["Portfolio heat 0.0%", "portfolio_heat"],
    ["Daily loss delegated to prop firm gate (stricter thresholds)", "daily_loss"],
    ["Drawdown delegated to prop firm gate (stricter thresholds)", "drawdown"],
    ["No recent trades — cooldown OK", "cooldown"],
    ["No trade history for consecutive loss check", "consecutive_losses"],
    ["Daily net P&L $+0.00 (gross loss: $0.00)", "daily_dollar_loss"],
    ["FOTSI Gate: data unavailable — skipped", "fotsi"],
    ["No correlated conflicts (threshold 0.8)", "correlation"],
    ["Tier 1 gate DISABLED by config (2 core factors present)", "tier1"],
    ["Regime gate: subsumed by Direction Verdict", "regime"],
    ["[Info] Spread wide (indicative): 23.6% of ATR — info only", "spread"],
  ];
  for (const [reason, id] of recorded) assertEquals(classifyGate({ passed: true, reason }).gate_id, id, reason);
  // tagged gates keep their tag and their logged-only state
  const r = classifyGate({ gateId: "reaction", passed: true, loggedOnly: true, wouldBlock: true, reason: "[logged only — would block] x" });
  assertEquals([r.gate_id, r.mode, r.passed, r.would_block], ["reaction", "log", true, true]);
  assertEquals(classifyGate({ passed: true, reason: "something new" }).gate_id, "unclassified");
});

Deno.test("Game Plan alignment", () => {
  assertEquals(gamePlanAlignment({ bias: "bullish", biasConfidence: 64 }, "long", true), "aligned");
  assertEquals(gamePlanAlignment({ bias: "bearish", biasConfidence: 64 }, "long", true), "opposed");
  assertEquals(gamePlanAlignment({ bias: "bearish", biasConfidence: 36 }, "long", true), "below_threshold");
  assertEquals(gamePlanAlignment({ bias: "neutral", biasConfidence: 0 }, "long", true), "neutral");
  assertEquals(gamePlanAlignment(null, "long", true), "none");
  assertEquals(gamePlanAlignment({ bias: "bullish", biasConfidence: 90 }, "long", false), "disabled");
});

// ─── the row ────────────────────────────────────────────────────────────────

const INPUT: AttributionInput = {
  signalId: "11111111-1111-4111-8111-111111111111", decisionId: "22222222-2222-4222-8222-222222222222",
  scanCycleId: "33333333-3333-4333-8333-333333333333", userId: "u", botId: "smc", symbol: "CHF/JPY", direction: "long", dryRun: true,
  decisionAt: "2026-10-07T00:10:06Z", configVersion: "e3eb2e67b221fa1aeaae73a39270bb43", strategyVersion: "smc-zone-impulse-control-v1",
  switches: { sizingMode: "fill_time", riskPercent: 0.5, maxLotsPerTrade: 20, stopAnchor: "limit", unifiedModifiersEnabled: false },
  legacyRiskPercent: 0.5, management: { breakEvenEnabled: false, trailingStopEnabled: false, partialTPEnabled: false, maxHoldEnabled: false, maxHoldHours: 0 },
  caps: { mode: "unified", maxOpenPositions: 3, maxPerSymbol: 1 }, impulseSlCapMultiplier: 1.5, riskProfileVersion: null,
  entrySource: "refinedEntry", izGateMode: "hard", gamePlanEnabled: true,
  gamePlanContext: { bias: "bearish", biasConfidence: 36, isFocusPair: true },
  directionVerdict: { verdict: "long", confidence: 75, agreement: 0.5 },
  impulse: { hasZone: true, selectedTF: "1H", impulse: { high: 190.49909, low: 189.9432 }, bestZone: { type: "ob", low: 189.99417, high: 190.14972, fibLevel: 0.786, refinedEntry: 190.142885, totalScore: 3.5 } },
  unifiedDetected: { state: "detected", score: 9 }, unifiedComparison: { entryDiffPips: 3 },
  gateScore: 61.6, decisionScoreGate: { mode: "log", score: 63.35, threshold: 20, wouldBlock: false },
  factors: [{ name: "Order Block", present: true, weight: 1, tier: 1 }, { name: "FVG", present: false, weight: 0 }],
  gates: [{ gateId: "reaction", passed: true, loggedOnly: true, wouldBlock: true, reason: "x" }, { passed: true, reason: "0/3 positions" }],
  ictFvgGate: { mode: "off", wouldBlock: false }, orderRR: { rawRR: 1.1, effectiveRR: 1.0, costInPrice: 0.025, wouldBlock: false, min: 1, mode: "order_geometry" },
  loggedOnlyWouldBlock: [{ gateId: "reaction", reason: "x" }],
  riskGate: { enabled: false, allowed: true, reason: "no active risk profile" },
  zoneId: "CHF/JPY|1H|long|189.9942|190.1497", entryDepth: 0.55,
  limitPrice: 190.142885, stopPrice: 189.892885, targetPrice: 190.417885, pipSize: 0.01,
  route2Stop: { anchor: "limit", floorPips: 25, capPips: 66.71, limit: { source: "floor", riskPips: 25 }, market: { sl: 189.93208, riskPipsFromLimit: 21.08, belowFloor: true } },
  plannedSizing: { lots: 3.16, uncappedLots: 3.1644, riskPercentTarget: 0.5, riskUsdTarget: 500 }, balance: 100000, expiresAt: "2026-10-07T08:10:06Z",
};

Deno.test("the row: Impulse primary; Unified contributor detected_only (not applied); score is evidence; GP / step 13 / old-rule state captured", () => {
  const r = buildAttribution(INPUT) as any;
  assertEquals([r.primary_engine, r.primary_engine_rule, r.route], ["impulse_zone", "primary-engine.v1", "route2_pending_confirmation"]);
  const u = r.contributors.find((c: any) => c.engine === "unified");
  assertEquals([u.role, r.unified.modifiers_applied], ["detected_only", false]);
  assert(!r.contributors.some((c: any) => c.engine === "unified" && c.role !== "detected_only"));
  assertEquals(r.contributors.find((c: any) => c.engine === "smc_score").role, "scoring");
  assertEquals([r.score.gate_score, r.score.decision_gate.score], [61.6, 63.35]);
  assertEquals(r.score.components.map((c: any) => c.name), ["Order Block"]);
  assertEquals([r.game_plan.alignment, r.game_plan.bias, r.game_plan.confidence, r.game_plan.focus_pair], ["below_threshold", "bearish", 36, true]);
  assertEquals(r.risk_gate, { enabled: false, allowed: true, reason: "no active risk profile" });
  assert(r.gates.some((g: any) => g.gate_id === "risk_profile"));
  assertEquals([r.legacy_would_admit, r.logged_only_would_block], [false, ["reaction"]]);
  assertEquals([r.config_version, r.caps_version, r.management_version, r.sizing_version], ["e3eb2e67b221fa1aeaae73a39270bb43", "unified_3_1", "none_v1", "fill_time_v1;risk=0.5;maxLots=20"]);
  assert(r.stop_version.startsWith("route2_limit_anchor_v1;floor=25;capMult=1.5"));
  assertEquals([r.stop_source, r.stop_distance_pips, r.stop_floor_pips, r.raw_rr, r.effective_rr, r.intended_risk_usd, r.planned_lots],
               ["floor", 25, 25, 1.1, 1, 500, 3.16]);
  assertEquals(r.impulse.zone.refined_entry, 190.142885);
  assertEquals(r.market_anchored_stop.belowFloor, true);
  for (const k of ["order_id", "terminal_status", "fill_kind", "closed_at"]) assert(!(k in r), `${k} is written by the lifecycle, not at placement`);
});

Deno.test("watchlist promotion keeps its origin; route says so", () => {
  const r = buildAttribution({ ...INPUT, promotedFromWatchlist: { stagedSetupId: "st-1", initialScore: 48, cycles: 3 } }) as any;
  assertEquals(r.route, "watchlist_promotion");
  assertEquals(r.contributors.find((c: any) => c.engine === "watchlist"), { engine: "watchlist", role: "origin", value: { stagedSetupId: "st-1", initialScore: 48, cycles: 3 } });
});

Deno.test("the decision row carries its client id and signal_id", () => {
  const row = toRow({ id: "d1", signal_id: "s1", scan_cycle_id: "c", user_id: "u", bot_id: "smc", symbol: "X", style: null, reached_stage: "final",
    direction_input: null, confluence_input: null, gates_input: null, portfolio_input: null, ict_input: null, risk_input: null, session_news_input: null,
    cascade_input: null, gates_output: null, portfolio_output: null, cascade_output: null, final_decision: null, contract_version: "v" });
  assertEquals([row.id, row.signal_id], ["d1", "s1"]);
  const legacy = toRow({ scan_cycle_id: "c", user_id: "u", bot_id: "smc", symbol: "X", style: null, reached_stage: "final",
    direction_input: null, confluence_input: null, gates_input: null, portfolio_input: null, ict_input: null, risk_input: null, session_news_input: null,
    cascade_input: null, gates_output: null, portfolio_output: null, cascade_output: null, final_decision: null, contract_version: "v" });
  assert(!("id" in legacy), "no id → the database default");
  assertEquals(legacy.signal_id, null);
});

// ─── placement helper ───────────────────────────────────────────────────────

function fakeSupabase(rpcReply: { data?: unknown; error?: { code?: string; message: string } | null }) {
  const calls: string[] = [];
  return {
    calls,
    rpc: async (fn: string) => { calls.push(`rpc:${fn}`); return { data: rpcReply.data ?? null, error: rpcReply.error ?? null }; },
    from: (t: string) => ({
      update: (v: any) => ({ in: (_c: string, ids: string[]) => ({ eq: async () => { calls.push(`update:${t}:${v.status}:${v.terminal_reason}:${!!v.resolved_at}:${ids.join(",")}`); return { error: null }; } }) }),
      insert: async (row: any) => { calls.push(`insert:${t}:${"signal_id" in row}`); return { error: null }; },
    }),
  };
}
const ORDER = { user_id: "u", symbol: "CHF/JPY", direction: "long", order_id: "o1" };

Deno.test("placement: placed / duplicate replies map through; duplicate exposes the tracked signal", async () => {
  const p = await placeRoute2Order(fakeSupabase({ data: { outcome: "placed", signal_id: "s1", attribution: "written", superseded: ["old1"] } }), { attribution: {}, order: ORDER, supersede: [] });
  assertEquals([p.outcome, p.signalId, p.attribution, p.superseded], ["placed", "s1", "written", ["old1"]]);
  const d = await placeRoute2Order(fakeSupabase({ data: { outcome: "duplicate", existing_order_id: "live", existing_signal_id: "sLive", error: "duplicate key" } }), { attribution: {}, order: ORDER, supersede: [] });
  assertEquals([d.outcome, d.existingOrderId, d.existingSignalId], ["duplicate", "live", "sLive"]);
  const e = await placeRoute2Order(fakeSupabase({ error: { message: "entries locked: only dry-run orders" } }), { attribution: {}, order: ORDER, supersede: [] });
  assertEquals([e.outcome, e.error], ["failed", "entries locked: only dry-run orders"]);
});

Deno.test("placement: if the RPC is missing (code before migration), the exact legacy path runs — orders are never lost", async () => {
  const sb = fakeSupabase({ error: { code: "PGRST202", message: "Could not find the function public.route2_place_order" } });
  const p = await placeRoute2Order(sb, { attribution: { signal_id: "x" }, order: ORDER, supersede: [{ order_id: "old1", cancel_reason: "Superseded" }] });
  assertEquals([p.outcome, p.attribution, p.superseded], ["placed", "legacy_fallback", ["old1"]]);
  assertEquals(sb.calls, ["rpc:route2_place_order", "update:pending_orders:cancelled:CANCELLED_SUPERSEDED:true:old1", "insert:pending_orders:false"]);
});

// ─── scanner wiring (source) ────────────────────────────────────────────────

const scanner = Deno.readTextFileSync(new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const zcs = Deno.readTextFileSync(new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url));

Deno.test("wiring: canonical config hash read with the config; decision id minted before any write", () => {
  assertEquals((scanner.match(/select\("id, config_json, config_version"\)/g) ?? []).length, 2);
  assert(scanner.includes("(flat as any).__configVersion = data?.config_version ?? null;"));
  const c = scanner.indexOf("const cap = newCapture(scanCycleId, userId, BOT_ID, pair, null);");
  assert(scanner.slice(c, c + 600).includes("cap.id = crypto.randomUUID();"));
  assert(/\/\^\[0-9a-f\]\{32\}\$\/\.test\(configVersion\)/.test(scanner), "only the canonical 32-hex hash is used");
});

Deno.test("wiring: Route 2 orders are placed only through placeRoute2Order; no direct insert or separate supersede cancel remains", () => {
  assert(scanner.includes("const placement = await placeRoute2Order(supabase, { attribution: route2Attribution, order: route2OrderRow, supersede });"));
  assert(!scanner.includes('const { error: pendingInsertErr } = await supabase.from("pending_orders").insert('));
  const i = scanner.indexOf("const movedOrders = (stalePending ?? [])");
  const j = scanner.indexOf("const placement = await placeRoute2Order(");
  assert(!/terminal_reason: "CANCELLED_SUPERSEDED"/.test(scanner.slice(i, j)), "supersede cancel happens inside the RPC");
  assert(scanner.includes('.select("order_id, entry_price, signal_score, signal_id")'));
});

Deno.test("wiring: decisions link to the order they placed or the tracked setup they re-detected", () => {
  assert(scanner.includes("cap.signal_id = samePriceOrders[0]?.signal_id ?? null;"), "same-level refresh → tracked setup");
  assert(scanner.includes('if (placement.outcome === "duplicate") cap.signal_id = placement.existingSignalId ?? null;'), "armed duplicate → tracked setup");
  assert(scanner.includes('if (placement.attribution === "written") cap.signal_id = placement.signalId;'), "new order → its own signal");
  assert(scanner.includes('"Zone setup already active (see Zone Setups panel)"'), "the decision status text is unchanged");
});

Deno.test("wiring: fills carry the signal and the fill-sizing record; dry-run included; no policy change", () => {
  assert(scanner.includes("signal_id: (pending as any).signal_id ?? null,"), "real fill → position carries the order's signal");
  assert(/fill_sizing: fillSizingRecord,/.test(scanner), "real + dry-run fills write fill_sizing (dry-run spreads the same patch)");
  const d = scanner.indexOf("if ((pending as any).dry_run === true) {");
  assert(scanner.slice(d, d + 400).includes("...pendingFillPatch,"), "the dry-run update includes fill_sizing via the patch");
  assert(!/insideFloor[^\n]*continue;/.test(scanner), "inside-floor is recorded, never acted on");
  assert(zcs.includes("signal_id: (pending as any).signal_id ?? null,"), "the (switched-off) second poller is consistent");
});
