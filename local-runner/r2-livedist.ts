/**
 * Live check: how far from market were the 35 pending orders placed?
 *
 * `limitOrderMaxDistancePips` (default 30) lives inside computeLimitEntryPrice
 * (bot-scanner:3345-3348), which returns null when limitOrderEnabled is false
 * and is only reached when `zoneEngineWillOverride` is false. Under the live
 * hard gate with a bestZone, neither holds — so the cap should never bind.
 * If production orders exceed 30 pips, that is confirmed empirically.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadCorpus } from "./smc-corpus-fetch.ts";

const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: po } = await db.from("pending_orders").select("*").eq("bot_id", "smc").order("placed_at");

const PIP: Record<string, number> = {
  "EUR/USD": 1e-4, "GBP/USD": 1e-4, "USD/JPY": 1e-2, "CHF/JPY": 1e-2,
  "NZD/CAD": 1e-4, "NZD/CHF": 1e-4, "BTC/USD": 1, "ETH/USD": 1e-2,
  "AUD/USD": 1e-4, "NZD/USD": 1e-4, "USD/CHF": 1e-4, "EUR/GBP": 1e-4, "USD/CAD": 1e-4,
};
const cache = new Map<string, ReturnType<typeof loadCorpus>>();
const m1 = (s: string) => {
  if (!cache.has(s)) { try { cache.set(s, loadCorpus(s, "1m")); } catch { cache.set(s, []); } }
  return cache.get(s)!;
};

console.log("placed        sym      dir    entry       mktAtPlace   distPips   >30?");
const d30: number[] = [];
for (const r of po || []) {
  const bars = m1(r.symbol);
  const t0 = Date.parse(r.placed_at);
  // last 1m close at or before placement — the price production saw
  let px: number | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    if (Date.parse(bars[i].datetime) <= t0) { px = bars[i].close; break; }
  }
  if (px === null || !bars.length || Date.parse(bars[bars.length - 1].datetime) < t0) {
    console.log(`${String(r.placed_at).slice(5,16)}  ${String(r.symbol).padEnd(8)} ${String(r.direction).padEnd(5)}  ${String(r.entry_price).padEnd(11)} ${"NO_DATA".padStart(11)}`);
    continue;
  }
  const pip = PIP[r.symbol] ?? 1e-4;
  const dist = Math.abs(Number(r.entry_price) - px) / pip;
  d30.push(dist);
  console.log(`${String(r.placed_at).slice(5,16)}  ${String(r.symbol).padEnd(8)} ${String(r.direction).padEnd(5)}  ` +
    `${String(Number(r.entry_price).toFixed(5)).padEnd(11)} ${px.toFixed(5).padStart(11)} ${dist.toFixed(1).padStart(10)}   ${dist > 30 ? "YES" : "-"}`);
}
d30.sort((a, b) => a - b);
console.log(`\nmeasurable=${d30.length}  median=${d30[Math.floor(d30.length/2)]?.toFixed(1)} pips  ` +
  `exceeding the nominal 30-pip cap: ${d30.filter((x) => x > 30).length}/${d30.length}`);
