/**
 * SMC TRADE TELEMETRY — regression suite.
 *
 * WHAT THIS GUARDS. `paper_trade_history.stop_loss` is the stop AT CLOSE, and
 * equals `exit_price` on 354 of 453 live rows (78.1%). R computed from it is a
 * division artifact — it produced +270 avgR on ETH/USD. These tests pin that R
 * is derived from an IMMUTABLE `initial_risk_price` captured at entry, that
 * management cannot move the entry record, and that a legacy row gets nulls
 * rather than reconstructed numbers.
 */

import { assertEquals, assertThrows, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildEntryTelemetry, entryConfigSnapshot, entryDecisionSnapshot,
  initialRiskPrice, realizedRGross, realizedRNet, carryToHistory,
  IMMUTABLE_COLUMNS,
} from "../../functions/_shared/smcTradeTelemetry.ts";

const LONG = {
  route: "route1_market" as const, direction: "long" as const,
  entryPrice: 1.1000, entryStopLoss: 1.0980, entryTakeProfit: 1.1040,
  entryTime: "2026-09-28T13:37:00.000Z", strategyBarTime: "2026-09-28T13:35:00.000Z",
  pipSize: 0.0001, tradingStyle: "scalper", zoneTimeframe: "1H",
  configSnapshot: null, decisionSnapshot: null,
};
const SHORT = { ...LONG, direction: "short" as const,
  entryPrice: 1.1000, entryStopLoss: 1.1020, entryTakeProfit: 1.0960 };

// ─── 1 & 2. route is persisted, and it is the one production chose ──────────

Deno.test("1 · a Route 1 trade persists route1_market", () => {
  assertEquals(buildEntryTelemetry(LONG).entry_route, "route1_market");
});

Deno.test("2 · a Route 2 trade persists route2_pending", () => {
  assertEquals(buildEntryTelemetry({ ...LONG, route: "route2_pending" }).entry_route, "route2_pending");
});

// ─── 3 & 4. the entry stop is captured, both directions ─────────────────────

Deno.test("3 · long entry preserves entry_stop_loss and a positive risk", () => {
  const t = buildEntryTelemetry(LONG);
  assertEquals(t.entry_stop_loss, 1.0980);
  assertEquals(Math.round(t.initial_risk_price * 1e6) / 1e6, 0.002);
  assertEquals(Math.round(t.initial_risk_pips), 20);
});

Deno.test("4 · short entry preserves entry_stop_loss and a positive risk", () => {
  const t = buildEntryTelemetry(SHORT);
  assertEquals(t.entry_stop_loss, 1.1020);
  assertEquals(Math.round(t.initial_risk_price * 1e6) / 1e6, 0.002);
  assertEquals(Math.round(t.initial_risk_pips), 20);
});

Deno.test("a stop on the wrong side is refused, not clamped", () => {
  // Silently clamping would produce an infinite or sign-flipped R later.
  assertThrows(() => buildEntryTelemetry({ ...LONG, entryStopLoss: 1.1010 }));
  assertThrows(() => buildEntryTelemetry({ ...LONG, entryStopLoss: 1.1000 }));
  assertEquals(initialRiskPrice("long", 1.1, 1.1), null);
});

// ─── 5 & 6. management moves the live fields, never the entry record ────────

Deno.test("5 · the live stop may move without touching entry_stop_loss", () => {
  const t = buildEntryTelemetry(LONG);
  // A position row as it looks after BE and then a trail have both fired.
  const pos = { ...t, stop_loss: "1.1000", take_profit: "1.1040" };
  pos.stop_loss = "1.1015";
  assertEquals(pos.entry_stop_loss, 1.0980);
  assertEquals(pos.initial_risk_price, t.initial_risk_price);
});

Deno.test("6 · the live target may move without touching entry_take_profit", () => {
  const t = buildEntryTelemetry(LONG);
  const pos: Record<string, unknown> = { ...t, take_profit: "1.1040" };
  pos.take_profit = "1.1080";
  assertEquals(pos.entry_take_profit, 1.1040);
});

// ─── 7-11. realized R, from the immutable risk only ─────────────────────────

/** Prices are binary floats; compare R to 9 dp, not bit-for-bit. */
const near = (a: number | null, b: number, msg = "") =>
  assertEquals(Math.round((a as number) * 1e9) / 1e9, b, msg);

Deno.test("7 · long realized R", () => {
  near(realizedRGross("long", 1.1000, 1.1030, 0.002), 1.5);
});

Deno.test("8 · short realized R", () => {
  near(realizedRGross("short", 1.1000, 1.0970, 0.002), 1.5);
});

Deno.test("9 · a target winner is +2R", () => {
  near(realizedRGross("long", 1.1000, 1.1040, buildEntryTelemetry(LONG).initial_risk_price), 2);
  near(realizedRGross("short", 1.1000, 1.0960, buildEntryTelemetry(SHORT).initial_risk_price), 2);
});

Deno.test("10 · a full stop-out is -1R gross", () => {
  near(realizedRGross("long", 1.1000, 1.0980, buildEntryTelemetry(LONG).initial_risk_price), -1);
});

