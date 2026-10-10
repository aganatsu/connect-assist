/**
 * Candidate C live shadow — pure module, cache peek, and source pins.
 * The execution-level OFF-vs-ON tests are in shadowZoneMidHarness.test.ts;
 * the database isolation tests are in paperSettlementLedger.test.ts.
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isShadowOrder, parseShadowMode, peekAll, SHADOW_BOT_ID, SHADOW_MIN_COVERAGE_OVERALL, SHADOW_MIN_COVERAGE_PER_PAIR,
  shadowBookFromAttribution, shadowCoverage, shadowEligibleSource, shadowHunts, shadowOrderId, shadowPlaces,
  shadowRequiredSeries, shadowRoute2Geometry, zoneMidLimit,
} from "../../functions/_shared/shadowZoneMid.ts";
import { createScanCache } from "../../functions/_shared/dataCache.ts";
import { baseScope, runShadowHook } from "./shadowHookSandbox.ts";
import { FakeDb } from "./scannerHarness.ts";
import { writeShadowIntents } from "../../functions/_shared/shadowZoneMid.ts";
import { getQuoteToUSDRate, SPECS } from "../../functions/_shared/smcAnalysis.ts";
import { requiredRatePairs } from "../../functions/_shared/rateMapPolicy.ts";
import { mapNestedToFlat } from "../../functions/_shared/configMapper.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const scanner = read("../../functions/bot-scanner/index.ts");

// ── Flag ────────────────────────────────────────────────────────────────────

Deno.test("shadow flag: defaults OFF; only exact on/drain enable anything", () => {
  for (const raw of [undefined, null, "", "off", "OFF", "true", "1", "yes", "enabled", "on ", " drain", "ON", "Drain"]) {
    const m = parseShadowMode(raw as any);
    const expect = typeof raw === "string" && ["on", "drain"].includes(raw.trim().toLowerCase()) ? raw.trim().toLowerCase() : "off";
    assertEquals(m, expect, `raw=${JSON.stringify(raw)}`);
  }
  assertEquals([shadowPlaces("off"), shadowHunts("off")], [false, false]);
  assertEquals([shadowPlaces("drain"), shadowHunts("drain")], [false, true]);
  assertEquals([shadowPlaces("on"), shadowHunts("on")], [true, true]);
});

// ── Identity ────────────────────────────────────────────────────────────────

Deno.test("shadow order ids can never equal an A order id (8 hex)", () => {
  for (let i = 0; i < 500; i++) {
    const id = shadowOrderId();
    assertEquals(id.length, 12);
    assert(/^zm[0-9a-f]{10}$/.test(id));
    assertFalse(/^[0-9a-f]{8}$/.test(id));
  }
  assertEquals(SHADOW_BOT_ID, "smc_shadow_zonemid");
  assert(isShadowOrder({ bot_id: "smc_shadow_zonemid" }));
  assertFalse(isShadowOrder({ bot_id: "smc" }));
  assertFalse(isShadowOrder(null));
});

Deno.test("C is built only for Impulse Zone entries, at A's midpoint expression", () => {
  assert(shadowEligibleSource("refinedEntry"));
  assert(shadowEligibleSource("zoneMid"));
  assertFalse(shadowEligibleSource("unified"));
  assertFalse(shadowEligibleSource("legacy"));
  const z = { high: 1.23456, low: 1.23111 };
  assertEquals(zoneMidLimit(z), (z.high + z.low) / 2);
  assertEquals(zoneMidLimit({ high: "1.2", low: 1.1 } as any), null);
  assertEquals(zoneMidLimit(null), null);
});

// ── Geometry: A's limit reproduces A's recorded orders ───────────────────────

const cfg = JSON.parse(read("./fixtures/baseline_a_config.json"));
const TP_RATIO = (mapNestedToFlat(cfg.config_json) as any).tpRatio as number;
const recorded = JSON.parse(read("./fixtures/route2_recorded_orders.json")).orders as any[];

/** The FX rate map that yields the recorded quote→USD conversion. */
function rateMapFor(symbol: string, quoteToUSD: number): Record<string, number> {
  const pairs = requiredRatePairs([symbol]);
  if (!pairs.length) return {};
  const invert = getQuoteToUSDRate(symbol, { [pairs[0]]: 2 }) === 0.5;
  return { [pairs[0]]: invert ? 1 / quoteToUSD : quoteToUSD };
}
const close = (a: number, b: number) => a === b || Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));

