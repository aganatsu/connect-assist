/**
 * ROUTE 2 PROVENANCE + CONFIRMATION PROPAGATION — regression suite.
 *
 * The defect: pending order 9394117f (NZD/CAD short) carried
 * strategy_version = smc-route2-confirmation-lifecycle-v2, and the position it
 * filled into was stamped smc-zone-impulse-control-v1 with
 * source_pending_order_id NULL. buildEntryTelemetry hard-coded the version,
 * and nothing anywhere wrote the source link.
 *
 * Each claim is tested twice: on the real functions, and on the write paths
 * that must call them — because a correct helper nobody calls is how this
 * codebase has repeatedly shipped dead telemetry.
 */

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildEntryTelemetry, carryToHistory, IMMUTABLE_COLUMNS, entryDecisionSnapshot,
} from "../../functions/_shared/smcTradeTelemetry.ts";
import {
  buildConfirmationRecord, buildRoute2Provenance, tierLabel, typeLabel,
  confirmationSummaryLine, HUNT_TIERS_TEXT,
} from "../../functions/_shared/route2Confirmation.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const SCANNER = read("../../functions/bot-scanner/index.ts");
const ZCS = read("../../functions/zone-confirmation-scanner/index.ts");
const PAPER = read("../../functions/paper-trading/index.ts");
const BACKFILL = read("../../migrations/20260930120000_route2_provenance_backfill.sql");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// The real pending row, as stored.
const PENDING_9394117F: Record<string, unknown> = {
  id: "7f1c2a9e-0000-4000-8000-000000000001", order_id: "9394117f",
  symbol: "NZD/CAD", direction: "short", status: "filled",
  strategy_version: "smc-route2-confirmation-lifecycle-v2", config_hash: "5135bb1e873a8695",
  would_have_been_route1: true, zone_id: "NZD/CAD|1H|short|0.80124|0.802875",
  placed_at: "2026-09-30T03:56:05.437+00:00", entry_price: 0.80165,
  pending_distance_atr: 0.20013614703873628, zone_touch_time: "2026-09-30T06:31:01.426+00:00",
  confirmation_arm_count: 4, confirmation_checks_count: 25,
};
// The confirmation the engine emitted for it.
const SIGNAL = {
  type: "bearish_reversal_pattern", tier: 3, price: 0.80181,
  displacement: 0.9111111111110344, significance: undefined, closeBased: false,
  supportingSignals: ["displacement", "Displacement (bearish) body 91%"],
};

const fill = (over: Record<string, unknown> = {}) => buildEntryTelemetry({
  route: "route2_pending", direction: "short", entryPrice: 0.80181,
  entryStopLoss: 0.80316, entryTakeProfit: 0.799989,
  entryTime: "2026-09-30T06:33:22.515Z", strategyBarTime: null, pipSize: 0.0001,
  tradingStyle: null, zoneTimeframe: "IZ-OB", configSnapshot: {},
  decisionSnapshot: entryDecisionSnapshot({
    setupId: "9394117f",
    route2: buildRoute2Provenance(PENDING_9394117F) as unknown as Record<string, unknown>,
    confirmation: buildConfirmationRecord(SIGNAL, "5m") as unknown as Record<string, unknown>,
  }),
  strategyVersion: PENDING_9394117F.strategy_version as string,
  sourcePendingOrderId: PENDING_9394117F.id as string,
  ...over,
});

// ─── 1. version is the originating order's ──────────────────────────────────

Deno.test("1 · a Route 2 V2 fill keeps the pending order's strategy_version", () => {
  assertEquals(fill().strategy_version, "smc-route2-confirmation-lifecycle-v2");
});

Deno.test("1b · absent a version, the contract default is unchanged (Route 1 path)", () => {
  // Route 1 passes no version; it must still record exactly what it always did.
  assertEquals(fill({ strategyVersion: undefined }).strategy_version, "smc-zone-impulse-control-v1");
  assertEquals(fill({ strategyVersion: null }).strategy_version, "smc-zone-impulse-control-v1");
  assertEquals(fill({ strategyVersion: "" }).strategy_version, "smc-zone-impulse-control-v1");
});

// ─── 2. the source link exists ──────────────────────────────────────────────

Deno.test("2 · source_pending_order_id is set on the position", () => {
  assertEquals(fill().source_pending_order_id, "7f1c2a9e-0000-4000-8000-000000000001");
  assertEquals(fill({ sourcePendingOrderId: undefined }).source_pending_order_id, null);
});

