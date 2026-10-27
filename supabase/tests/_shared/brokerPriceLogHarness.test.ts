/**
 * Step 4c (broker vs bot price log) — EXECUTION tests on bot-scanner's real runScanForUser (management cycle; harness of
 * openPositionMarketHours.test.ts): a mirrored USD/JPY short whose stop the feed crosses, in live mode with one MT5 connection.
 *   1. MT5 still holds the trade → the existing close mirror runs exactly as before (positions read, POSITION_CLOSE_ID on MT5's id)
 *      and one close_mirrored row records MT5's price at that moment;
 *   2. MT5 already closed it → the mirror still skips the close; one broker_closed_first row records MT5's own close from its deals;
 *   3. paper mode → no MT5 call and no row at all.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CallRecord, FakeDb, type Row, withEnv, withFakeClock, withStubbedNetwork } from "./scannerHarness.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const fx = JSON.parse(read("./fixtures/baseline_a_config.json"));
const { runScanForUser } = await import("../../functions/bot-scanner/index.ts");

const U = "00000000-0000-0000-0000-0000000000de", C = "33333333-3333-4333-8333-333333333333";
const ENV = { TWELVE_DATA_API_KEY: "test-key", SUPABASE_URL: "http://fake.local", SUPABASE_SERVICE_ROLE_KEY: "test-service-key", POLYGON_API_KEY: undefined, SMC_SHADOW_ZONEMID: "off" };
const LEVEL: Record<string, number> = { "EUR/USD": 1.1, "USD/JPY": 158.3, "GBP/USD": 1.3, "CHF/JPY": 180, "NZD/CAD": 0.82, "NZD/CHF": 0.48 };
const priceOf = (s: string) => LEVEL[s.includes("/") ? s : `${s.slice(0, 3)}/${s.slice(3)}`] ?? 1;
const THROUGH_STOP = Array.from({ length: 300 }, () => ({ open: 158.6, high: 158.61, low: 158.59, close: 158.6 }));
const override = (sym: string, iv: string) => (sym === "USD/JPY" && iv === "15min" ? THROUGH_STOP : null);
const AT = Date.parse("2026-10-07T21:05:01Z"); // a Wednesday, inside the rollover window

const position = (): Row => ({
  id: "row-usdjpy", user_id: U, bot_id: "smc", position_id: "4324c6b3", order_id: "4324c6b3", symbol: "USD/JPY", direction: "short", position_status: "open",
  entry_price: "158.29325", stop_loss: "158.54711", take_profit: "158.02211", current_price: "158.32069", size: "3.11", signal_score: "60", close_reason: null,
  partial_tp_fired: false, open_time: "2026-10-07T16:05:01.000Z", created_at: "2026-10-07T16:05:01.000Z", signal_reason: JSON.stringify({ exitFlags: {} }),
  entry_zone_timeframe: "IZ-OB", mirrored_connection_ids: [C],
});
const DEALS = [
  { entryType: "DEAL_ENTRY_IN", positionId: "5550001", price: 158.281, volume: 3.11, time: "2026-10-07T16:05:03Z", comment: "paper:4324c6b3" },
  { entryType: "DEAL_ENTRY_OUT", positionId: "5550001", price: 158.552, volume: 3.11, time: "2026-10-07T21:00:07Z", reason: "DEAL_REASON_SL", comment: "[sl 158.547]" },
];

interface Run { db: FakeDb; calls: CallRecord[]; broker: { url: string; body: string | null }[] }
async function run(mode: "live" | "paper", mt5Holds: boolean): Promise<Run> {
  const db = new FakeDb({
    bot_configs: [{ id: "cfg1", user_id: U, connection_id: null, config_json: fx.config_json, config_version: fx.config_version }],
    paper_accounts: [{ id: "acct1", ledger_epoch_id: "ep1", user_id: U, bot_id: "smc", balance: "100000", is_paused: false, entries_locked: false, execution_mode: mode, scan_count: 0, signal_count: 0, rejected_count: 0 }],
    user_settings: [{ user_id: U, preferences_json: { telegramChatIds: [] } }],
    paper_positions: [position()],
    broker_connections: [{ id: C, user_id: U, broker_type: "metaapi", is_active: true, display_name: "demo", account_id: "acc-0001", api_key: "tok-0001", symbol_overrides: null }],
  });
  db.rpcHandlers.set("settle_paper_position", (a: any) => {
    db.tables.set("paper_positions", db.rows("paper_positions").filter((r) => r.id !== a.p_position_row_id));
    return { settled: true, amount: Number(a.p_history?.pnl ?? 0), history_id: "h", ledger_id: "l", balance: 100000 };
  });
  const broker: Run["broker"] = [];
  const respond = (url: string, init?: RequestInit) => {
    broker.push({ url: url.replace(/^https:\/\/mt-client-api-v1\.[a-z-]+\.agiliumtrade\.ai\/users\/current\/accounts\/acc-0001/, ""), body: (init?.body as string) ?? null });
    if (url.endsWith("/positions")) return new Response(JSON.stringify(mt5Holds ? [{ id: "5550001", comment: "paper:4324c6b3", openPrice: 158.281, currentPrice: 158.561 }] : []));
    if (url.endsWith("/trade")) return new Response(JSON.stringify({ stringCode: "TRADE_RETCODE_DONE" }));
    if (url.includes("/history-deals/")) return new Response(JSON.stringify(DEALS));
    return null;
  };
  const calls: CallRecord[] = [];
  await withEnv(ENV, () => withFakeClock(AT, () =>
    withStubbedNetwork(db, calls, AT, priceOf, () => runScanForUser(db.client(), U, { isManagementOnly: true }), override, respond)));
  return { db, calls, broker };
}

await run("paper", true); // warm the provider stub's module cache

Deno.test("MT5 still holds it: the close mirror is unchanged (positions → POSITION_CLOSE_ID on MT5's id) and close_mirrored records MT5's price", async () => {
  const r = await run("live", true);
  assertEquals(r.db.rows("paper_positions").length, 0, "the paper position settled at its stop");
  assertEquals(r.broker.map((b) => b.url), ["/positions", "/trade"]);
  assertEquals(JSON.parse(r.broker[1].body!), { actionType: "POSITION_CLOSE_ID", positionId: "5550001" });
  const rows = r.db.rows("broker_price_log");
  assertEquals(rows.length, 1);
  const x = rows[0];
  assertEquals([x.event, x.position_id, x.connection_id, x.entry_zone_type, x.bot_close_reason, x.bot_price, x.broker_price, x.broker_position_id, x.rollover_window],
    ["close_mirrored", "4324c6b3", C, "IZ-OB", "sl_hit", 158.54711, 158.561, "5550001", true]);
  assertEquals(x.slippage_pips, 1.39, "closing a short buys: MT5 1.39 pips higher = worse");
});

Deno.test("MT5 closed it first: no close is sent (as before); broker_closed_first records MT5's own close, time and reason from its deals", async () => {
  const r = await run("live", false);
  assertEquals(r.db.rows("paper_positions").length, 0);
  assertEquals(r.broker.map((b) => b.url.replace(/time\/.*$/, "time/…")), ["/positions", "/history-deals/time/…"]);
  assert(r.broker[1].url.startsWith("/history-deals/time/2026-10-07T15:55:01.000Z/"), r.broker[1].url);
  const x = r.db.rows("broker_price_log")[0];
  assertEquals([x.event, x.broker_price, x.broker_open_price, x.broker_time, x.broker_reason, x.rollover_window, x.broker_position_id],
    ["broker_closed_first", 158.552, 158.281, "2026-10-07T21:00:07Z", "DEAL_REASON_SL", true, "5550001"]);
});

Deno.test("paper mode: no MT5 call and nothing recorded", async () => {
  const r = await run("paper", true);
  assertEquals(r.db.rows("paper_positions").length, 0);
  assertEquals(r.broker.length, 0);
  assertEquals(r.db.rows("broker_price_log").length, 0);
  assertEquals(r.db.writes.filter((w) => w.table === "broker_price_log").length, 0);
});
