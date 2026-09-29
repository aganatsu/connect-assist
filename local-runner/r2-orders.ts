/** Per-order detail for every live Route 2 pending order. Read-only. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: po } = await db.from("pending_orders").select("*").eq("bot_id", "smc").order("placed_at");
const rows = po || [];
console.log(`n=${rows.length}\n`);
console.log("placed_at        sym      dir   score  refZone touch att  status     lifetime_min  cancel/fill");
for (const r of rows) {
  const hasRef = Number(r.refined_zone_low || 0) > 0 && Number(r.refined_zone_high || 0) > 0;
  const end = r.resolved_at || r.filled_at;
  const life = end ? Math.round((Date.parse(end) - Date.parse(r.placed_at)) / 60000) : null;
  console.log(
    `${String(r.placed_at).slice(5, 16)}  ${String(r.symbol).padEnd(8)} ${String(r.direction).padEnd(5)} ` +
    `${String(Number(r.signal_score).toFixed(1)).padStart(5)}  ${hasRef ? "YES" : "no "}    ` +
    `${r.zone_touch_time ? "Y" : "-"}   ${String(r.confirmation_attempts ?? 0).padStart(2)}  ` +
    `${String(r.status).padEnd(10)} ${String(life ?? "-").padStart(8)}      ${String(r.fill_reason || r.cancel_reason || "").slice(0, 50)}`,
  );
}
const hasRef = rows.filter((r) => Number(r.refined_zone_low || 0) > 0 && Number(r.refined_zone_high || 0) > 0);
console.log(`\nrefined zone present: ${hasRef.length}/${rows.length}  -> Tier-1-only gate applies to ${rows.length - hasRef.length}`);
console.log(`expiry_minutes values: ${JSON.stringify([...new Set(rows.map((r) => r.expiry_minutes))])}`);
console.log(`symbols: ${JSON.stringify([...new Set(rows.map((r) => r.symbol))])}`);
console.log(`score range: ${Math.min(...rows.map((r) => Number(r.signal_score))).toFixed(1)} .. ${Math.max(...rows.map((r) => Number(r.signal_score))).toFixed(1)}`);

// Any durable hunt telemetry?
for (const k of ["entry_confirmation", "confirmation_method", "confirmation_build_diagnostic", "last_touch_checked_at", "last_confirmation_checked_at", "thesis_validation", "structural_invalidation"]) {
  const nn = rows.filter((r) => (r as Record<string, unknown>)[k] != null).length;
  console.log(`  column ${k}: ${nn}/${rows.length} non-null`);
}