Deno.test("geometry fed A's limit reproduces every recorded A order (57 orders)", () => {
  assertEquals(TP_RATIO, 1.1);
  assertEquals(recorded.length, 57);
  let exactAll = 0;
  for (const o of recorded) {
    const lim = o.route2Stop.limit;
    const ps = o.plannedSizing;
    const g = shadowRoute2Geometry({
      // route2Stop.limitEntry is the exact double A used (jsonb keeps it; the
      // numeric entry_price column rounds 10 of these 57 in the last digit).
      direction: o.direction, limit: o.route2Stop.limitEntry, lastPrice: o.lastPrice, h1Atr: o.h1Atr,
      marketSL: o.route2Stop.market.sl, tpRatio: TP_RATIO, stopAnchor: o.switches.stopAnchor,
      swingSL: lim.source === "swing" ? lim.sl : null,
      impulseSL: lim.source === "impulse" ? lim.sl : null,
      impulseCapPips: o.route2Stop.capPips, minSlPips: o.route2Stop.floorPips,
      pipSize: (SPECS[o.symbol] || SPECS["EUR/USD"]).pipSize, symbol: o.symbol,
      rateMap: rateMapFor(o.symbol, ps.quoteToUSD), commissionPerLot: 0,
      orderRRMin: o.switches.orderRRMin, rrGateMode: o.switches.rrGateMode, sizingMode: o.switches.sizingMode,
      balance: ps.balance, riskPercent: ps.riskPercentTarget, maxLotsPerTrade: o.switches.maxLotsPerTrade,
      legacyLots: () => 0.01, halveLegacy: true,
    });
    assert(g.ok, `${o.order_id}: ${!g.ok && g.reason}`);
    if (!g.ok) continue;
    const id = o.order_id;
    // placement outputs — bit for bit
    // stored numeric inputs (price, ATR) round-trip through Postgres, so the
    // ratio is compared to 1e-12; every price output below is bit-exact.
    assert(close(g.distanceAtr!, o.distanceAtr), `${id} distance ${g.distanceAtr} vs ${o.distanceAtr}`);
    assertEquals(g.stop, o.initialStop, `${id} stop`);
    assertEquals(g.target, o.initialTarget, `${id} target`);
    assertEquals((g.route2Stop as any).market, o.route2Stop.market, `${id} market-anchored record`);
    const { impulseRejected: _a, ...gLim } = (g.route2Stop as any).limit;
    const { impulseRejected: _b, ...rLim } = lim;
    assertEquals(gLim, rLim, `${id} limit-anchored record`);
    for (const k of ["rawRR", "effectiveRR", "costInPrice", "spreadPips", "min", "mode", "wouldBlock"]) {
      assertEquals((g.orderRR as any)[k], o.orderRR[k], `${id} orderRR.${k}`);
    }
    assertEquals(g.size, ps.lots, `${id} size`);
    assertEquals(g.plannedSizing!.lots, ps.lots, `${id} planned lots`);
    // derived through the reconstructed FX rate: equal to the last bit or within 1e-12
    for (const k of ["uncappedLots", "perLotRiskUsd", "riskUsdActual", "quoteToUSD", "stopDistance", "capLots"]) {
      assert(close((g.plannedSizing as any)[k], ps[k]), `${id} planned ${k}: ${(g.plannedSizing as any)[k]} vs ${ps[k]}`);
    }
    if (["uncappedLots", "perLotRiskUsd", "riskUsdActual"].every((k) => (g.plannedSizing as any)[k] === ps[k])) exactAll++;
  }
  assert(exactAll >= 50, `bit-exact sizing on ${exactAll}/57`);
});

Deno.test("geometry rejects exactly as A's gates do (distance, stop, R:R) and never uses A's limit", () => {
  const base = {
    direction: "long" as const, limit: 1.1, lastPrice: 1.101, h1Atr: 0.002, marketSL: 1.095, tpRatio: 1.1, stopAnchor: "limit",
    swingSL: null, impulseSL: null, impulseCapPips: null, minSlPips: 25, pipSize: 0.0001, symbol: "EUR/USD",
    rateMap: {}, commissionPerLot: 0, orderRRMin: 1, rrGateMode: "order_geometry", sizingMode: "fill_time",
    balance: 100000, riskPercent: 0.5, maxLotsPerTrade: 10, legacyLots: () => 1, halveLegacy: true,
  };
  const far = shadowRoute2Geometry({ ...base, lastPrice: 1.1031 });          // 1.55 ATR
  assertEquals(far.ok ? "ok" : far.status, "zone_setup_rejected_distance");
  const noAtr = shadowRoute2Geometry({ ...base, h1Atr: null });
  assertEquals(noAtr.ok ? "ok" : noAtr.status, "zone_setup_rejected_distance");
  const edge = shadowRoute2Geometry({ ...base, lastPrice: 1.103 });          // exactly 1.5 ATR passes
  assert(edge.ok);
  const badStop = shadowRoute2Geometry({ ...base, minSlPips: 0 });
  assertEquals(badStop.ok ? "ok" : badStop.status, "zone_setup_rejected_stop");
  const rr = shadowRoute2Geometry({ ...base, orderRRMin: 1.2 });            // 1.1R raw, 1.06R effective
  assertEquals(rr.ok ? "ok" : rr.status, "zone_setup_rejected_rr");
  const logOnly = shadowRoute2Geometry({ ...base, orderRRMin: 1.2, rrGateMode: "log" });
  assert(logOnly.ok && (logOnly.orderRR as any).wouldBlock === true);
  const marketAnchor = shadowRoute2Geometry({ ...base, stopAnchor: "market", orderRRMin: 0 });
  assert(marketAnchor.ok && marketAnchor.stop === 1.095);
  const limitAnchor = shadowRoute2Geometry(base);
  assert(limitAnchor.ok && limitAnchor.stop === 1.1 - 25 * 0.0001 && (limitAnchor.route2Stop as any).limit.source === "floor");
});