// ─── 3. lifecycle metadata reaches the position ─────────────────────────────

Deno.test("3 · lifecycle provenance and the confirmation ride in the immutable snapshot", () => {
  const snap = fill().entry_decision_snapshot as Record<string, any>;
  assertEquals(snap.route2.strategyVersion, "smc-route2-confirmation-lifecycle-v2");
  assertEquals(snap.route2.lifecycleVersion, "smc-route2-confirmation-lifecycle-v2");
  assertEquals(snap.route2.configHash, "5135bb1e873a8695");
  assertEquals(snap.route2.pendingOrderId, "9394117f");
  assertEquals(snap.route2.zoneId, "NZD/CAD|1H|short|0.80124|0.802875");
  assertEquals(snap.route2.pendingEntryPrice, 0.80165);
  assertEquals(snap.route2.zoneTouchTime, "2026-09-30T06:31:01.426+00:00");
  assertEquals(snap.route2.confirmationArmCount, 4);
  assertEquals(snap.route2.confirmationChecksCount, 25);
  assertEquals(snap.confirmation.tier, 3);
  assertEquals(snap.confirmation.type, "bearish_reversal_pattern");
  assertEquals(snap.confirmation.timeframe, "5m");
  assertEquals(snap.confirmation.closeBased, false);
});

// ─── 4. and survives the archive ────────────────────────────────────────────

Deno.test("4 · provenance survives archive into paper_trade_history", () => {
  const pos = { ...fill() } as Record<string, unknown>;
  const h = carryToHistory(pos, { exitPrice: 0.79999, direction: "short" });
  assertEquals(h.strategy_version, "smc-route2-confirmation-lifecycle-v2");
  assertEquals(h.source_pending_order_id, "7f1c2a9e-0000-4000-8000-000000000001");
  assertEquals(h.entry_route, "route2_pending");
  const snap = h.entry_decision_snapshot as Record<string, any>;
  assertEquals(snap.route2.wouldHaveBeenRoute1, true);
  assertEquals(snap.confirmation.tier, 3);
  assert(IMMUTABLE_COLUMNS.includes("source_pending_order_id" as never),
    "the link must be part of the immutable block that every archive path copies");
});

// ─── 5. cohort flag preserved ───────────────────────────────────────────────

Deno.test("5 · would_have_been_route1 is preserved exactly, including false and absent", () => {
  assertEquals(buildRoute2Provenance(PENDING_9394117F).wouldHaveBeenRoute1, true);
  assertEquals(buildRoute2Provenance({ ...PENDING_9394117F, would_have_been_route1: false }).wouldHaveBeenRoute1, false);
  // Legacy: null, never coerced to false (which would admit it to the primary cohort).
  assertEquals(buildRoute2Provenance({ order_id: "leg" }).wouldHaveBeenRoute1, null);
});

Deno.test("a V1 or legacy pending order never acquires a V2 lifecycle label", () => {
  const v1 = buildRoute2Provenance({ order_id: "x", strategy_version: "smc-zone-impulse-control-v1" });
  assertEquals(v1.lifecycleVersion, null);
  assertEquals(v1.strategyVersion, "smc-zone-impulse-control-v1");
  const legacy = buildRoute2Provenance({ order_id: "y" });
  for (const k of ["strategyVersion", "lifecycleVersion", "configHash", "zoneId",
    "confirmationArmCount", "confirmationChecksCount", "pendingDistanceAtr"] as const) {
    assertEquals(legacy[k], null, `${k} must be null on a legacy row`);
  }
});

// ─── confirmation record ────────────────────────────────────────────────────

Deno.test("the confirmation record keeps every field, with null instead of undefined", () => {
  const r = buildConfirmationRecord(SIGNAL, "5m");
  assertEquals(r.contract, "route2-confirmation.v1");
  assertEquals(r.price, 0.80181);
  assertEquals(r.displacement, 0.9111111111110344);
  assertEquals(r.supportingSignals, ["displacement", "Displacement (bearish) body 91%"]);
  // JSON.stringify drops undefined — which is how significance vanished from
  // every stored confirmation. It must survive a round trip as a key.
  assertEquals(r.significance, null);
  const round = JSON.parse(JSON.stringify(r));
  assert("significance" in round, "significance must survive serialisation");
  assert("timeframe" in round, "timeframe must be recorded");
});

