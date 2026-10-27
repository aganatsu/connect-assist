import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeDb } from "./scannerHarness.ts";
import {
  brokerCloseFromDeals, inRolloverWindow, type MetaCall, parseTradeReply, recordBrokerClose, recordBrokerOpen, recordBrokerOpenSkipped, slippagePips,
} from "../../functions/_shared/brokerPriceLog.ts";

/** Step 4c: broker vs bot price log — the pure rules, the recorders, and that nothing here can throw into the mirror. */

const U = "00000000-0000-0000-0000-0000000000ee", C = "11111111-1111-4111-8111-111111111111";
const base = { userId: U, botId: "smc", positionId: "fc088d69", connectionId: C, symbol: "USD/JPY", direction: "short" as const, entryZoneType: "V3A-OB" };

/** A fake MetaApi: answers by path suffix, records every path. */
function fakeMeta(routes: Record<string, unknown>, status = 200): { meta: MetaCall; paths: string[] } {
  const paths: string[] = [];
  const meta: MetaCall = (path) => {
    const p = path("https://mt/acc");
    paths.push(p);
    const key = Object.keys(routes).find((k) => p.includes(k));
    if (!key) return Promise.resolve({ res: new Response("{}", { status: 404 }), body: "{}" });
    const body = JSON.stringify(routes[key]);
    return Promise.resolve({ res: new Response(body, { status }), body });
  };
  return { meta, paths };
}

Deno.test("slippage: positive = MT5 got the worse price for us, in pips of the pair", () => {
  assertEquals(slippagePips("open", "long", 1.1000, 1.1002, "EUR/USD"), 2);     // bought higher
  assertEquals(slippagePips("open", "short", 1.1000, 1.1002, "EUR/USD"), -2);   // sold higher: better
  assertEquals(slippagePips("close", "long", 1.1000, 1.0997, "EUR/USD"), 3);    // closing a long sells: received less
  assertEquals(slippagePips("close", "short", 157.83, 157.86, "USD/JPY"), 3);   // closing a short buys: paid more
  assertEquals(slippagePips("open", "long", 1.1, null, "EUR/USD"), null);
});

Deno.test("rollover window: 20:50 ≤ t < 21:30 UTC; unknown time = null", () => {
  assertEquals(inRolloverWindow("2026-10-27T20:49:59Z"), false);
  assertEquals(inRolloverWindow("2026-10-27T20:50:00Z"), true);
  assertEquals(inRolloverWindow("2026-10-27T21:29:59Z"), true);
  assertEquals(inRolloverWindow("2026-10-27T21:30:00Z"), false);
  assertEquals(inRolloverWindow(null), null);
  assertEquals(inRolloverWindow("not a time"), null);
});

Deno.test("trade reply: broker position id on success; the MT5 code on refusal; HTTP status when not JSON", () => {
  assertEquals(parseTradeReply(true, 200, JSON.stringify({ stringCode: "TRADE_RETCODE_DONE", orderId: "46870472", positionId: "46870472" })),
    { opened: true, brokerPositionId: "46870472", code: "TRADE_RETCODE_DONE" });
  assertEquals(parseTradeReply(true, 200, JSON.stringify({ stringCode: "TRADE_RETCODE_NO_MONEY" })), { opened: false, code: "TRADE_RETCODE_NO_MONEY" });
  assertEquals(parseTradeReply(false, 504, "gateway timeout"), { opened: false, code: "HTTP 504" });
});

const DEALS = [
  { id: "1", entryType: "DEAL_ENTRY_IN", positionId: "777", price: 157.60, volume: 1, time: "2026-10-27T18:00:01Z", comment: "paper:fc088d69" },
  { id: "2", entryType: "DEAL_ENTRY_IN", positionId: "888", price: 1.1, volume: 1, time: "2026-10-27T18:05:00Z", comment: "paper:other001" },
  { id: "3", entryType: "DEAL_ENTRY_OUT", positionId: "777", price: 157.90, volume: 0.5, time: "2026-10-27T21:01:00Z", reason: "DEAL_REASON_SL", comment: "[sl 157.9]" },
  { id: "4", entryType: "DEAL_ENTRY_OUT", positionId: "777", price: 157.92, volume: 0.5, time: "2026-10-27T21:01:02Z", reason: "DEAL_REASON_SL", comment: "[sl 157.9]" },
  { id: "5", entryType: "DEAL_ENTRY_OUT", positionId: "888", price: 1.2, volume: 1, time: "2026-10-27T21:02:00Z", reason: "DEAL_REASON_TP" },
];

Deno.test("deals: MT5's close for OUR position (by comment, or by the known broker id), volume-weighted over parts", () => {
  const c = brokerCloseFromDeals(DEALS, "fc088d69", null)!;
  assertEquals([c.brokerPositionId, c.openPrice, +c.closePrice!.toFixed(5), c.closeTime, c.reason], ["777", 157.6, 157.91, "2026-10-27T21:01:02Z", "DEAL_REASON_SL"]);
  assertEquals(brokerCloseFromDeals(DEALS, "ignored", "777")!.brokerPositionId, "777");
  assertEquals(brokerCloseFromDeals(DEALS, "nomatch1", null), null);
  assertEquals(brokerCloseFromDeals({ error: "x" }, "fc088d69", null), null);
});

