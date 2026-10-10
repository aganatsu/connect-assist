/**
 * Open FX positions while the FX market is closed. EXECUTION tests: bot-scanner's
 * real runScanForUser (management cycle), in-memory tables, stubbed provider,
 * fixed clocks around the close (EDT: Fri 21:00 UTC → Sun 21:00 UTC).
 *
 * Invariant: while FX is shut no open FX position is refreshed, moved or closed
 * off provider quotes. Production evidence: position 4324c6b3 (USD/JPY short,
 * opened 23:51 UTC Friday 2026-10-09) had current_price rewritten every minute
 * from weekend quotes; a quote through its stop would have settled it.
 */
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CallRecord, FakeDb, normalise, type Row, withEnv, withFakeClock, withStubbedNetwork } from "./scannerHarness.ts";
import { isFxClosedAt } from "../../functions/_shared/sessions.ts";

const read = (rel: string) => Deno.readTextFileSync(new URL(rel, import.meta.url));
const fx = JSON.parse(read("./fixtures/baseline_a_config.json"));
const { runScanForUser } = await import("../../functions/bot-scanner/index.ts");

const U = "00000000-0000-0000-0000-0000000000dd";
const ENV = { TWELVE_DATA_API_KEY: "test-key", SUPABASE_URL: "http://fake.local", SUPABASE_SERVICE_ROLE_KEY: "test-service-key", POLYGON_API_KEY: undefined, SMC_SHADOW_ZONEMID: "off" };
const LEVEL: Record<string, number> = { "EUR/USD": 1.1, "USD/JPY": 158.3, "GBP/USD": 1.3, "CHF/JPY": 180, "NZD/CAD": 0.82, "NZD/CHF": 0.48, "ETH/USD": 2500 };
const priceOf = (s: string) => LEVEL[s.includes("/") ? s : `${s.slice(0, 3)}/${s.slice(3)}`] ?? 1;
// The weekend quote that crosses 4324c6b3's stop (158.54711): flat bars at 158.60.
const THROUGH_STOP = Array.from({ length: 300 }, () => ({ open: 158.6, high: 158.61, low: 158.59, close: 158.6 }));
const override = (sym: string, iv: string) => (sym === "USD/JPY" && iv === "15min" ? THROUGH_STOP : null);

const OPEN_FRI = Date.parse("2026-10-09T20:51:01Z");
const CLOSED_FRI = Date.parse("2026-10-09T23:51:01Z");
const SATURDAY = Date.parse("2026-10-10T12:00:01Z");
const SUN_BEFORE = Date.parse("2026-10-11T20:59:01Z");
const SUN_AFTER = Date.parse("2026-10-11T21:01:01Z");
const WEDNESDAY = Date.parse("2026-10-07T10:12:01Z");

const pos = (o: Row, base: number): Row => ({
  user_id: U, bot_id: "smc", position_status: "open", size: "1", signal_score: "60", close_reason: null, partial_tp_fired: false,
  open_time: new Date(base - 5 * 3600e3).toISOString(), created_at: new Date(base - 5 * 3600e3).toISOString(),
  signal_reason: JSON.stringify({ exitFlags: {} }), ...o,
});
/** 4324c6b3 as it stands: USD/JPY short, all management off, a weekend-refreshed price. */
const usdjpy = (base: number) => pos({ id: "row-usdjpy", position_id: "4324c6b3", order_id: "4324c6b3", symbol: "USD/JPY", direction: "short",
  entry_price: "158.29325", stop_loss: "158.54711", take_profit: "158.02211", current_price: "158.32069", size: "3.11" }, base);
/** One FX position per management feature, each enabled alone through trade_overrides and in profit at the synthetic price. */
const managed = (base: number): Row[] => [
  pos({ id: "row-be", position_id: "pBE", symbol: "EUR/USD", direction: "long", entry_price: "1.0950", stop_loss: "1.0920", take_profit: "1.2000", current_price: "1.0950",
    trade_overrides: { breakEvenEnabled: true, breakEvenPips: 15, breakEvenOffsetPips: 2 } }, base),
  pos({ id: "row-trail", position_id: "pTR", symbol: "GBP/USD", direction: "long", entry_price: "1.2950", stop_loss: "1.2920", take_profit: "1.4000", current_price: "1.2950",
    trade_overrides: { trailingStopEnabled: true, trailingStopPips: 10, trailingStopActivation: "after_1r" } }, base),
  pos({ id: "row-partial", position_id: "pPT", symbol: "NZD/CAD", direction: "long", entry_price: "0.8170", stop_loss: "0.8140", take_profit: "0.9000", current_price: "0.8170",
    trade_overrides: { partialTPEnabled: true, partialTPPercent: 50, partialTPLevel: 1.0 } }, base),
  pos({ id: "row-maxhold", position_id: "pMH", symbol: "CHF/JPY", direction: "long", entry_price: "179.70", stop_loss: "179.40", take_profit: "190.00", current_price: "179.70",
    trade_overrides: { maxHoldEnabled: true, maxHoldHours: 1, breakEvenEnabled: true, breakEvenOffsetPips: 2 } }, base),
  pos({ id: "row-session", position_id: "pSE", symbol: "NZD/CHF", direction: "long", entry_price: "0.47950", stop_loss: "0.47800", take_profit: "0.52000", current_price: "0.47950",
    trade_overrides: { breakEvenEnabled: true, breakEvenPips: 500, breakEvenOffsetPips: 2 } }, base),
];
const eth = (base: number) => pos({ id: "row-eth", position_id: "pETH", symbol: "ETH/USD", direction: "long", entry_price: "2600", stop_loss: "2550", take_profit: "3000", current_price: "2600" }, base);