Deno.test("the record tolerates a malformed signal without inventing values", () => {
  const r = buildConfirmationRecord({
    type: "bullish_choch", tier: 1, price: NaN, displacement: Infinity,
    closeBased: undefined as never, supportingSignals: null,
  }, null);
  assertEquals(r.price, null);
  assertEquals(r.displacement, null);
  assertEquals(r.closeBased, null);
  assertEquals(r.supportingSignals, []);
  assertEquals(r.timeframe, null);
});

// ─── Telegram parity ────────────────────────────────────────────────────────

Deno.test("Telegram labels come from the stored record via the canonical module", () => {
  // Both fill paths must build the record once and label from it; neither
  // may format the raw signal type into the message any more.
  for (const [name, src] of [["bot-scanner", SCANNER], ["zone-confirm", ZCS]] as const) {
    assert(/from "\.\.\/_shared\/route2Confirmation\.ts"/.test(src), `${name} must import the canonical module`);
    assert(/const confirmationRecord = buildConfirmationRecord\(confirmationSignal, confirmTF\)/.test(src),
      `${name} must build ONE record from the signal`);
    assert(/tierLabel\(confirmationRecord\.tier\)/.test(src), `${name}: Telegram tier from the record`);
    assert(/typeLabel\(confirmationRecord\.type\)/.test(src), `${name}: Telegram type from the record`);
  }
  assertEquals(confirmationSummaryLine(buildConfirmationRecord(SIGNAL, "5m")),
    "T3 Reversal · Bearish Reversal Pattern · 5m · disp 91%");
  assertEquals(tierLabel(3), "T3 Reversal");
  assertEquals(typeLabel("bearish_reversal_pattern"), "Bearish Reversal Pattern");
  assertEquals(HUNT_TIERS_TEXT, "T1 CHoCH · T2 CHoCH+ · T3 Reversal");
});

// ─── write paths ────────────────────────────────────────────────────────────

Deno.test("both Route 2 fill paths pass the originating version and the source id", () => {
  for (const [name, src] of [["bot-scanner", SCANNER], ["zone-confirm", ZCS]] as const) {
    const c = code(src);
    assert(/strategyVersion: \(pending as any\)\.strategy_version \?\? null/.test(c),
      `${name}: the fill must pass the pending order's strategy_version`);
    assert(/sourcePendingOrderId: \(pending as any\)\.id \?\? null/.test(c),
      `${name}: the fill must pass pending_orders.id`);
    assert(/route2: route2Provenance/.test(c), `${name}: provenance must enter the decision snapshot`);
    assert(/confirmation: confirmationRecord/.test(c), `${name}: the record must enter the decision snapshot`);
    assert(/entry_confirmation: confirmationRecord/.test(c),
      `${name}: the pending row's entry_confirmation must carry the record`);
  }
});