Deno.test("legacy sizing fallback mirrors A: 0.5× unless unified, floor 0.01; planned size wins when ok", () => {
  const base = {
    direction: "short" as const, limit: 1.1, lastPrice: 1.0995, h1Atr: 0.002, marketSL: 1.105, tpRatio: 1.1, stopAnchor: "limit",
    swingSL: null, impulseSL: null, impulseCapPips: null, minSlPips: 25, pipSize: 0.0001, symbol: "EUR/USD",
    rateMap: {}, commissionPerLot: 0, orderRRMin: 1, rrGateMode: "order_geometry", sizingMode: "legacy",
    balance: 100000, riskPercent: 0.5, maxLotsPerTrade: 10, legacyLots: () => 0.37, halveLegacy: true,
  };
  const halved = shadowRoute2Geometry(base);
  assert(halved.ok && halved.size === 0.19);
  const unified = shadowRoute2Geometry({ ...base, halveLegacy: false });
  assert(unified.ok && unified.size === 0.37);
  const tiny = shadowRoute2Geometry({ ...base, legacyLots: () => 0.01 });
  assert(tiny.ok && tiny.size === 0.01);
  const planned = shadowRoute2Geometry({ ...base, sizingMode: "fill_time" });
  assert(planned.ok && planned.plannedSizing?.ok && planned.size === planned.plannedSizing.lots);
});

// ── Hunt data rule ──────────────────────────────────────────────────────────

Deno.test("required series = exactly what A's hunt body reads for the order's state", () => {
  const live = { pendingInterval: "5m", thesisValidationEnabled: true, thesisStyleAware: false, style: "scalper", confirmTF: "5m" };
  assertEquals(shadowRequiredSeries({ ...live, status: "pending", isManagementOnly: true }), ["5m", "1d", "4h", "1h"]);
  assertEquals(shadowRequiredSeries({ ...live, status: "pending", isManagementOnly: false }), ["5m", "1d", "4h", "1h", "15m"]);
  assertEquals(shadowRequiredSeries({ ...live, status: "awaiting_confirmation", isManagementOnly: true }), ["5m", "1d", "4h", "1h"]);
  assertEquals(shadowRequiredSeries({ ...live, confirmTF: "15m", status: "awaiting_confirmation", isManagementOnly: true }), ["5m", "1d", "4h", "1h", "15m"]);
  assertEquals(shadowRequiredSeries({ ...live, style: "swing_trader", thesisStyleAware: true, status: "pending", isManagementOnly: true }), ["5m", "1d", "4h", "1h", "1w"]);
  assertEquals(shadowRequiredSeries({ ...live, thesisValidationEnabled: false, status: "pending", isManagementOnly: false }), ["5m"]);
});

Deno.test("peekAll: present only when every series is cached and non-empty", () => {
  const c = (n: number) => Array.from({ length: n }, (_, i) => ({ datetime: `${i}`, open: 1, high: 1, low: 1, close: 1 })) as any;
  const m = new Map<string, any>([["EUR/USD|5m", c(3)], ["EUR/USD|1h", c(2)], ["EUR/USD|4h", []]]);
  const peek = (s: string, i: string) => m.get(`${s}|${i}`);
  const ok = peekAll(peek, "EUR/USD", ["5m", "1h"]);
  assert(ok.ok && ok.series.get("5m")!.length === 3);
  const miss = peekAll(peek, "EUR/USD", ["5m", "4h", "1d"]);
  assert(!miss.ok);
  assertEquals((miss as any).missing, ["4h", "1d"]);
});