interface Run { db: FakeDb; calls: CallRecord[]; res: any; settled: string[] }
async function run(at: number, positions: Row[], opts: { config?: any; extra?: Record<string, Row[]> } = {}): Promise<Run> {
  const db = new FakeDb({
    bot_configs: [{ id: "cfg1", user_id: U, connection_id: null, config_json: opts.config ?? fx.config_json, config_version: fx.config_version }],
    paper_accounts: [{ id: "acct1", ledger_epoch_id: "ep1", user_id: U, bot_id: "smc", balance: "100000", is_paused: false, entries_locked: false, execution_mode: "paper", scan_count: 0, signal_count: 0, rejected_count: 0 }],
    user_settings: [{ user_id: U, preferences_json: { telegramChatIds: ["111"] } }],
    paper_positions: positions,
    ...(opts.extra ?? {}),
  });
  const settled: string[] = [];
  const settle = (a: any) => {
    settled.push(a.p_position_row_id);
    db.tables.set("paper_positions", db.rows("paper_positions").filter((r) => r.id !== a.p_position_row_id));
    return { settled: true, amount: Number(a.p_history?.pnl ?? 0), history_id: "h", ledger_id: "l", balance: 100000 };
  };
  db.rpcHandlers.set("settle_paper_position", settle);
  db.rpcHandlers.set("settle_paper_partial", (a: any) => ({ settled: true, amount: 0, history_id: "h", ledger_id: "l", balance: 100000, _row: a.p_position_row_id }));
  const calls: CallRecord[] = [];
  const res = await withEnv(ENV, () => withFakeClock(at, () =>
    withStubbedNetwork(db, calls, at, priceOf, () => runScanForUser(db.client(), U, { isManagementOnly: true }), override)));
  return { db, calls, res, settled };
}
const posWrites = (r: Run, rowId?: string) => r.db.writes.filter((w) => w.table === "paper_positions" && (!rowId || w.filters.includes(`id=eq.${rowId}`)));
const posRpcs = (r: Run) => r.db.rpcs.filter((x) => /settle_paper|claim/.test(x.name));
const fxPositionFetches = (r: Run) => r.calls.filter((c) => c.kind === "provider" && /interval=15min/.test(c.url) && !/ETH%2FUSD|BTC%2FUSD/.test(c.url));

await run(OPEN_FRI, [usdjpy(OPEN_FRI)]); // warm the provider stub's module cache

Deno.test("regression 4324c6b3: a quote through the stop settles it while open; after the close the patched code holds", async () => {
  const open = await run(OPEN_FRI, [usdjpy(OPEN_FRI)]);
  assertFalse(isFxClosedAt(OPEN_FRI));
  assertEquals(open.settled, ["row-usdjpy"], "open market: breach check settles at the stop");
  assertEquals((posRpcs(open)[0].args as any).p_history.close_reason, "sl_hit");
  for (const at of [CLOSED_FRI, SATURDAY, SUN_BEFORE]) {
    assert(isFxClosedAt(at));
    const r = await run(at, [usdjpy(at)]);
    const when = new Date(at).toISOString();
    assertEquals(r.settled, [], `${when}: no settlement`);
    assertEquals(posWrites(r).length, 0, `${when}: no write to the position (current_price frozen)`);
    assertEquals(fxPositionFetches(r).map((c) => c.url), [], `${when}: no 15m quote fetched for it`);
    assertEquals(r.db.rows("paper_positions")[0].current_price, "158.32069", "the stored price is untouched");
    // the scanner's own fetch log (management telemetry): the refresh call site never ran, cached or not
    const tele = r.db.writes.find((w) => w.table === "kv_cache" && String((w.payload as any)?.key ?? "").startsWith("smc_mgmt_telemetry"));
    const recent = JSON.parse(String((tele?.payload as any)?.value ?? "{}")).recent ?? [];
    assert(tele && recent.length > 0, "telemetry written");
    assertFalse("open_position_price_refresh" in (recent.at(-1)?.byReason ?? {}), JSON.stringify(recent.at(-1)?.byReason));
  }
});