Deno.test("every history archive path carries the immutable block", () => {
  // A Route 2 trade closed by reverse signal, manually, by kill switch or by
  // the paper engine's SL/TP used to lose its route, version and source link.
  // History is written by settle_paper_position now; each call's `history`
  // object, up to its outcome check, must carry the block.
  const settlements = (src: string) =>
    [...src.matchAll(/settlePaperPosition\(supabase, \{/g)].map((m) => {
      const end = src.indexOf('.outcome !== "settled"', m.index!);
      return src.slice(m.index!, end);
    });
  const scanner = settlements(SCANNER);
  assertEquals(scanner.length, 2, "breach close + reverse-signal close");
  for (const body of scanner) {
    assert(/\.\.\.carryToHistory\(/.test(body), `bot-scanner archive missing carryToHistory:\n${body.slice(0, 200)}`);
  }
  const paper = settlements(PAPER);
  assert(paper.length >= 3, `expected >=3 full-close settlements in paper-trading, found ${paper.length}`);
  for (const body of paper) {
    assert(/\.\.\.carryToHistory\(/.test(body), `paper-trading archive missing carryToHistory:\n${body.slice(0, 200)}`);
  }
  assertEquals([...PAPER.matchAll(/settlePaperPartial\(supabase, \{/g)].length, 1, "exactly one partial-close settlement");
});

Deno.test("the Hunting section can now receive awaiting_confirmation orders", () => {
  const i = SCANNER.indexOf('if (action === "active_pending")');
  const block = code(SCANNER.slice(i, i + 900));
  assert(/\.in\("status", \["pending", "awaiting_confirmation"\]\)/.test(block),
    "active_pending must include awaiting_confirmation or the panel's hunting section is dead");
});

// ─── backfill ───────────────────────────────────────────────────────────────

Deno.test("the backfill only touches rows it can prove, and only adds", () => {
  const sql = BACKFILL.replace(/^\s*--.*$/gm, "");
  // proven identity: route + same order id + same user/symbol/direction
  assert(/entry_route = 'route2_pending'/.test(sql), "must require a Route 2 fill");
  assert(/position_id = p\.order_id/.test(sql), "must join on the fill's own identity");
  assert(/user_id = p\.user_id and symbol = p\.symbol and direction = p\.direction/.test(sql));
  assert(/status = 'filled'/.test(sql));
  // additive only
  assert(/coalesce\(source_pending_order_id, p\.id\)/.test(sql), "never overwrite an existing link");
  assert(/coalesce\(p\.strategy_version, strategy_version\)/.test(sql),
    "a pending order with no version must leave the row's version alone");
  assert(/\? 'route2' then '\{\}'::jsonb/.test(sql), "an existing route2 key is never replaced");
  assert(/entry_confirmation is null/.test(sql), "an existing entry_confirmation is never replaced");
  // Every column the backfill assigns must be on this list. Anything else —
  // a price, a stop, a size, a status — would make it a trading change.
  const ALLOWED = new Set(["source_pending_order_id", "strategy_version",
    "entry_decision_snapshot", "entry_confirmation"]);
  const setClauses = [...sql.matchAll(/update\s+public\.\w+\s+set([\s\S]*?)\bwhere\b/gi)].map(m => m[1]);
  assert(setClauses.length >= 4, `expected >=4 UPDATE statements, found ${setClauses.length}`);
  const targets = setClauses.flatMap(c => [...c.matchAll(/^\s*([a-z_]+)\s*=/gim)].map(m => m[1]));
  assert(targets.length > 0, "no assignment targets parsed — the check has drifted");
  for (const t of targets) assert(ALLOWED.has(t), `backfill assigns a non-telemetry column: ${t}`);
});

// ─── 15. no trading decision changed ────────────────────────────────────────

Deno.test("15 · the decision expressions this task must not touch are byte-identical", () => {
  // Pinned verbatim. If any of these change, this task has strayed from
  // telemetry into behaviour.
  const pins: Array<[string, string, string]> = [
    ["bot-scanner", SCANNER, "const useMarketFillAtZone = priceIsAtValidatedZone && config.marketFillAtZone && priceOnCorrectSide;"],
    ["bot-scanner", SCANNER, "if (!passesDistanceGuard(r2DistanceAtr)) {"],
    ["bot-scanner", SCANNER, "const expiresAt = route2ExpiresAt(r2PlacedAt);"],
    ["bot-scanner", SCANNER, "if (!hasRefZone && confirmationSignal.tier !== 1) {"],
    ["bot-scanner", SCANNER, "const actualFillPrice = currentPrice;"],
    ["bot-scanner", SCANNER, "if (filled && touchVerdict === \"ALREADY_CONSUMED_TOUCH\") {"],
    ["bot-scanner", SCANNER, "const resetsHunt = resetsHuntRaw && r2Gate.allowed;"],
    ["zone-confirm", ZCS, "if (!hasRefinedZone && confirmationSignal.tier !== 1) {"],
    ["zone-confirm", ZCS, "const actualFillPrice = currentPrice;"],
    ["zone-confirm", ZCS, "const resetsHunt = resetsHuntRaw && r2Gate.allowed;"],
    ["zone-confirm", ZCS, "if (account.execution_mode === \"live\" && brokerConnections.length > 0) {"],
  ];
  for (const [name, src, line] of pins) {
    assert(src.includes(line), `${name}: decision line changed or missing:\n  ${line}`);
  }
  // The canonical module is observability-only and has no runtime deps.
  const mod = code(read("../../functions/_shared/route2Confirmation.ts"));
  assert(!/^\s*import\b/m.test(mod), "route2Confirmation must have zero imports");
  assert(!/execution_mode|broker|fetch\s*\(/.test(mod), "and must not reach execution");
});
