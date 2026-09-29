/** ROUTE2 funnel from live pending_orders. Read-only. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env: Record<string,string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g,"");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

async function all(table: string, sel: string, f: (q:any)=>any) {
  const out: any[] = []; let from = 0;
  for (;;) { const { data, error } = await f(db.from(table).select(sel)).range(from, from+999);
    if (error) throw new Error(error.message); out.push(...(data||[]));
    if (!data || data.length < 1000) break; from += 1000; }
  return out;
}
const po = await all("pending_orders", "*", (q)=>q.eq("bot_id","smc").order("placed_at"));
console.log(`pending_orders (bot=smc): ${po.length}`);
console.log(`date range: ${po[0]?.placed_at} .. ${po[po.length-1]?.placed_at}`);
const by = (k: string) => { const m: Record<string,number> = {}; for (const r of po) m[String(r[k])] = (m[String(r[k])]||0)+1; return m; };
console.log("\nSTATUS:", JSON.stringify(by("status"), null, 0));
console.log("touched (zone_touch_time non-null):", po.filter(r=>r.zone_touch_time).length);
console.log("ever awaiting_confirmation (attempts>0 or status=aw):", po.filter(r=>(r.confirmation_attempts||0)>0 || r.status==="awaiting_confirmation").length);
console.log("filled:", po.filter(r=>r.status==="filled").length);
const filled = po.filter(r=>r.status==="filled");
console.log("\n--- FILLED rows: fill_reason prefix x month ---");
for (const r of filled) console.log(` ${r.placed_at?.slice(0,10)} ${r.symbol} ${r.direction} filled_at=${r.filled_at?.slice(0,16)} reason=${String(r.fill_reason).slice(0,70)}`);
console.log("\n--- cancel_reason buckets ---");
const cb: Record<string,number> = {};
for (const r of po) { if (!r.cancel_reason) continue;
  const k = String(r.cancel_reason).replace(/[\d.,:\-]+/g,"#").slice(0,55); cb[k]=(cb[k]||0)+1; }
for (const [k,v] of Object.entries(cb).sort((a,b)=>b[1]-a[1]).slice(0,18)) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log("\n--- columns present ---");
console.log(Object.keys(po[0]||{}).join(", "));
