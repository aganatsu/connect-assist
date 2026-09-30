/** Observed production cadence + scheduler state. Read-only. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const st = await db.from("scheduled_tasks").select("*");
console.log("scheduled_tasks err=", st.error?.message ?? "none", "n=", (st.data || []).length);
for (const r of st.data || []) console.log("  ", JSON.stringify(r).slice(0, 220));

const sl = await db.from("scan_logs").select("created_at").order("created_at", { ascending: false }).limit(300);
const ts = (sl.data || []).map((r) => Date.parse(r.created_at)).sort((a, b) => b - a);
const gaps: number[] = [];
for (let i = 1; i < ts.length; i++) gaps.push(Math.round((ts[i - 1] - ts[i]) / 60000));
gaps.sort((a, b) => a - b);
console.log(`scan_logs n=${ts.length} gap-min p10=${gaps[Math.floor(gaps.length * 0.1)]} median=${gaps[Math.floor(gaps.length / 2)]} p90=${gaps[Math.floor(gaps.length * 0.9)]}`);
console.log("latest scan:", ts.length ? new Date(ts[0]).toISOString() : "none");

// gamePlanGateMode + FOTSI switches in the live config
const cfg = await db.from("bot_configs").select("config_json");
const flat = JSON.stringify((cfg.data || [])[0]?.config_json ?? {});
for (const k of ["gamePlanGateMode", "fotsiEnabled", "thesisValidationEnabled", "thesisDirectionStyleAware", "newsFilterEnabled"]) {
  const m = flat.match(new RegExp(`"${k}":([^,}]*)`));
  console.log(`  ${k}: ${m ? m[1] : "(absent -> default)"}`);
}