Deno.test("open: records MT5's open price next to the bot's fill (one read of the opened position); refusals and skips are recorded too", async () => {
  const db = new FakeDb({});
  const { meta, paths } = fakeMeta({ "/positions/46870472": { id: "46870472", openPrice: 157.583, time: "2026-10-27T18:00:01Z" } });
  await recordBrokerOpen(db.client(), meta, { ...base, botPrice: 157.5571, ok: true, status: 200, reply: JSON.stringify({ stringCode: "TRADE_RETCODE_DONE", positionId: "46870472" }),
    spread: { bid: 157.58, ask: 157.595, spreadPips: 1.5 } });
  assertEquals(paths, ["https://mt/acc/positions/46870472"]);
  // a short that MT5 sold 2.59 pips HIGHER than the bot: better for us, so negative
  const r = db.rows("broker_price_log")[0];
  assertEquals([r.event, r.bot_price, r.broker_price, r.broker_position_id, r.slippage_pips, r.rollover_window, r.entry_zone_type], ["open", 157.5571, 157.583, "46870472", -2.59, false, "V3A-OB"]);

  await recordBrokerOpen(db.client(), meta, { ...base, positionId: "p2", botPrice: 1, ok: false, status: 400, reply: JSON.stringify({ stringCode: "TRADE_RETCODE_MARKET_CLOSED" }) });
  await recordBrokerOpenSkipped(db.client(), { ...base, positionId: "p3", botPrice: 1, reason: "spread", detail: { spreadPips: 4.2, maxPips: 3 } });
  assertEquals(db.rows("broker_price_log").slice(1).map((x) => [x.event, (x.detail as any).code ?? (x.detail as any).reason]), [["open_failed", "TRADE_RETCODE_MARKET_CLOSED"], ["open_skipped", "spread"]]);
});

Deno.test("close: MT5 still holds it → its price at the bot's close; MT5 closed first → its own close from the deal history", async () => {
  const db = new FakeDb({});
  const { meta, paths } = fakeMeta({ "/history-deals/": DEALS });
  await recordBrokerClose(db.client(), meta, { ...base, botExitPrice: 157.8789, botCloseReason: "sl_hit", openTime: "2026-10-27T18:00:00Z", nowIso: "2026-10-27T22:15:00.000Z",
    brokerPos: { id: 777, currentPrice: 157.884, openPrice: 157.6 } });
  assertEquals(paths, [], "MT5 still holds it: no extra call");
  let r = db.rows("broker_price_log")[0];
  assertEquals([r.event, r.broker_price, r.broker_position_id, r.slippage_pips, r.bot_close_reason], ["close_mirrored", 157.884, "777", 0.51, "sl_hit"]);

  await recordBrokerClose(db.client(), meta, { ...base, positionId: "fc088d69", connectionId: "22222222-2222-4222-8222-222222222222", botExitPrice: 157.8789,
    botCloseReason: "sl_hit", openTime: "2026-10-27T18:00:00Z", nowIso: "2026-10-27T22:15:00.000Z", brokerPos: null });
  assertEquals(paths, ["https://mt/acc/history-deals/time/2026-10-27T17:50:00.000Z/2026-10-27T22:15:00.000Z"], "no broker id logged: search by time from 10 min before the open");
  r = db.rows("broker_price_log")[1];
  assertEquals([r.event, +Number(r.broker_price).toFixed(5), r.broker_time, r.broker_reason, r.rollover_window, r.broker_position_id], ["broker_closed_first", 157.91, "2026-10-27T21:01:02Z", "DEAL_REASON_SL", true, "777"]);
});

Deno.test("close, MT5 closed first, broker id known from the open record → read that position's deals directly", async () => {
  const db = new FakeDb({ broker_price_log: [{ position_id: "fc088d69", connection_id: C, event: "open", broker_position_id: "777" }] });
  const { meta, paths } = fakeMeta({ "/history-deals/position/777": DEALS.filter((d) => d.positionId === "777") });
  await recordBrokerClose(db.client(), meta, { ...base, botExitPrice: 157.8789, botCloseReason: "sl_hit", openTime: null, nowIso: "2026-10-27T22:15:00.000Z", brokerPos: null });
  assertEquals(paths, ["https://mt/acc/history-deals/position/777"]);
  assertEquals(db.rows("broker_price_log").at(-1)!.event, "broker_closed_first");
});

Deno.test("never throws: a failing database, a failing or garbage MetaApi — the mirror carries on; a lookup failure still records the event", async () => {
  const boom = { from: () => { throw new Error("db down"); } };
  const bad: MetaCall = () => Promise.reject(new Error("network"));
  await recordBrokerOpen(boom, bad, { ...base, botPrice: 1, ok: true, status: 200, reply: JSON.stringify({ positionId: "1" }) });
  await recordBrokerOpenSkipped(boom, { ...base, botPrice: 1, reason: "spread" });
  await recordBrokerClose(boom, bad, { ...base, botExitPrice: 1, botCloseReason: "tp_hit", openTime: null, nowIso: "2026-10-27T22:15:00.000Z", brokerPos: null });
  const db = new FakeDb({});
  await recordBrokerClose(db.client(), bad, { ...base, botExitPrice: 1, botCloseReason: "tp_hit", openTime: null, nowIso: "2026-10-27T22:15:00.000Z", brokerPos: null });
  const r = db.rows("broker_price_log")[0];
  assertEquals([r.event, r.broker_price, (r.detail as any).lookup], ["broker_closed_first", null, "error: network"]);
  await recordBrokerOpen(db.client(), bad, { ...base, positionId: "p9", botPrice: 1, ok: true, status: 200, reply: "not json" });
  assert(db.rows("broker_price_log").some((x) => x.position_id === "p9" && x.event === "open" && x.broker_price === null), "opened, price unknown");
});
