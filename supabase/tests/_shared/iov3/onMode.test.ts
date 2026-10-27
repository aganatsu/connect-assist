import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeDb } from "../scannerHarness.ts";
import { evaluateKill, isV3Order, legAsImpulse, onGate, planFromDecision, tradeR, V3_ENGINE_VERSION, v3ZoneType, type ShadowDecisionRow } from "../../../functions/_shared/iov3/onMode.ts";
import { enterOn, leaveOn } from "../../../functions/_shared/iov3/onSwitch.ts";
import { advance, initShadowState, type Bar, type ShadowParams, type V3Leg } from "../../../functions/_shared/iov3/shadowEngine.ts";
import { shadowRoute2Geometry } from "../../../functions/_shared/shadowZoneMid.ts";
import { computeV3State, V32C_ENGINE_VERSION } from "../../../functions/_shared/structure/v32cState.ts";
import { fxOpenNY } from "../../../functions/_shared/structure/canonicalBars.ts";

/** Impulse-on-V3 ON (step 4b): the gate, the plan from the shadow's decision, the flips, the automatic fallback. */

const H = 3_600_000, M5 = 300_000;
const P: ShadowParams = { pair: "EUR/USD", pip: 0.0001, costPips: 1.5, minSlPips: 20, slBufferPips: 1, legBufferPct: 0.02, legCapMultiple: 1.2, capMultiplier: 1.5,
  tpRatio: 1.5, distanceAtrMult: 1.5, ttlMs: 8 * H, fibMaxRetracement: 1, enabledSessions: null, enabledDays: null, voidOnGap: true };

Deno.test("ON gate: only switch ON + config owner v3 + an arm + scalper + styleOverridesMode off", () => {
  const raw = { structure: { owner: "v3" } };
  assertEquals(onGate({ mode: "ON", arm: "B" }, raw, "scalper", "off"), { on: true, arm: "B" });
  assertEquals(onGate({ mode: "SHADOW", arm: "B" }, raw, "scalper", "off").on, false);
  assertEquals(onGate({ mode: "ON", arm: "B" }, {}, "scalper", "off").on, false, "the config marker is required too");
  assertEquals(onGate({ mode: "ON", arm: null }, raw, "scalper", "off").on, false);
  assertEquals(onGate({ mode: "ON", arm: "A" }, raw, "day_trader", "off").on, false);
  assertEquals(onGate({ mode: "ON", arm: "A" }, raw, "scalper", "legacy").on, false);
  assertEquals(onGate(null, raw, "scalper", "off").on, false);
});

Deno.test("ON helpers: engine version pinned to the V3 engine; V3 order tagging; the leg in the impulse-broken shape", () => {
  assertEquals(V3_ENGINE_VERSION, V32C_ENGINE_VERSION);
  assertEquals(v3ZoneType("B", "fvg"), "V3B-FVG");
  assert(isV3Order({ entry_zone_type: "V3A-OB" }) && !isV3Order({ entry_zone_type: "IZ-OB" }) && !isV3Order({ entry_zone_type: null }));
  assertEquals(legAsImpulse("long", 1.10, 1.12), { high: 1.12, low: 1.10 });   // long breaks below the swing low (impulse.low)
  assertEquals(legAsImpulse("short", 1.12, 1.10), { high: 1.12, low: 1.10 });  // short breaks above the swing high (impulse.high)
});