Deno.test("reopen: the first Sunday-open cycle refreshes and, gapped through the stop, settles with the existing semantics", async () => {
  const r = await run(SUN_AFTER, [usdjpy(SUN_AFTER)]);
  assertFalse(isFxClosedAt(SUN_AFTER));
  assertEquals(r.settled, ["row-usdjpy"]);
  const h = (posRpcs(r)[0].args as any).p_history;
  assertEquals([h.close_reason, h.exit_price], ["sl_hit", "158.54711"], "settled AT the stop — no slippage/gap logic added");
  assert(posWrites(r, "row-usdjpy").some((w) => (w.payload as any).current_price === "158.6"), "price refreshed first");
});

Deno.test("management features: break-even, trailing, partial, max-hold and session-close act while open, never while closed", async () => {
  const open = await run(OPEN_FRI, managed(OPEN_FRI));
  const acts = (r: Run) => (r.res.managementActions ?? []).filter((a: any) => a.action !== "no_change").map((a: any) => `${a.positionId}:${a.action}`).sort();
  const openActs = acts(open);
  for (const id of ["pBE", "pTR", "pPT", "pMH", "pSE"]) assert(openActs.some((a: string) => a.startsWith(id + ":")), `open control: ${id} acts (${openActs})`);
  for (const at of [CLOSED_FRI, SATURDAY]) {
    const r = await run(at, managed(at));
    assertEquals(acts(r), [], new Date(at).toISOString());
    assertEquals(posWrites(r).length, 0, "no SL / flag / price write");
    assertEquals(posRpcs(r).length, 0, "no partial or full settlement");
    assertEquals(r.calls.filter((c) => c.kind === "telegram").length, 0);
    assertEquals(fxPositionFetches(r).length, 0);
  }
});

Deno.test("structure invalidation (config on): no candle read and no stop move for FX positions while closed", async () => {
  const cfg = structuredClone(fx.config_json);
  cfg.exit.structureInvalidationEnabled = true;
  const underwater = (base: number) => [pos({ id: "row-si", position_id: "pSI", symbol: "EUR/USD", direction: "long", entry_price: "1.1010", stop_loss: "1.0950", take_profit: "1.2000", current_price: "1.1010" }, base)];
  const r = await run(SATURDAY, underwater(SATURDAY), { config: cfg });
  assertEquals(posWrites(r).length, 0);
  assertEquals(r.calls.filter((c) => c.kind === "provider" && /EUR%2FUSD/.test(c.url) && /interval=(5min|15min|1h)/.test(c.url)).length, 0);
});

Deno.test("Step 13 keeps running on the last stored equity; a flatten never closes an FX position while closed (and still does while open)", async () => {
  const profile = { id: "pf1", user_id: U, bot_id: "smc", is_active: true, equity_source: "paper", close_on_breach: true, initial_balance: 100000,
    max_daily_loss_pct: 0.05, max_overall_loss_pct: 0.1, daily_entry_stop_pct: 0.03, daily_flatten_pct: 0.04,
    overall_entry_stop_equity: 95000, overall_flatten_equity: 91000, day_boundary_tz: "Europe/Prague" };
  const ledger = [{ id: "L1", account_id: "acct1", epoch_id: "ep1", seq: 1, kind: "reset", balance_after: 100000, created_at: "2026-10-01T00:00:00Z" }];
  // 50 lots long EUR/USD from 1.2000, stored at 1.1000 (the synthetic price): equity ≈ -$400k → flatten.
  const big = (base: number) => [pos({ id: "row-big", position_id: "pBIG", symbol: "EUR/USD", direction: "long", entry_price: "1.2000", stop_loss: "0.9000", take_profit: "1.5000", current_price: "1.1000", size: "50" }, base)];
  const extra = { prop_firm_config: [profile], paper_account_ledger: ledger };
  const open = await run(OPEN_FRI, big(OPEN_FRI), { extra });
  assertEquals(open.settled, ["row-big"], "open: Step 13 flatten closes it");
  assertEquals((posRpcs(open)[0].args as any).p_source, "prop_firm_emergency");
  const sat = await run(SATURDAY, big(SATURDAY), { extra });
  assertEquals(sat.settled, [], "closed: not closed");
  assertEquals(posWrites(sat).length, 0, "and not repriced");
  const body = sat.res instanceof Response ? await sat.res.clone().json() : sat.res;
  assertEquals([body.mode, body.positions_closed], ["prop_firm_emergency", 0], "the gate evaluated the stored equity, flagged the breach, closed nothing")
});

