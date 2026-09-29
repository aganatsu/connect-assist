/** §11/§12 — which symbols did production actually scan, and when? Read-only. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const UNIVERSE = ["EUR/USD", "GBP/USD", "USD/JPY", "CHF/JPY", "NZD/CAD", "NZD/CHF", "BTC/USD", "ETH/USD"];

// 1. symbols appearing in scan details, by day
const rows: any[] = [];
let from = 0;
for (;;) {
  const { data, error } = await db.from("scan_logs").select("created_at, pairs_scanned, details_json")
    .order("created_at", { ascending: true }).range(from, from + 199);
  if (error) { console.log("scan_logs ERR", error.message); break; }
  rows.push(...(data || []));
  if (!data || data.length < 200) break;
  from += 200;
}
console.log(`scan_logs rows=${rows.length} range=${rows[0]?.created_at?.slice(0,10)} .. ${rows[rows.length-1]?.created_at?.slice(0,10)}`);

const byDay = new Map<string, Set<string>>();
for (const r of rows) {
  const d = String(r.created_at).slice(0, 10);
  const det = r.details_json;
  const arr = Array.isArray(det) ? det : (det?.details ?? []);
  if (!Array.isArray(arr)) continue;
  for (const x of arr) {
    const sym = x?.pair ?? x?.symbol;
    if (typeof sym === "string" && sym.includes("/")) {
      if (!byDay.has(d)) byDay.set(d, new Set());
      byDay.get(d)!.add(sym);
    }
  }
}
console.log("\nday        nSym  symbols scanned (★ = outside the 8-instrument universe)");
for (const [d, s] of [...byDay.entries()].sort()) {
  const list = [...s].sort().map((x) => UNIVERSE.includes(x) ? x : `★${x}`);
  console.log(`${d}  ${String(s.size).padStart(4)}  ${list.join(" ")}`);
}

// 2. is there any config history?
for (const t of ["config_presets", "bot_configs"]) {
  const { data, error } = await db.from(t).select("*").limit(10);
  console.log(`\n${t}: ${error ? "ERR " + error.message : (data || []).length + " rows"}`);
  for (const r of data || []) {
    const j: any = r.config_json ?? r.preset_json ?? r.config ?? {};
    const en = j?.instruments?.enabled;
    console.log(`  id=${String(r.id).slice(0,8)} name=${r.name ?? "-"} conn=${String(r.connection_id).slice(0,8)} created=${String(r.created_at).slice(0,10)} updated=${String(r.updated_at).slice(0,10)} enabled=${JSON.stringify(en)}`);
  }
}