// a real decision stream from the shadow engine on a swinging synthetic market
function decisions(): { d: ShadowDecisionRow; price: number }[] {
  const h1: Bar[] = [], m5: Bar[] = [];
  let s = 19, p = 1.1; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  for (let t = Date.parse("2025-05-04T21:00:00Z"), i = 0; h1.length < 720; t += H) {
    if (!fxOpenNY(t)) continue;
    const drift = Math.sin(i++ / 5) * 0.003, o = p; let hi = o, lo = o, q = o;
    for (let k = 0; k < 12; k++) { const a = q, b = q + drift / 12 + (rnd() - 0.5) * 0.0008, bh = Math.max(a, b) + rnd() * 0.0002, bl = Math.min(a, b) - rnd() * 0.0002;
      m5.push({ t: t + k * M5, o: +a.toFixed(5), h: +bh.toFixed(5), l: +bl.toFixed(5), c: +b.toFixed(5) }); hi = Math.max(hi, bh); lo = Math.min(lo, bl); q = b; }
    h1.push({ t, o: +o.toFixed(5), h: +hi.toFixed(5), l: +lo.toFixed(5), c: +q.toFixed(5) }); p = q;
  }
  const v3 = computeV3State("EUR/USD", h1);
  const map = new Map(v3.snapshots["1H"].map((x) => [Date.parse(x.known_at), { trend: x.trend, pTime: x.p_time ? Date.parse(x.p_time) : null, pPrice: x.p_price, xTime: x.x_time ? Date.parse(x.x_time) : null, xPrice: x.x_price } as V3Leg]));
  const r = advance(initShadowState(h1[310].t + H), { h1, m5, v3At: (T) => map.get(T), ctx4hAt: () => null, params: P, until: h1.at(-1)!.t + H });
  return r.decisions.filter((x) => x.order).map((x) => ({
    price: x.price!,
    d: { t: new Date(x.t).toISOString(), dir: x.dir, reason: x.reason, price: x.price,
      leg: { trend: x.leg?.trend ?? null, swing_time: null, swing_price: x.leg!.pPrice, extreme_time: null, extreme_price: x.leg!.xPrice },
      zone: x.zone, order_plan: x.order } as ShadowDecisionRow,
  }));
}

Deno.test("plan: for every order the shadow placed, the live Route 2 geometry rebuilt from the decision reproduces its stop and target", () => {
  const ds = decisions();
  assert(ds.length >= 5, `${ds.length} shadow orders`);
  for (const { d, price } of ds) {
    const plan = planFromDecision(d, P, Date.parse(d.t) + 40 * 60_000);
    assert(plan.ok, JSON.stringify(plan));
    const geo = shadowRoute2Geometry({
      direction: plan.dir, limit: plan.entry, lastPrice: price, h1Atr: 1, marketSL: plan.planSL, tpRatio: P.tpRatio, stopAnchor: "limit",
      swingSL: null, impulseSL: plan.impulseSL, impulseCapPips: plan.impulseCapPips, minSlPips: plan.minSlPips, pipSize: P.pip, symbol: "EUR/USD",
      rateMap: {}, commissionPerLot: 0, orderRRMin: 1, rrGateMode: "order_geometry", sizingMode: "fill_time", balance: 100_000, riskPercent: 0.5,
      maxLotsPerTrade: 20, legacyLots: () => 1, halveLegacy: false,
    });
    assert(geo.ok, JSON.stringify(geo));
    assertEquals([+geo.stop.toFixed(8), +geo.target.toFixed(8)], [+plan.planSL.toFixed(8), +plan.planTP.toFixed(8)], d.t);
  }
});

Deno.test("plan: stale, missing, refused or order-less decisions place nothing", () => {
  const { d } = decisions()[0];
  const t = Date.parse(d.t);
  assertEquals(planFromDecision(d, P, t + 3 * H).ok, false, "older than 2 hours");
  assertEquals(planFromDecision(null, P, t).ok, false);
  assertEquals(planFromDecision(d, { reason: "style" }, t).ok, false);
  assertEquals(planFromDecision({ ...d, order_plan: null, reason: "price_beyond_zone" }, P, t).ok, false);
});