Deno.test("crypto is unchanged on Saturday: refreshed, managed, and settled on a breach", async () => {
  const r = await run(SATURDAY, [eth(SATURDAY)]);
  assert(r.calls.some((c) => c.kind === "provider" && /ETH%2FUSD/.test(c.url) && /interval=15min/.test(c.url)), "ETH quote fetched");
  assertEquals(r.settled, ["row-eth"], "synthetic 2500 is through the 2550 stop: settled");
});

Deno.test("pins: one rule (isFxClosedAt) gates refresh, management, breach and the emergency close; manual close and kill switch untouched", () => {
  const s = read("../../functions/bot-scanner/index.ts");
  assert(s.includes("const fxMarketClosed = isFxClosedAt(now.getTime());"));
  assertFalse(/const fxMarketClosed = \(nyDay/.test(s), "the inline definition is gone");
  assert(s.includes(`const refreshablePositions = fxMarketClosed\n    ? openPosArr.filter((p: any) => SPECS[p.symbol]?.type === "crypto")\n    : openPosArr;`));
  assert(s.includes("const positionsToManage = fxMarketClosed ? cryptoPositions : openPosArr;"));
  assert(s.includes(`!(fxMarketClosed && SPECS[p.symbol]?.type !== "crypto")`));
  assert(s.includes("          fxMarketClosed,\n"), "Step 13 emergency close receives the same flag (its existing FX deferral)");
  const p = read("../../functions/paper-trading/index.ts");
  assert(p.includes(`return INSTRUMENT_SPECS[symbol]?.type !== "crypto" && isFxClosedAt(nowMs);`));
  assert(p.includes("const positions = (allPositions ?? []).filter((p: any) => !fxPriceFrozen(p.symbol));"), "updatePositionPrices");
  assert(p.includes(".filter((s) => !fxPriceFrozen(s as string)) as string[];"), "dashboard status poll");
  const engine = p.slice(p.indexOf("for (const pos of (positions || [])) {", p.indexOf("payload.processEngine === true && positions")));
  assert(engine.startsWith("for (const pos of (positions || [])) {\n          // FX closed: no engine step") && engine.slice(0, 200).includes("if (fxPriceFrozen(pos.symbol)) continue;"), "engine loop skips first");
  for (const action of [`if (action === "close_position") {`, `if (action === "kill_switch") {`]) {
    const at = p.indexOf(action);
    const body = p.slice(at, p.indexOf("\n    if (action === ", at + 10));
    assertFalse(body.includes("fxPriceFrozen"), `${action} is unchanged`);
  }
  assert(p.includes("if (import.meta.main) Deno.serve(async (req) => {"));
});

// ── paper-trading: the price writer shared by the engine path ───────────────
const pt = await import("../../functions/paper-trading/index.ts");

Deno.test("paper-trading fxPriceFrozen: FX closed and not crypto — the same rule", () => {
  assert(pt.fxPriceFrozen("USD/JPY", SATURDAY));
  assert(pt.fxPriceFrozen("EUR/USD", CLOSED_FRI));
  assertFalse(pt.fxPriceFrozen("ETH/USD", SATURDAY));
  assertFalse(pt.fxPriceFrozen("USD/JPY", OPEN_FRI));
  assertFalse(pt.fxPriceFrozen("USD/JPY", SUN_AFTER));
  assert(pt.fxPriceFrozen("USD/JPY", SUN_BEFORE));
});

Deno.test("paper-trading updatePositionPrices (engine path): no FX quote fetched or written while closed; crypto and open market unchanged", async () => {
  const runPrices = async (at: number) => {
    const db = new FakeDb({ paper_positions: [usdjpy(at), eth(at)] });
    const urls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((u: string) => { urls.push(String(u).replace(/apikey=[^&]+/, "")); return Promise.resolve(new Response(JSON.stringify({ price: String.prototype.includes.call(u, "ETH") ? "2610" : "158.61" }))); }) as typeof fetch;
    try {
      await withEnv({ TWELVE_DATA_API_KEY: "k" }, () => withFakeClock(at, () => pt.updatePositionPrices(db.client(), db.rows("paper_positions"))));
    } finally { globalThis.fetch = real; }
    return { urls, writes: db.writes.map((w) => `${w.filters.find((f) => f.startsWith("id="))}:${(w.payload as any).current_price}`) };
  };
  const sat = await runPrices(SATURDAY + 600_000); // past the price cache of any earlier call
  assertFalse(sat.urls.some((u) => u.includes("USD%2FJPY") || u.includes("USD/JPY")), sat.urls.join(","));
  assertEquals(sat.writes, ["id=eq.row-eth:2610"]);
  const wed = await runPrices(WEDNESDAY);
  assertEquals(wed.writes.sort(), ["id=eq.row-eth:2610", "id=eq.row-usdjpy:158.61"]);
});
