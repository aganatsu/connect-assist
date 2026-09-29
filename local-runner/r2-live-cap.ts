/**
 * §14 — apply the pre-registered caps retrospectively to the live pending
 * orders. Descriptive only. H1 ATR is computed causally from the corpus at
 * the placement instant, exactly as in the candidate harness.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadCorpus } from "./smc-corpus-fetch.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

const env: Record<string, string> = {};
for (const l of Deno.readTextFileSync(new URL("./.env.local", import.meta.url)).split("\n")) {
  const m = l.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const { data: po } = await db.from("pending_orders").select("*").eq("bot_id", "smc").order("placed_at");

const cache = new Map<string, Candle[]>();
const corpus = (s: string, tf: string) => {
  const k = `${s}|${tf}`;
  if (!cache.has(k)) { try { cache.set(k, loadCorpus(s, tf)); } catch { cache.set(k, []); } }
  return cache.get(k)!;
};
/** Wilder ATR(14) over the last 14 CLOSED H1 bars at tMs. */
function atrAt(sym: string, tMs: number): number | null {
  const h = corpus(sym, "1h");
  let last = -1;
  for (let i = 0; i < h.length; i++) {
    const nxt = i + 1 < h.length ? Date.parse(h[i + 1].datetime) : Infinity;
    if (nxt <= tMs) last = i; else break;
  }
  if (last < 14) return null;
  let sum = 0;
  for (let i = last - 13; i <= last; i++) {
    sum += Math.max(h[i].high - h[i].low,
      Math.abs(h[i].high - h[i - 1].close), Math.abs(h[i].low - h[i - 1].close));
  }
  return sum / 14;
}

const CAPS: Array<[string, number]> = [["1.5", 1.5], ["1.0", 1.0], ["0.5", 0.5]];
console.log("placed        sym      dir    distATR  touched  filled   1.5   1.0   0.5");
const tally: Record<string, { keep: number; rej: number }> = { "1.5": { keep: 0, rej: 0 }, "1.0": { keep: 0, rej: 0 }, "0.5": { keep: 0, rej: 0 } };
let measurable = 0;
for (const r of po || []) {
  const t0 = Date.parse(r.placed_at);
  const m1 = corpus(r.symbol, "1m");
  let px: number | null = null;
  for (let i = m1.length - 1; i >= 0; i--) {
    if (Date.parse(m1[i].datetime) <= t0) { px = m1[i].close; break; }
  }
  const covered = m1.length > 0 && Date.parse(m1[m1.length - 1].datetime) >= t0;
  const a = atrAt(r.symbol, t0);
  if (px === null || !covered || a === null || !(a > 0)) {
    console.log(`${String(r.placed_at).slice(5, 16)}  ${String(r.symbol).padEnd(8)} ${String(r.direction).padEnd(5)}  ${"UNUSABLE".padStart(8)}`);
    continue;
  }
  measurable++;
  const d = Math.abs(Number(r.entry_price) - px) / a;
  const cells = CAPS.map(([lab, cap]) => {
    const keep = d <= cap;
    tally[lab][keep ? "keep" : "rej"]++;
    return (keep ? "keep" : "rej").padStart(5);
  });
  console.log(`${String(r.placed_at).slice(5, 16)}  ${String(r.symbol).padEnd(8)} ${String(r.direction).padEnd(5)}  ` +
    `${d.toFixed(2).padStart(8)}  ${(r.zone_touch_time ? "Y" : "-").padStart(7)}  ${(r.status === "filled" ? "FILLED" : "-").padStart(6)}${cells.join("")}`);
}
console.log(`\nmeasurable live orders: ${measurable}`);
for (const [lab] of CAPS) console.log(`  cap ${lab} ATR -> retained ${tally[lab].keep}, rejected ${tally[lab].rej}`);
