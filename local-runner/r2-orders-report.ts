/**
 * ORDER-LEVEL reachability.
 *
 * The per-scan candidate list over-counts: a zone re-detected every 5 minutes
 * is ONE production order, not twelve. bot-scanner:7514-7538 refreshes an
 * existing pending order in place when (symbol, direction, entry_price) is
 * unchanged, and that refresh EXTENDS expires_at. So:
 *
 *   order    = maximal run of same (symbol, direction, entryPrice) detections
 *              with no gap longer than the 60-minute TTL
 *   created  = first detection
 *   expires  = last detection + 60m   (rolling, not fixed from creation)
 *
 * Reachability is measured from the creation instant, so horizons mean the
 * same thing they do for a freshly placed order.
 */
import { HORIZONS_MIN, type R2Cand } from "./r2-candidates.ts";
import { PRODUCTION_UNIVERSE, isCrypto } from "./smc-corpus-fetch.ts";

const TTL_MIN = 60;

const all: R2Cand[] = [];
for (const s of PRODUCTION_UNIVERSE) {
  try {
    all.push(...JSON.parse(Deno.readTextFileSync(
      new URL(`./.cache/r2c_${s.replace("/", "")}.json`, import.meta.url))));
  } catch { /* reported by the generator */ }
}

interface Order {
  symbol: string; direction: string; entryPrice: number; zoneTF: string | null;
  createdMs: number; lastSeenMs: number; refreshes: number;
  distPips: number; distAtrH1: number | null;
  touchMin: number | null;          // from creation
  effectiveTtlMin: number;          // lastSeen + 60 - created
  windowComplete: boolean;
}

// group by key, then split runs on a gap > TTL
const byKey = new Map<string, R2Cand[]>();
for (const c of all) {
  const k = `${c.symbol}|${c.direction}|${c.entryPrice}`;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k)!.push(c);
}
const orders: Order[] = [];
for (const [, rows] of byKey) {
  rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  let run: R2Cand[] = [];
  const flush = () => {
    if (!run.length) return;
    const f = run[0], l = run[run.length - 1];
    orders.push({
      symbol: f.symbol, direction: f.direction, entryPrice: f.entryPrice, zoneTF: f.zoneTF,
      createdMs: Date.parse(f.t), lastSeenMs: Date.parse(l.t), refreshes: run.length - 1,
      distPips: f.distPips, distAtrH1: f.distAtrH1, touchMin: f.touchMin,
      effectiveTtlMin: Math.round((Date.parse(l.t) - Date.parse(f.t)) / 60000) + TTL_MIN,
      windowComplete: f.windowComplete,
    });
    run = [];
  };
  for (const c of rows) {
    if (run.length && (Date.parse(c.t) - Date.parse(run[run.length - 1].t)) / 60000 > TTL_MIN) flush();
    run.push(c);
  }
  flush();
}
const o = orders.filter((x) => x.windowComplete);
console.log(`scan-instant candidates=${all.length}  ->  DISTINCT ORDERS=${orders.length}  windowComplete=${o.length}`);
const q = (a: number[], p: number) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : NaN;
const f = (n: number, d = 1) => Number.isFinite(n) ? n.toFixed(d) : "-";
console.log(`refreshes per order: median=${f(q(o.map((x) => x.refreshes), 0.5), 0)} p90=${f(q(o.map((x) => x.refreshes), 0.9), 0)} max=${Math.max(...o.map((x) => x.refreshes))}`);
console.log(`effective TTL (min): median=${f(q(o.map((x) => x.effectiveTtlMin), 0.5), 0)} p75=${f(q(o.map((x) => x.effectiveTtlMin), 0.75), 0)} p90=${f(q(o.map((x) => x.effectiveTtlMin), 0.9), 0)}`);

