import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env: Record<string,string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g,"");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

console.log("=== LIVE CONFIG (route-determining flags) ===");
const { data: cfgs } = await db.from("bot_configs").select("connection_id, config_json, updated_at");
for (const c of cfgs||[]) {
  const j: any = c.config_json || {};
  const e = j.entry || {}; const s = j.strategy || {};
  const pick = (k:string)=> e[k] ?? s[k] ?? j[k];
  console.log(` conn=${String(c.connection_id).slice(0,8)} upd=${String(c.updated_at).slice(0,10)}`,
    JSON.stringify({ marketFillAtZone: pick("marketFillAtZone"), limitOrderEnabled: pick("limitOrderEnabled"),
      impulseZoneGateMode: pick("impulseZoneGateMode") ?? j.impulseZoneGateMode,
      minConfluence: pick("minConfluence"), tradingStyle: j.tradingStyle?.mode,
      instruments: (j.instruments||pick("instruments")||[]).length }));
}
console.log("\n=== paper_positions / history by order_type + entry_route ===");
for (const t of ["paper_positions","paper_trade_history"]) {
  const { data } = await db.from(t).select("order_type, entry_route, symbol, open_time, signal_reason").eq("bot_id","smc").limit(2000);
  const m: Record<string,number> = {};
  for (const r of data||[]) {
    let cf = false;
    try { const sr = typeof r.signal_reason==="string"?JSON.parse(r.signal_reason):r.signal_reason; cf = !!sr?.confirmationEntry; } catch {}
    const k = `order_type=${r.order_type} entry_route=${r.entry_route} confirmationEntry=${cf}`;
    m[k]=(m[k]||0)+1;
  }
  console.log(` ${t}: n=${(data||[]).length}`);
  for (const [k,v] of Object.entries(m).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
}
console.log("\n=== scan_logs confirmationHunt telemetry availability ===");
const { data: sl } = await db.from("scan_logs").select("created_at, details_json").order("created_at",{ascending:false}).limit(400);
let withHunt=0, huntRows=0; const outcomes: Record<string,number> = {};
for (const r of sl||[]) { const d:any = r.details_json||{}; const h = d.confirmationHunt;
  if (Array.isArray(h)) { withHunt++; huntRows+=h.length; for (const x of h) outcomes[x.outcome]=(outcomes[x.outcome]||0)+1; } }
console.log(` scan_logs sampled=${(sl||[]).length} withConfirmationHuntKey=${withHunt} huntEvents=${huntRows}`);
console.log(" outcomes:", JSON.stringify(outcomes));
const { data: tc } = await db.from("scan_logs").select("details_json").order("created_at",{ascending:false}).limit(400);
let touchEv=0; for (const r of tc||[]) { const h:any=(r.details_json as any)?.touchChecks; if (Array.isArray(h)) touchEv+=h.length; }
console.log(` touchCheck events in same sample: ${touchEv}`);