Deno.test("fallback: R uses the stop at placement; −8R cumulative or the first 20 averaging below −0.3R trips it", () => {
  const tr = (r: number, i: number) => ({ entry: 1.1, exit: 1.1 + r * 0.002, stopAtPlacement: 1.098, direction: "long" as const, closedAt: `2026-11-0${1 + (i % 9)}T${String(i % 24).padStart(2, "0")}:00:00Z` });
  assertEquals(+tradeR(tr(1.5, 0)).toFixed(6), 1.5);
  assertEquals(evaluateKill([tr(-1, 0), tr(1.5, 1)]).kill, false);
  const eight = Array.from({ length: 8 }, (_, i) => tr(-1, i));
  assert(evaluateKill(eight).kill && evaluateKill(eight).reason!.includes("≤ -8R"));
  const mild = Array.from({ length: 20 }, (_, i) => tr(i % 4 === 0 ? 1.5 : -0.9, i)); // 5×1.5 − 15×0.9 = −6 → avg −0.3 exactly: not below
  assertEquals(evaluateKill(mild).kill, false);
  const worse = Array.from({ length: 20 }, (_, i) => tr(i % 4 === 0 ? 1.2 : -0.9, i)); // 5×1.2 − 13.5 = −7.5 → avg −0.375
  assert(evaluateKill(worse).kill && evaluateKill(worse).reason!.includes("first 20"));
});

const U = "00000000-0000-0000-0000-0000000000aa";
function flipDb() {
  const po = (order_id: string, symbol: string, zone: string, status = "pending") => ({ user_id: U, bot_id: "smc", order_id, symbol, entry_zone_type: zone, status });
  return new FakeDb({
    structure_mode: [{ user_id: U, bot_id: "smc", mode: "SHADOW", set_at: "2026-10-27T00:00:00Z" }],
    bot_configs: [{ id: "c1", user_id: U, connection_id: null, config_json: { risk: { x: 1 } } }],
    pending_orders: [po("imp1", "EUR/USD", "IZ-OB"), po("imp2", "GBP/USD", "IZ-FVG", "awaiting_confirmation"), po("v3a1", "NZD/CHF", "V3A-FVG"),
      po("xau1", "XAU/USD", "IZ-OB"), po("done", "EUR/USD", "IZ-OB", "filled")],
    paper_positions: [{ user_id: U, position_id: "p1", symbol: "EUR/USD", position_status: "open" }],
  });
}

Deno.test("flip: entering ON cancels only the live Impulse orders on V3 pairs, marks the config, sets arm + on_since; positions untouched", async () => {
  const db = flipDb();
  const r = await enterOn(db.client(), U, "smc", "SHADOW", "B", "2026-11-03T10:00:00.000Z");
  assertEquals(r.cancelledOrders, 2);
  const st = Object.fromEntries(db.rows("pending_orders").map((o) => [o.order_id, o.status]));
  assertEquals(st, { imp1: "cancelled", imp2: "cancelled", v3a1: "pending", xau1: "pending", done: "filled" });
  assertEquals(db.rows("pending_orders").find((o) => o.order_id === "imp1")!.terminal_reason, "CANCELLED_SUPERSEDED");
  assertEquals(db.rows("bot_configs")[0].config_json, { risk: { x: 1 }, structure: { owner: "v3", arm: "B" } });
  assertEquals([db.rows("structure_mode")[0].mode, db.rows("structure_mode")[0].arm, db.rows("structure_mode")[0].on_since], ["ON", "B", "2026-11-03T10:00:00.000Z"]);
  assertEquals(db.rows("paper_positions")[0].position_status, "open");
  assertEquals(db.rows("structure_mode_log").map((l) => `${l.from_mode}→${l.to_mode}`), ["SHADOW→ON"]);
});

Deno.test("flip: leaving ON (fallback) cancels only V3 orders, removes the config marker, records the reason", async () => {
  const db = flipDb();
  await enterOn(db.client(), U, "smc", "SHADOW", "A", "2026-11-03T10:00:00.000Z");
  const r = await leaveOn(db.client(), U, "smc", "SHADOW", "2026-11-05T10:00:00.000Z", "ON net −8.10R ≤ −8R");
  assertEquals(r.cancelledOrders, 1);
  assertEquals(db.rows("pending_orders").find((o) => o.order_id === "v3a1")!.status, "cancelled");
  assertEquals(db.rows("pending_orders").find((o) => o.order_id === "xau1")!.status, "pending");
  assertEquals(db.rows("bot_configs")[0].config_json, { risk: { x: 1 } });
  assertEquals([db.rows("structure_mode")[0].mode, db.rows("structure_mode")[0].kill_reason], ["SHADOW", "ON net −8.10R ≤ −8R"]);
});
