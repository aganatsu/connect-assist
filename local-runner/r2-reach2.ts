/** Same as r2-reach, but proves the 1m window is actually populated. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadCorpus } from "./smc-corpus-fetch.ts";

const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: po } = await db.from("pending_orders").select("*").eq("bot_id", "smc").order("placed_at");

const cache = new Map<string, ReturnType<typeof loadCorpus>>();
const m1 = (s: string) => {
  if (!cache.has(s)) { try { cache.set(s, loadCorpus(s, "1m")); } catch { cache.set(s, []); } }
  return cache.get(s)!;
};

console.log("placed        sym      dir   status      lifeMin barsInWin  density  nearestApproachPips  verdict");
let real = 0, sparse = 0;
for (const r of po || []) {
  const bars = m1(r.symbol);
  if (!bars.length) { console.log(`${String(r.placed_at).slice(5, 16)}  ${String(r.symbol).padEnd(8)} -- NO CORPUS FILE`); continue; }
  const t0 = Date.parse(r.placed_at);
  const end = Date.parse(r.resolved_at || r.filled_at || r.expires_at);
  const entry = Number(r.entry_price);
  const long = r.direction === "long";
  const win = bars.filter((b) => { const t = Date.parse(b.datetime); return t >= t0 && t <= end; });
  const lifeMin = Math.round((end - t0) / 60000);
  const density = lifeMin > 0 ? win.length / lifeMin : 0;
  // distance to entry in price units, converted with a crude pip size
  const pip = r.symbol.includes("JPY") ? 0.01 : (/BTC|ETH/.test(r.symbol) ? 1 : 0.0001);
  let nearest = Infinity;
  for (const b of win) { const d = long ? b.low - entry : entry - b.high; if (d < nearest) nearest = d; }
  const hit = win.some((b) => long ? b.low <= entry : b.high >= entry);
  const trustworthy = density >= 0.5;
  if (trustworthy) real++; else sparse++;
  console.log(
    `${String(r.placed_at).slice(5, 16)}  ${String(r.symbol).padEnd(8)} ${String(r.direction).padEnd(5)} ` +
    `${String(r.status).padEnd(10)} ${String(lifeMin).padStart(6)} ${String(win.length).padStart(8)}   ` +
    `${density.toFixed(2).padStart(6)}  ${(Number.isFinite(nearest) ? (nearest / pip).toFixed(1) : "n/a").padStart(18)}  ` +
    `${!trustworthy ? "SPARSE_NO_VERDICT" : hit ? "REACHED" : "never"}`,
  );
}
console.log(`\ntrustworthy windows (density>=0.5): ${real}   sparse/unusable: ${sparse}`);