Deno.test("cache peek(): never fetches, never joins in-flight, never moves A's hit/miss stats", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const cache = createScanCache(async (s, i) => {
    calls++;
    if (s === "SLOW") await gate;
    return [{ datetime: "t", open: 1, high: 1, low: 1, close: 1 }] as any;
  });
  assertEquals(cache.peek("EUR/USD", "5m"), undefined);
  assertEquals([calls, JSON.stringify(cache.stats())], [0, JSON.stringify({ hits: 0, misses: 0, errors: 0, seeded: 0 })]);
  await cache.get("EUR/USD", "5m", "5d");
  const before = cache.stats();
  for (let i = 0; i < 5; i++) assertEquals(cache.peek("EUR/USD", "5m")!.length, 1);
  assertEquals(cache.peek("EUR/USD", "1h"), undefined);
  assertEquals(cache.stats(), before);
  assertEquals(calls, 1);
  // in flight: peek sees nothing and does not dedupe onto the request
  const p = cache.get("SLOW", "5m", "5d");
  assertEquals(cache.peek("SLOW", "5m"), undefined);
  release();
  await p;
  assertEquals(cache.peek("SLOW", "5m")!.length, 1);
  assertEquals(cache.stats(), { hits: 0, misses: 2, errors: 0, seeded: 0 });
  // A's sequence of get() results is identical with interleaved peeks
  const a = createScanCache(async () => [{ datetime: "t", open: 1, high: 1, low: 1, close: 1 }] as any);
  const b = createScanCache(async () => [{ datetime: "t", open: 1, high: 1, low: 1, close: 1 }] as any);
  for (const [s, i] of [["X", "5m"], ["X", "5m"], ["Y", "1h"], ["X", "5m"]]) {
    await a.get(s, i, "r");
    b.peek(s, i); b.peek("Z", i);
    await b.get(s, i, "r");
    b.peek(s, i);
  }
  assertEquals(a.stats(), b.stats());
  assertEquals(a.size(), b.size());
});

Deno.test("C's fill-time book: C fills not yet closed, shaped like A's position rows", () => {
  assertEquals(shadowBookFromAttribution(null), []);
  assertEquals(shadowBookFromAttribution([{ symbol: "EUR/USD", direction: "long" }, { symbol: null, direction: "x" } as any]), [{ symbol: "EUR/USD", direction: "long" }]);
});

// ── Evaluation validity ─────────────────────────────────────────────────────

Deno.test("coverage gate: ≥90% overall AND ≥80% every pair; failing pairs reported and excluded", () => {
  assertEquals([SHADOW_MIN_COVERAGE_OVERALL, SHADOW_MIN_COVERAGE_PER_PAIR], [0.9, 0.8]);
  const polls = (sym: string, n: number, gaps: number) =>
    Array.from({ length: n }, (_, i) => ({ symbol: sym, branch: i < gaps ? "shadow_no_data" : "watching_no_change" }));
  const good = shadowCoverage([...polls("EUR/USD", 100, 5), ...polls("USD/JPY", 100, 10)]);
  assert(good.valid);
  assertEquals(good.overall, 0.925);
  assertEquals(good.excludedPairs, []);
  // one pair at 79% sinks validity even though overall is ≥ 90%
  const onePair = shadowCoverage([...polls("EUR/USD", 900, 0), ...polls("NZD/CHF", 100, 21)]);
  assertEquals(onePair.overall, 0.979);
  assertFalse(onePair.valid);
  assertEquals(onePair.excludedPairs, ["NZD/CHF"]);
  assertEquals(onePair.perPair["NZD/CHF"].coverage, 0.79);
  // exactly 80% per pair passes; overall 89.9% fails
  assert(shadowCoverage(polls("A", 10, 2)).perPair["A"].meetsMin);
  assertFalse(shadowCoverage([...polls("A", 1000, 101)]).valid);
  assertFalse(shadowCoverage([]).valid);
});

// ── Source pins: the guards that keep A unchanged ────────────────────────────

/** The hunt loop body, from the per-order routing to the end of the loop. */
const huntBody = scanner.slice(scanner.indexOf("for await (const pending of huntOrders())"), scanner.indexOf("// ── Flush the Route 2 poll log ──"));
const hook = scanner.slice(scanner.indexOf("// ── Candidate C shadow: C's order from the same inputs ──"), scanner.indexOf("if (effectiveLimitEnabled && limitEntry) {\n          // ── ROUTE 2 DISTANCE GUARD"));

