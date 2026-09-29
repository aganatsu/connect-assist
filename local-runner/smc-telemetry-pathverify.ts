/** Synthetic Route 1 trade pushed through the REAL tables, then removed. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildEntryTelemetry, entryConfigSnapshot, entryDecisionSnapshot, carryToHistory, IMMUTABLE_COLUMNS }
  from "../supabase/functions/_shared/smcTradeTelemetry.ts";
const env = Deno.readTextFileSync(new URL("./.env.local", import.meta.url));
const g=(k:string)=>env.split("\n").find(l=>l.startsWith(k+"="))!.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g,"");
const db = createClient(g("SUPABASE_URL"), g("SUPABASE_SERVICE_ROLE_KEY"));
const PID = "TELEMVERIFY1";
const UID = "00000000-0000-0000-0000-0000000000ff";

const tel = buildEntryTelemetry({
  route: "route1_market", direction: "long",
  entryPrice: 1.1000, entryStopLoss: 1.0980, entryTakeProfit: 1.1040,
  entryTime: "2026-09-28T13:37:00.000Z", strategyBarTime: "2026-09-28T13:35:00.000Z",
  pipSize: 0.0001, tradingStyle: "scalper", zoneTimeframe: "1H",
  configSnapshot: entryConfigSnapshot({ tpRatio: 2.0, minConfluence: 40, marketFillAtZone: true, maxHoldHours: 4 }),
  decisionSnapshot: entryDecisionSnapshot({ zoneScore: 5.5, confluenceScore: 41.7, displacementCandles: 3, priceAtZoneStrict: true }),
});

// 1. ENTRY -> open position, exactly the shape bot-scanner now inserts
const ins = await db.from("paper_positions").insert({
  user_id: UID, position_id: PID, symbol: "EUR/USD", direction: "long",
  size: "0.10", entry_price: "1.1000", current_price: "1.1000",
  stop_loss: "1.0980", take_profit: "1.1040",
  open_time: "2026-09-28T13:37:00.000Z", position_status: "open", bot_id: "smc",
  order_id: PID, signal_score: "41.7", ...tel,
});
if (ins.error) { console.log("INSERT FAILED:", ins.error.message); Deno.exit(1); }
console.log("1. entry insert          OK");

// 2. MANAGEMENT moves the live stop (breakeven), entry record must not move
await db.from("paper_positions").update({ stop_loss: "1.1000" }).eq("position_id", PID);
const { data: mid } = await db.from("paper_positions").select("*").eq("position_id", PID).single();
console.log(`2. after BE: stop_loss=${mid!.stop_loss} entry_stop_loss=${mid!.entry_stop_loss} ` +
  `-> immutable ${Number(mid!.entry_stop_loss) === 1.098 ? "OK" : "VIOLATED"}`);

// 3. CLOSE -> archive, using the production carryToHistory
const hist = carryToHistory(mid as unknown as Record<string, unknown>, { exitPrice: 1.1040, direction: "long", costR: null });
const h = await db.from("paper_trade_history").insert({
  user_id: UID, position_id: PID, order_id: PID, symbol: "EUR/USD", direction: "long",
  size: "0.10", entry_price: "1.1000", exit_price: "1.1040",
  open_time: "2026-09-28T13:37:00.000Z", closed_at: "2026-09-28T15:10:00.000Z",
  close_reason: "tp_hit", pnl: "40.00", pnl_pips: "40.0", bot_id: "smc",
  stop_loss: "1.1000", take_profit: "1.1040", ...hist,
});
if (h.error) { console.log("HISTORY INSERT FAILED:", h.error.message); }
else console.log("3. archive insert        OK");
await db.from("paper_positions").delete().eq("position_id", PID);

// 4. VERIFY every immutable column survived, and R is right
const { data: row } = await db.from("paper_trade_history").select("*").eq("position_id", PID).single();
let bad = 0;
for (const c of IMMUTABLE_COLUMNS) {
  const want = (tel as unknown as Record<string, unknown>)[c]; const got = (row as unknown as Record<string, unknown>)[c];
  // Compare SEMANTICALLY: timestamptz round-trips as +00:00 not .000Z, jsonb
  // does not preserve key order, and numerics come back as strings.
  let same: boolean;
  if (want === null || want === undefined) same = got === null || got === undefined;
  else if (typeof want === "number") same = Math.abs(Number(got) - want) < 1e-9;
  else if (c.endsWith("_time") || c.endsWith("_bar_time")) same = Date.parse(String(got)) === Date.parse(String(want));
  else if (typeof want === "object") {
    const a = want as Record<string, unknown>, b = (got ?? {}) as Record<string, unknown>;
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    same = JSON.stringify(ka) === JSON.stringify(kb) && ka.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
  } else same = String(got) === String(want);
  if (!same) { console.log(`   MISMATCH ${c}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`); bad++; }
}
console.log(`4. immutable columns     ${bad === 0 ? "ALL 14 SURVIVED" : bad + " MISMATCHED"}`);
console.log(`   entry_route=${row!.entry_route}  realized_r_gross=${row!.realized_r_gross}  realized_r_net=${row!.realized_r_net}`);
console.log(`   stop_loss(at close)=${row!.stop_loss}  entry_stop_loss=${row!.entry_stop_loss}`);
console.log(`   R from entry stop = ${Number(row!.realized_r_gross)} (expect 2); ` +
  `naive R from stop_loss would be ${((1.1040-1.1000)/Math.abs(1.1000-Number(row!.stop_loss))).toFixed(1)}`);

// 5. CLEANUP
await db.from("paper_trade_history").delete().eq("position_id", PID);
const { data: left } = await db.from("paper_trade_history").select("id").eq("position_id", PID);
console.log(`5. cleanup               ${(left ?? []).length === 0 ? "OK (synthetic row removed)" : "LEFTOVER"}`);