Deno.test("11 · a breakeven exit is 0R gross", () => {
  near(realizedRGross("long", 1.1000, 1.1000, buildEntryTelemetry(LONG).initial_risk_price), 0);
});

Deno.test("R IGNORES the live stop — the defect this replaces", () => {
  // The historical row's `stop_loss` is the stop at CLOSE, equal to exit on
  // most rows. Using it as the denominator is what produced +270 avgR.
  const t = buildEntryTelemetry(LONG);
  // Breakeven moved the stop ONTO the entry, so the naive denominator
  // |entry - stop_at_close| collapses toward zero and R explodes. This is the
  // mechanism behind the +270 avgR observed on ETH/USD.
  const stopAtClose = 1.10001;
  const naive = (1.1040 - 1.1000) / Math.abs(1.1000 - stopAtClose);
  assert(naive > 100, `naive R should explode, got ${naive}`);
  near(realizedRGross("long", 1.1000, 1.1040, t.initial_risk_price), 2);
});

Deno.test("net R is NULL when cost is unknown, never fabricated", () => {
  assertEquals(realizedRNet(2, null), null);
  assertEquals(realizedRNet(null, 0.05), null);
  assertEquals(Math.round(realizedRNet(2, 0.05)! * 1e6) / 1e6, 1.95);
});

// ─── 12-13. archival, and legacy rows ───────────────────────────────────────

Deno.test("12 · history archive preserves every immutable entry column", () => {
  const t = buildEntryTelemetry({
    ...LONG,
    configSnapshot: entryConfigSnapshot({ tpRatio: 2.0, minConfluence: 40, marketFillAtZone: true, unrelated: 1 }),
    decisionSnapshot: entryDecisionSnapshot({ zoneScore: 5.5, confluenceScore: 41.7, displacementCandles: 3 }),
  });
  const h = carryToHistory({ ...t }, { exitPrice: 1.1040, direction: "long", costR: 0.05 });
  for (const c of IMMUTABLE_COLUMNS) {
    assertEquals(h[c], (t as Record<string, unknown>)[c], `column ${c} did not survive archival`);
  }
  near(h.realized_r_gross as number, 2);
  assertEquals(Math.round((h.realized_r_net as number) * 1e6) / 1e6, 1.95);
  // The config snapshot is an allow-list, not a config dump.
  assertEquals((t.entry_config_snapshot as Record<string, unknown>).unrelated, undefined);
  assertEquals((t.entry_config_snapshot as Record<string, unknown>).tpRatio, 2.0);
});

Deno.test("13 · a legacy row gets nulls and legacy_unknown, never a fabricated R", () => {
  // Exactly what a pre-migration position looks like: a mutable stop that
  // management already overwrote, and nothing else.
  const legacy = { stop_loss: "1.1040", take_profit: "1.1040", entry_price: "1.1000" };
  const h = carryToHistory(legacy, { exitPrice: 1.1040, direction: "long", costR: null });
  assertEquals(h.entry_route, "legacy_unknown");
  assertEquals(h.entry_stop_loss, null);
  assertEquals(h.initial_risk_price, null);
  assertEquals(h.realized_r_gross, null);
  assertEquals(h.realized_r_net, null);
});

// ─── 14-15. exact entry time, and strategy identity ─────────────────────────

Deno.test("14 · the exact entry instant is preserved, not the parent bar", () => {
  const t = buildEntryTelemetry(LONG);
  assertEquals(t.entry_time, "2026-09-28T13:37:00.000Z");
  assertEquals(t.strategy_bar_time, "2026-09-28T13:35:00.000Z");
  assert(t.entry_time !== t.strategy_bar_time, "entry time must not collapse to the bar");
  const h = carryToHistory({ ...t }, { exitPrice: 1.1040, direction: "long" });
  assertEquals(h.entry_time, "2026-09-28T13:37:00.000Z");
});

Deno.test("15 · every row is stamped smc, so no IPO trade can be mislabelled", () => {
  const t = buildEntryTelemetry(LONG);
  assertEquals(t.strategy_name, "smc");
  // Version comes from the existing contract constant, not a new literal.
  assertEquals(t.strategy_version, "smc-zone-impulse-control-v1");
  assertEquals(t.trading_style, "scalper");
});

// ─── write-path guard ───────────────────────────────────────────────────────

Deno.test("the production inserts actually carry the telemetry block", () => {
  // Unit-testing the helper alone would pass while the scanner never called
  // it — which is how the max-hold rule ended up configured but unreachable.
  const scanner = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url));
  assert(/route:\s*"route1_market"/.test(scanner), "Route 1 entry must set route1_market");
  assert(/route:\s*"route2_pending"/.test(scanner), "Route 2 fill must set route2_pending");
  assert(/\.\.\.r1Telemetry/.test(scanner), "Route 1 insert must spread the telemetry block");
  assert(/\.\.\.r2Telemetry/.test(scanner), "Route 2 insert must spread the telemetry block");
  assert(/\.\.\.carryToHistory\(/.test(scanner), "the archive must carry the block to history");

  const zcs = Deno.readTextFileSync(
    new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url));
  assert(/\.\.\.zcTelemetry/.test(zcs), "zone-confirmation fill must spread the telemetry block");
});
