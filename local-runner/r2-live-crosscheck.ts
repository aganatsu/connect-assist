/**
 * §10 live 35-order reachability cross-check and §12 order-origin attribution.
 * Read-only. No replay of confirmation.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadCorpus } from "./smc-corpus-fetch.ts";

const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const UNIVERSE = ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF", "BTC/USD", "ETH/USD"];

// ── what did production actually scan, per day (from scan details) ──
const logs: any[] = [];
let from = 0;
for (;;) {
  const { data } = await db.from("scan_logs").select("created_at, details_json")
    .order("created_at", { ascending: true }).range(from, from + 199);
  logs.push(...(data || []));
  if (!data || data.length < 200) break;
  from += 200;
}
const scannedByDay = new Map<string, Set<string>>();
for (const r of logs) {
  const d = String(r.created_at).slice(0, 10);
  const arr = Array.isArray(r.details_json) ? r.details_json : (r.details_json?.details ?? []);
  if (!Array.isArray(arr)) continue;
  for (const x of arr) {
    const s = x?.pair ?? x?.symbol;
    if (typeof s === "string" && s.includes("/")) {
      if (!scannedByDay.has(d)) scannedByDay.set(d, new Set());
      scannedByDay.get(d)!.add(s);
    }
  }
}
const firstLogDay = [...scannedByDay.keys()].sort()[0];

const { data: po } = await db.from("pending_orders").select("*").eq("bot_id", "smc").order("placed_at");
const cache = new Map<string, ReturnType<typeof loadCorpus>>();
const m1 = (s: string) => {
  if (!cache.has(s)) { try { cache.set(s, loadCorpus(s, "1m")); } catch { cache.set(s, []); } }
  return cache.get(s)!;
};

console.log("═══ §10 LIVE 35-ORDER CROSS-CHECK ═══");
console.log("placed        sym      dir   lifeMin  mktTouchMin  recordedTouchMin  classification");
const tally: Record<string, number> = {};
const origin: Record<string, number> = {};
const originRows: string[] = [];
for (const r of po || []) {
  const t0 = Date.parse(r.placed_at);
  const end = Date.parse(r.resolved_at || r.filled_at || r.expires_at);
  const lifeMin = Math.round((end - t0) / 60000);
  const entry = Number(r.entry_price);
  const long = r.direction === "long";
  const bars = m1(r.symbol);
  const win = bars.filter((b) => { const t = Date.parse(b.datetime); return t >= t0 && t <= end; });
  const density = lifeMin > 0 ? win.length / lifeMin : 0;

  const recorded = r.zone_touch_time ? Math.round((Date.parse(r.zone_touch_time) - t0) / 60000) : null;
  let mkt: number | null = null;
  for (const b of win) {
    if (long ? b.low <= entry : b.high >= entry) { mkt = Math.round((Date.parse(b.datetime) - t0) / 60000); break; }
  }
  let cls: string;
  if (density < 0.5) cls = "UNUSABLE";
  else if (mkt !== null && recorded !== null) cls = "MATCH";
  else if (mkt !== null && recorded === null) cls = "MISSED_TOUCH";
  else if (mkt === null && recorded !== null) cls = "RECORDED_TOUCH_WITHOUT_MARKET_TOUCH";
  else cls = "MATCH";
  tally[cls] = (tally[cls] || 0) + 1;
  console.log(
    `${String(r.placed_at).slice(5, 16)}  ${String(r.symbol).padEnd(8)} ${String(r.direction).padEnd(5)} ` +
    `${String(lifeMin).padStart(7)} ${String(mkt ?? "-").padStart(12)} ${String(recorded ?? "-").padStart(17)}  ${cls}`);

  // ── §12 origin ──
  const day = String(r.placed_at).slice(0, 10);
  const scanned = scannedByDay.get(day);
  let o: string;
  if (day >= "2026-09-28") o = UNIVERSE.includes(r.symbol) ? "CURRENT_CONFIG_VALID" : "OUTSIDE_CURRENT_UNIVERSE";
  else if (!scanned) o = "UNKNOWN_ORIGIN";
  else if (scanned.has(r.symbol)) o = "LEGACY_CONFIG";
  else o = "OUTSIDE_CURRENT_UNIVERSE";
  origin[o] = (origin[o] || 0) + 1;
  originRows.push(`${String(r.placed_at).slice(5, 16)}  ${String(r.symbol).padEnd(8)} ${UNIVERSE.includes(r.symbol) ? "in-universe " : "OUT-of-univ "} scanned-that-day=${scanned ? (scanned.has(r.symbol) ? "yes" : "NO") : "no-logs"}  ${o}`);
}
console.log("\n" + JSON.stringify(tally));

console.log("\n═══ §12 ORDER ORIGIN ═══");
console.log(`(single creation site: bot-scanner:7588. scan_logs begin ${firstLogDay}; config row updated 2026-09-28.)`);
for (const l of originRows) console.log(l);
console.log("\n" + JSON.stringify(origin));