Deno.test("pin: A's hunt query, list and order are unchanged; C loads only after A's orders, only when on/drain", () => {
  assert(scanner.includes(`const { data: activePendingOrders } = await supabase.from("pending_orders").select("*")
    .eq("user_id", userId).eq("bot_id", BOT_ID).in("status", ["pending", "awaiting_confirmation"])
    .order("placed_at", { ascending: true });`));
  const gen = scanner.slice(scanner.indexOf("const huntOrders = async function*"), scanner.indexOf("for await (const pending of huntOrders())"));
  const aYield = gen.indexOf("if (activePendingOrders) yield* activePendingOrders;");
  const gate = gen.indexOf("if (!shadowHunts(shadowMode)) return;");
  const cQuery = gen.indexOf(`.eq("bot_id", SHADOW_BOT_ID).eq("dry_run", true)`);
  assert(aYield > 0 && gate > aYield && cQuery > gate, "A first, then the flag gate, then the C query");
});

Deno.test("pin: every A-facing side effect in the hunt is routed or guarded for C", () => {
  for (const banned of ["route2PollRows.push", "route2PollRows.length", "thesisObservations.push", "touchChecks.push", "confirmationHunt.push", "cachedFetch(", `pollerName: "bot-scanner"`]) {
    assertFalse(huntBody.includes(banned), `hunt body still references ${banned}`);
  }
  for (const counter of ["pendingCancelled++", "pendingExpired++", "pendingConfirmationHunting++", "pendingConfirmationHunting--"]) {
    const all = huntBody.split(counter).length - 1;
    const guarded = huntBody.split(`if (!isShadow) ${counter}`).length - 1;
    assertEquals(guarded, all, `${counter}: ${guarded}/${all} guarded`);
  }
  const telegram = huntBody.match(/if \([^)]*shouldNotify\("(thesis_invalidated|zone_touched)"\)\)/g) ?? [];
  assertEquals(telegram.length, 2);
  for (const t of telegram) assert(t.startsWith("if (!isShadow && "), t);
  // the routing itself is identity for A
  for (const line of [
    "const pollSink = isShadow ? shadowPollRows : route2PollRows;",
    `const pollerName = isShadow ? SHADOW_POLLER_NAME : "bot-scanner";`,
    "const thesisObs = isShadow ? shadowObservations : thesisObservations;",
    "const touchObs = isShadow ? shadowObservations : touchChecks;",
    "const huntObs = isShadow ? shadowObservations : confirmationHunt;",
    "const huntFetch = isShadow ? shadowFetch : cachedFetch;",
    "let capBook: any[] = openPosArr;",
  ]) assert(huntBody.includes(line), line);
  // C fills before A's dry-run (17-A) branch and never reaches the real fill claim
  const cFill = huntBody.indexOf("if (isShadow) {\n            // Candidate C: NO 17-A re-anchor.");
  const aDry = huntBody.indexOf("if ((pending as any).dry_run === true) {\n            // Step 17-A (DRY RUN ONLY)");
  const claim = huntBody.indexOf("await claimRoute2Fill(");
  assert(cFill > 0 && aDry > cFill && claim > aDry);
  assert(huntBody.slice(cFill, aDry).includes("continue;"));
  assertFalse(huntBody.slice(cFill, aDry).includes("dryRunFillGeometry"));
});

Deno.test("pin: shadowFetch only peeks; the shadow poll rows are a separate insert after A's", () => {
  const sf = scanner.slice(scanner.indexOf("const shadowFetch = "), scanner.indexOf("const shadowIntents"));
  assert(sf.includes("scanCache.peek(sym, interval)"));
  assertFalse(/scanCache\.get|cachedFetch|fetchCandles/.test(sf));
  const flush = scanner.slice(scanner.indexOf("// ── Flush the Route 2 poll log ──"), scanner.indexOf("// ── Management-Only Early Return ──"));
  const aInsert = flush.indexOf(`insert(route2PollRows)`);
  const cInsert = flush.indexOf(`insert(shadowPollRows)`);
  assert(aInsert > 0 && cInsert > aInsert);
});

Deno.test("pin: the placement hook is pure — no await, no write to detail/cap/scanDetails, no A counter", () => {
  assert(hook.length > 1000);
  assertFalse(/\bawait\b/.test(hook), "await in hook");
  assertFalse(/\bdetail(\s+as\s+any\))?\.[A-Za-z_]+\s*=[^=]/.test(hook.replace(/\(detail as any\)/g, "detail")), "write to detail");
  assertFalse(/\bcap\.[A-Za-z_]+\s*=[^=]/.test(hook), "write to cap");
  assertFalse(/scanDetails|pendingPlaced|signalsFound|tradesPlaced|rejectedCount/.test(hook));
  assertFalse(/supabase\./.test(hook));
  assert(hook.includes("if (effectiveLimitEnabled && limitEntry && shadowPlaces(shadowMode) && shadowEligibleSource(limitEntrySource) && izData?.bestZone)"));
  assert(hook.includes("bot_id: SHADOW_BOT_ID") && hook.includes("dry_run: true") && hook.includes(`entrySource: "zoneMid"`));
  assert(hook.includes("} catch (e: any) {"));
});

