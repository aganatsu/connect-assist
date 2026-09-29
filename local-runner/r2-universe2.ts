/** §11 — per-day, per-symbol scan counts with day-of-week and weekend-crypto flag. */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const logs: any[] = [];
let from = 0;
for (;;) {
  const { data } = await db.from("scan_logs").select("created_at, details_json")
    .order("created_at", { ascending: true }).range(from, from + 199);
  logs.push(...(data || []));
  if (!data || data.length < 200) break;
  from += 200;
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const per = new Map<string, Map<string, number>>();
const wkc = new Map<string, number>();
for (const r of logs) {
  const d = String(r.created_at).slice(0, 10);
  const arr = Array.isArray(r.details_json) ? r.details_json : (r.details_json?.details ?? []);
  const meta = Array.isArray(r.details_json) ? r.details_json[0] : r.details_json;
  if (meta?.weekendCryptoMode === true) wkc.set(d, (wkc.get(d) || 0) + 1);
  if (!Array.isArray(arr)) continue;
  if (!per.has(d)) per.set(d, new Map());
  for (const x of arr) {
    const s = x?.pair ?? x?.symbol;
    if (typeof s === "string" && s.includes("/")) per.get(d)!.set(s, (per.get(d)!.get(s) || 0) + 1);
  }
}
const syms = [...new Set([...per.values()].flatMap((m) => [...m.keys()]))].sort();
console.log(`day         dow  wkndCrypto  ${syms.map((s) => s.padStart(9)).join("")}`);
for (const [d, m] of [...per.entries()].sort()) {
  const dow = DOW[new Date(d + "T12:00:00Z").getUTCDay()];
  console.log(`${d}  ${dow}  ${String(wkc.get(d) ?? 0).padStart(10)}  ` +
    syms.map((s) => String(m.get(s) ?? "·").padStart(9)).join(""));
}
