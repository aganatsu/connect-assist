import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env: Record<string,string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g,"");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const cnt = async (t:string, f?:(q:any)=>any) => { let q:any = db.from(t).select("*",{count:"exact",head:true}); if(f) q=f(q); const {count,error}=await q; return error?`ERR ${error.message}`:count; };
console.log("paper_trade_history total:", await cnt("paper_trade_history"));
console.log("  bot_id=smc       :", await cnt("paper_trade_history",q=>q.eq("bot_id","smc")));
const { data: bids } = await db.from("paper_trade_history").select("bot_id").limit(2000);
const bm: Record<string,number>={}; for(const r of bids||[]) bm[String(r.bot_id)]=(bm[String(r.bot_id)]||0)+1;
console.log("  bot_id distribution:", JSON.stringify(bm));
console.log("paper_positions total:", await cnt("paper_positions"));
const { data: pp } = await db.from("paper_positions").select("bot_id,position_status").limit(2000);
const pm: Record<string,number>={}; for(const r of pp||[]) pm[`${r.bot_id}/${r.position_status}`]=(pm[`${r.bot_id}/${r.position_status}`]||0)+1;
console.log("  :", JSON.stringify(pm));

console.log("\n=== raw config_json keys ===");
const { data: cfgs } = await db.from("bot_configs").select("connection_id, config_json, updated_at");
for (const c of cfgs||[]) {
  const j:any = c.config_json||{};
  console.log(` conn=${String(c.connection_id).slice(0,8)} topKeys=${Object.keys(j).join(",")}`);
  const flat = JSON.stringify(j);
  for (const k of ["marketFillAtZone","limitOrderEnabled","impulseZoneGateMode","minConfluence","minZoneScore","maxHoldEnabled","instruments"]) {
    const m = flat.match(new RegExp(`"${k}":(\\[[^\\]]*\\]|[^,}]*)`));
    console.log(`    ${k}: ${m?m[1].slice(0,120):"(absent -> DEFAULT)"}`);
  }
}
console.log("\n=== history route/exit labels (all bots) ===");
const { data: h } = await db.from("paper_trade_history").select("bot_id,exit_reason,entry_route,order_type,closed_at").limit(2000);
const em: Record<string,number>={}; for(const r of h||[]) em[`${r.bot_id}|${r.exit_reason}|route=${r.entry_route}|ot=${r.order_type}`]=(em[`${r.bot_id}|${r.exit_reason}|route=${r.entry_route}|ot=${r.order_type}`]||0)+1;
for (const [k,v] of Object.entries(em).sort((a,b)=>b[1]-a[1]).slice(0,15)) console.log(`  ${String(v).padStart(4)} ${k}`);
console.log(" closed_at range:", (h||[]).map(r=>r.closed_at).sort()[0], "..", (h||[]).map(r=>r.closed_at).sort().slice(-1)[0]);
