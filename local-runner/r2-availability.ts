/** How often is candle data actually unavailable to the pending loop? Read-only. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

for (const t of ["api_credit_usage", "scan_history"]) {
  const r = await db.from(t).select("*", { count: "exact", head: true });
  console.log(`${t}: ${r.error ? "ERR " + r.error.message : r.count + " rows"}`);
}
const cu = await db.from("api_credit_usage").select("*").order("created_at", { ascending: false }).limit(5);
if (!cu.error) for (const r of cu.data || []) console.log("  ", JSON.stringify(r).slice(0, 260));

// scan_logs: pairs_scanned distribution — a starved cycle scans fewer pairs
const sl = await db.from("scan_logs").select("created_at, pairs_scanned, signals_found, trades_placed")
  .order("created_at", { ascending: false }).limit(500);
const ps: Record<string, number> = {};
for (const r of sl.data || []) ps[String(r.pairs_scanned)] = (ps[String(r.pairs_scanned)] || 0) + 1;
console.log("\nscan_logs pairs_scanned distribution (last 500):", JSON.stringify(ps));
const sig = (sl.data || []).reduce((a, r) => a + (r.signals_found || 0), 0);
const tp = (sl.data || []).reduce((a, r) => a + (r.trades_placed || 0), 0);
console.log(`  signals_found total=${sig}  trades_placed total=${tp}`);
console.log(`  window: ${(sl.data || []).slice(-1)[0]?.created_at} .. ${(sl.data || [])[0]?.created_at}`);
