/**
 * Did price reach the pending entry level before the order died?
 *
 * Diagnostic only — no P&L. Answers whether Route 2 loses setups to
 * non-arrival (TTL too short) or to the confirmation hunt.
 *
 * Uses the frozen 1m corpus. Orders on symbols or dates outside corpus
 * coverage are reported as NO_DATA, never guessed.
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

const cache = new Map<string, ReturnType<typeof loadCorpus>>();
const m1 = (s: string) => {
  if (!cache.has(s)) { try { cache.set(s, loadCorpus(s, "1m")); } catch { cache.set(s, []); } }
  return cache.get(s)!;
};

let reached = 0, notReached = 0, noData = 0;
console.log("placed        sym      dir   status     lifeMin  reachedEntry?  firstTouchMin");
for (const r of po || []) {
  const bars = m1(r.symbol);
  const t0 = Date.parse(r.placed_at);
  const end = Date.parse(r.resolved_at || r.filled_at || r.expires_at);
  const entry = Number(r.entry_price);
  const long = r.direction === "long";
  const win = bars.filter((b) => { const t = Date.parse(b.datetime); return t >= t0 && t <= end; });
  const covered = bars.length > 0 &&
    Date.parse(bars[0].datetime) <= t0 && Date.parse(bars[bars.length - 1].datetime) >= end;
  let tag: string, first = "";
  if (!covered) { tag = "NO_DATA"; noData++; }
  else {
    const hit = win.find((b) => long ? b.low <= entry : b.high >= entry);
    if (hit) { tag = "REACHED"; reached++; first = String(Math.round((Date.parse(hit.datetime) - t0) / 60000)); }
    else { tag = "never"; notReached++; }
  }
  const life = Math.round((end - t0) / 60000);
  console.log(`${String(r.placed_at).slice(5, 16)}  ${String(r.symbol).padEnd(8)} ${String(r.direction).padEnd(5)} ` +
    `${String(r.status).padEnd(10)} ${String(life).padStart(6)}   ${tag.padEnd(9)}      ${first}`);
}
console.log(`\nREACHED=${reached}  never=${notReached}  NO_DATA=${noData}  (of ${(po || []).length})`);