Deno.test("pin: intents are written after A's decision capture, in a try/catch, before A's counters", () => {
  const capWrite = scanner.indexOf(`.from("smc_scan_decision")\n        .upsert(rows`);
  const flushAt = scanner.indexOf("// ── Candidate C shadow: write the queued intents ──");
  const counters = scanner.indexOf("// Update counters — scope to this bot's account");
  assert(capWrite > 0 && flushAt > capWrite && counters > flushAt);
  const flush = scanner.slice(flushAt, counters);
  assert(flush.includes("const t = await writeShadowIntents(supabase, userId, shadowIntents);"));
  assert(flush.includes("try {") && flush.includes("} catch (e: any) {"));
  assertEquals((scanner.match(/writeShadowIntents\(/g) ?? []).length, 1);
  assertEquals((scanner.match(/shadowIntents\.push\(/g) ?? []).length, 1);
});

Deno.test("pin: no config, cron, risk or migration surface — the flag is an env secret read once", () => {
  assertEquals((scanner.match(/SHADOW_ENV_VAR/g) ?? []).length, 2); // import + one read
  assertFalse(/__rawConfigJson[^\n]*shadow|shadow[^\n]*__rawConfigJson/i.test(scanner));
});

// ── The placement hook, executed (exact source, deep-frozen scope) ──────────

Deno.test("hook: builds one C intent at the zone midpoint with A's rules, from a deep-frozen scope", () => {
  const scope = baseScope();
  const { shadowIntents, logs } = runShadowHook(scope);
  assertEquals(logs, []);
  assertEquals(shadowIntents.length, 1);
  const it = shadowIntents[0];
  const bz = (scope.izData as any).bestZone;
  const mid = (bz.high + bz.low) / 2;
  assertEquals(it.limit, mid);
  // geometry: the same function, same inputs, at the midpoint
  const g = shadowRoute2Geometry({
    direction: "long", limit: mid, lastPrice: 190.2, h1Atr: 0.18000000000000682, marketSL: 189.93208, tpRatio: TP_RATIO,
    stopAnchor: (scope.simp as any).stopAnchor, swingSL: 189.95, impulseSL: 189.90, impulseCapPips: 66.71, minSlPips: 25,
    pipSize: 0.01, symbol: "CHF/JPY", rateMap: { "USD/JPY": 150 }, commissionPerLot: 0, orderRRMin: (scope.simp as any).orderRRMin,
    rrGateMode: (scope.simp as any).rrGateMode, sizingMode: (scope.simp as any).sizingMode, balance: 100000,
    riskPercent: (scope.simp as any).riskPercent, maxLotsPerTrade: (scope.simp as any).maxLotsPerTrade, legacyLots: () => 0, halveLegacy: true,
  });
  assert(g.ok);
  assertEquals([it.stop, it.target, it.size], [g.stop, g.target, g.size]);
  const o = it.order;
  assertEquals([o.bot_id, o.dry_run, o.entry_price, o.status, o.symbol, o.direction, o.entry_source, o.strategy_version],
    ["smc_shadow_zonemid", true, mid, "pending", "CHF/JPY", "long", "zoneMid", "shadow-zonemid.v1"]);
  assert(/^zm[0-9a-f]{10}$/.test(o.order_id));
  assertEquals([o.stop_loss, o.take_profit, o.size, o.initial_stop_loss, o.initial_take_profit], [g.stop, g.target, g.size, g.stop, g.target]);
  assertEquals([o.refined_zone_low, o.refined_zone_high, o.entry_zone_low, o.entry_zone_high], [189.95, 190.142885, bz.low, bz.high]);
  assertEquals(o.config_hash, cfg.config_version);
  assertEquals(o.expiry_minutes, 480);
  assertEquals(Date.parse(o.expires_at) - Date.parse(o.placed_at), 480 * 60_000);
  const sr = JSON.parse(o.signal_reason);
  assertEquals([sr.bot, sr.shadow.arm, sr.impulseZone.impulse.high], ["smc_shadow_zonemid", "C", 190.49909]);
  assertEquals(o.dry_run_context.shadow, { arm: "C", pairedDecisionId: "11111111-1111-4111-8111-111111111111", pairedScanCycleId: "22222222-2222-4222-8222-222222222222", pairedSignalId: null,
    aFinalStatus: null, aLimit: 190.142885, aEntrySource: "refinedEntry", aDistanceAtr: o.dry_run_context.shadow.aDistanceAtr });
  assertEquals(o.dry_run_context.route2Stop, g.route2Stop);
  const a = it.attribution;
  assertEquals([a.bot_id, a.dry_run, a.entry_source, a.strategy_version, a.decision_id, a.scan_cycle_id, a.config_version, a.primary_engine, a.limit_price, a.stop_price, a.target_price],
    ["smc_shadow_zonemid", true, "zoneMid", "shadow-zonemid.v1", "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", cfg.config_version, "impulse_zone", mid, g.stop, g.target]);
  assert(it.shadowCtx === o.dry_run_context.shadow, "pairing fields written at flush land in the order row");
});

Deno.test("hook: any write to A's state is impossible — a mutating dependency is caught and yields no intent", () => {
  const sneaky = (i: any) => { i.slFloor.floorPips = 1; return {}; };
  const r = runShadowHook(baseScope(), { imports: { buildFrozenDecision: sneaky } });
  assertEquals(r.shadowIntents.length, 0);
  assert(r.logs.some((l) => l.includes("intent build failed (A unaffected)")), r.logs.join("|"));
  const boom = runShadowHook(baseScope(), { imports: { buildAttribution: () => { throw new Error("boom"); } } });
  assertEquals(boom.shadowIntents.length, 0);
  assert(boom.logs.some((l) => l.includes("boom")));
});

Deno.test("hook: nothing when OFF or DRAIN, off the Route 2 path, for non-Impulse sources, without a zone, or without a valid config hash", () => {
  assertEquals(runShadowHook(baseScope({ effectiveLimitEnabled: false })).shadowIntents.length, 0, "A takes no Route 2 order → no C");
  assertEquals(runShadowHook(baseScope({ limitEntry: null })).shadowIntents.length, 0);
  for (const mode of ["off", "drain"]) assertEquals(runShadowHook(baseScope({ shadowMode: mode })).shadowIntents.length, 0, mode);
  for (const src of ["unified", "legacy"]) assertEquals(runShadowHook(baseScope({ limitEntrySource: src })).shadowIntents.length, 0, src);
  assertEquals(runShadowHook(baseScope({ izData: { hasZone: false, bestZone: null } })).shadowIntents.length, 0);
  const cfgBad: any = { ...(baseScope().config as any), __configVersion: null };
  assertEquals(runShadowHook(baseScope({ config: cfgBad })).shadowIntents.length, 0);
});

Deno.test("hook: C's own gates — rejected by distance when the midpoint is too far, even though A's limit passes", () => {
  // price just above refinedEntry: A at 0.03 ATR, the midpoint at 1.6 ATR
  const r = runShadowHook(baseScope({ hourlyCandles: Array.from({ length: 30 }, (_, i) => ({ datetime: `${i}`, open: 190.15, high: 190.175, low: 190.125, close: 190.15 })), analysis: { direction: "long", lastPrice: 190.15, score: 61.6, factors: [], summary: "" } }));
  assertEquals(r.shadowIntents.length, 0);
  assert(r.logs.some((l) => l.includes("C not placed — zone_setup_rejected_distance")), r.logs.join("|"));
});

Deno.test("hook: when A already enters at the midpoint, C's order is A's geometry", () => {
  const bz = { type: "ob", low: 189.99417, high: 190.14972, refinedEntry: null, ltfRefined: false };
  const mid = (bz.high + bz.low) / 2;
  const r = runShadowHook(baseScope({ limitEntrySource: "zoneMid", izData: { hasZone: true, selectedTF: "1H", impulse: null, bestZone: bz },
    limitEntry: { price: mid, zoneType: "IZ-OB", zoneLow: bz.low, zoneHigh: bz.high } }));
  assertEquals(r.shadowIntents.length, 1);
  assertEquals(r.shadowIntents[0].limit, mid);
  assertEquals([r.shadowIntents[0].order.refined_zone_low, r.shadowIntents[0].order.refined_zone_high], [null, null]);
});

// ── Writing intents (shadow namespace only) ─────────────────────────────────

Deno.test("writeShadowIntents: same level → refresh in place; moved → supersede C's orders only; pairing read from A after A acted", async () => {
  const USER = "u1";
  const intent = runShadowHook(baseScope({ userId: USER })).shadowIntents[0];
  const aRow = { user_id: USER, bot_id: "smc", order_id: "aaaa0001", symbol: "CHF/JPY", direction: "long", status: "pending", entry_price: 190.0, signal_score: 50 };
  const cSame = { user_id: USER, bot_id: "smc_shadow_zonemid", order_id: "zm0000000001", symbol: "CHF/JPY", direction: "long", status: "pending", entry_price: intent.limit, signal_score: 50 };
  const cMoved = { ...cSame, order_id: "zm0000000002", entry_price: intent.limit - 0.2 };
  // same level
  const db1 = new FakeDb({ pending_orders: [aRow, cSame] });
  const placed1: any[] = [];
  const t1 = await writeShadowIntents(db1.client(), USER, [intent], async (_s, i) => { placed1.push(i); return { outcome: "placed" } as any; });
  assertEquals(t1, { placed: 0, refreshed: 1, duplicate: 0, failed: 0 });
  assertEquals(placed1.length, 0);
  const upd = db1.writes.find((w) => w.table === "pending_orders" && w.op === "update")!;
  assert(upd.filters.includes("bot_id=eq.smc_shadow_zonemid") && upd.filters.includes("order_id=in.(zm0000000001)"));
  assertEquals(db1.rows("pending_orders").find((r) => r.order_id === "aaaa0001"), aRow, "A untouched");
  assert(db1.reads.every((r) => r.filters.includes("bot_id=eq.smc_shadow_zonemid")), "only C's namespace is read");
  // moved level, with A's pairing known by write time
  const db2 = new FakeDb({ pending_orders: [aRow, cMoved] });
  const placed2: any[] = [];
  const it2 = runShadowHook(baseScope({ userId: USER, cap: { id: "11111111-1111-4111-8111-111111111111", signal_id: "A-SIG" }, detail: { status: "signal", signalSource: "impulse" } })).shadowIntents[0];
  const t2 = await writeShadowIntents(db2.client(), USER, [it2], async (_s, i) => { placed2.push(i); return { outcome: "placed" } as any; });
  assertEquals(t2.placed, 1);
  assertEquals(placed2[0].supersede.map((x: any) => x.order_id), ["zm0000000002"]);
  assertEquals([placed2[0].order.dry_run_context.shadow.pairedSignalId, placed2[0].order.dry_run_context.shadow.aFinalStatus], ["A-SIG", "signal"]);
  assertEquals(db2.writes.length, 0, "placement goes only through route2_place_order");
});

Deno.test("writeShadowIntents: a failing intent is counted and the next one still runs; nothing throws", async () => {
  const USER = "u1";
  const a = runShadowHook(baseScope({ userId: USER })).shadowIntents[0];
  const b = runShadowHook(baseScope({ userId: USER, pair: "EUR/USD" })).shadowIntents[0];
  const db = new FakeDb({});
  db.fault = (op, _t, f) => (op === "read" && f.includes("symbol=eq.CHF/JPY") ? "throw" : null);
  const calls: string[] = [];
  const t = await writeShadowIntents(db.client(), USER, [a, b, b, b], async (_s, i) => {
    calls.push(String(i.order.symbol));
    if (calls.length === 2) throw new Error("rpc down");
    return { outcome: calls.length === 3 ? "duplicate" : "placed" } as any;
  });
  assert(a && b);
  assertEquals(calls, ["EUR/USD", "EUR/USD", "EUR/USD"], "CHF/JPY failed before placement; the rest still ran");
  assertEquals(t, { placed: 1, refreshed: 0, duplicate: 1, failed: 2 });
});

Deno.test("pin: no UI exposure — every client-facing pending-order read is bot 'smc'; the app never reads the tables directly", () => {
  assert(scanner.includes(`const BOT_ID = "smc";`));
  for (const action of [`if (action === "pending_orders")`, `if (action === "active_pending")`]) {
    const at = scanner.indexOf(action);
    assert(at > 0, action);
    assert(scanner.slice(at, at + 900).includes(`.eq("user_id", userId).eq("bot_id", BOT_ID)`), action);
  }
  const reset = read("../../functions/system-reset/index.ts");
  assert(reset.includes(`db.from("pending_orders").select("id").eq("user_id", acct.user_id).eq("bot_id", SMC_BOT_ID)`));
  const zcs = read("../../functions/zone-confirmation-scanner/index.ts");
  assert(zcs.includes(`const BOT_ID = "smc";`) && zcs.includes(`.eq("bot_id", BOT_ID)\n      .eq("status", "awaiting_confirmation")`), "the second poller never sees C");
  for (const f of ["../../../src/lib/api.ts", "../../../src/lib/systemReset.ts"]) {
    assertFalse(/from\(["'](pending_orders|trade_attribution|route2_poll_log)["']\)/.test(read(f)), f);
  }
});

Deno.test("reports: C rows are in no Baseline A cohort, and the dry-run attribution report reads bot 'smc' only", async () => {
  const { cohortOf, BASELINE_A } = await import("../../functions/_shared/baselineReport.ts");
  const c = { dry_run: true, config_version: BASELINE_A.configVersion, route: BASELINE_A.route, primary_engine: BASELINE_A.primaryEngine, decision_at: "2026-10-12T10:00:00Z" };
  assertEquals(cohortOf(c as any), "excluded");
  const rep = read("../../../local-runner/attribution-report.ts");
  assert(rep.includes(`.eq("fill_kind", "hypothetical").eq("bot_id", "smc")`));
});