function curve(rows: Order[], label: string) {
  if (!rows.length) { console.log(`${label.padEnd(12)}     0`); return; }
  const cells = HORIZONS_MIN.map((h) =>
    `${f(100 * rows.filter((x) => x.touchMin !== null && x.touchMin <= h).length / rows.length)}%`.padStart(7));
  // reached before the order actually expired, under rolling refresh
  const eff = rows.filter((x) => x.touchMin !== null && x.touchMin <= x.effectiveTtlMin).length;
  console.log(`${label.padEnd(12)} ${String(rows.length).padStart(5)} ${cells.join("")}   ${f(100 * eff / rows.length).padStart(6)}%`);
}
console.log("\n═══ ORDER-LEVEL CUMULATIVE REACHABILITY ═══");
console.log(`${"group".padEnd(12)} ${"n".padStart(5)} ${HORIZONS_MIN.map((h) => (h < 60 ? `${h}m` : `${h / 60}h`).padStart(7)).join("")}   PROD-TTL`);
curve(o, "ALL");
curve(o.filter((x) => !isCrypto(x.symbol)), "FX");
curve(o.filter((x) => isCrypto(x.symbol)), "CRYPTO");
console.log("  ─");
for (const s of PRODUCTION_UNIVERSE) curve(o.filter((x) => x.symbol === s), s);
console.log("  ─ by zone timeframe ─");
for (const tf of [...new Set(o.map((x) => x.zoneTF ?? "null"))].sort()) curve(o.filter((x) => (x.zoneTF ?? "null") === tf), String(tf));

console.log("\n═══ ORDER-LEVEL ARRIVAL TABLE ═══");
console.log("horizon    n  reached  reach%   medTTR   p25    p75");
for (const h of HORIZONS_MIN) {
  const r = o.filter((x) => x.touchMin !== null && x.touchMin <= h);
  const t = r.map((x) => x.touchMin!);
  console.log(`${(h < 60 ? `${h}m` : `${h / 60}h`).padEnd(7)} ${String(o.length).padStart(5)} ${String(r.length).padStart(7)} ` +
    `${f(100 * r.length / o.length).padStart(7)} ${f(q(t, 0.5), 0).padStart(8)} ${f(q(t, 0.25), 0).padStart(5)} ${f(q(t, 0.75), 0).padStart(6)}`);
}
console.log(`median start distance: ${f(q(o.map((x) => x.distPips), 0.5))} pips, ` +
  `${f(q(o.map((x) => x.distAtrH1 ?? NaN).filter(Number.isFinite), 0.5), 2)} H1-ATR`);

console.log("\n═══ ORDER-LEVEL DISTANCE BUCKETS ═══");
const B: Array<[string, number, number]> = [["0-0.25 ATR", 0, .25], ["0.25-0.5", .25, .5], ["0.5-1.0", .5, 1], ["1.0-1.5", 1, 1.5], ["1.5+", 1.5, Infinity]];
console.log(`${"bucket".padEnd(12)} ${"n".padStart(5)} ${HORIZONS_MIN.map((h) => (h < 60 ? `${h}m` : `${h / 60}h`).padStart(7)).join("")}   PROD-TTL  medPips`);
for (const [lab, lo, hi] of B) {
  const rows = o.filter((x) => x.distAtrH1 !== null && x.distAtrH1 >= lo && x.distAtrH1 < hi);
  if (!rows.length) { console.log(`${lab.padEnd(12)}     0`); continue; }
  const cells = HORIZONS_MIN.map((h) => `${f(100 * rows.filter((x) => x.touchMin !== null && x.touchMin <= h).length / rows.length)}%`.padStart(7));
  const eff = rows.filter((x) => x.touchMin !== null && x.touchMin <= x.effectiveTtlMin).length;
  console.log(`${lab.padEnd(12)} ${String(rows.length).padStart(5)} ${cells.join("")}   ${f(100 * eff / rows.length).padStart(7)}%  ${f(q(rows.map((x) => x.distPips), 0.5))}`);
}

console.log(`\nORDER-LEVEL rate: ${(o.length / 180).toFixed(1)} orders/day across 8 instruments ` +
  `(live production: ~2.5/day on 7 instruments over 14 days)`);
