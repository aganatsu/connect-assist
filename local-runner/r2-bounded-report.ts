/** Bounded-population TTL study + refinedEntry geometry audit. Structural only. */
import { PRODUCTION_UNIVERSE, isCrypto } from "./smc-corpus-fetch.ts";
import type { GeoRow } from "./r2-geometry.ts";

const CAP = 1.5, TTL_MIN = 60;
/** Pre-registered. No other horizon is evaluated. */
const H = [30, 60, 90, 120, 240, 480, 720, 1440] as const;
const hl = (h: number) => (h < 60 ? `${h}m` : h % 60 ? `${h / 60}h` : `${h / 60}h`);

const all: GeoRow[] = [];
for (const s of PRODUCTION_UNIVERSE) {
  try {
    all.push(...JSON.parse(Deno.readTextFileSync(
      new URL(`./.cache/r2g_${s.replace("/", "")}.json`, import.meta.url))));
  } catch { console.log(`MISSING ${s}`); }
}
const base = all.filter((c) => c.windowComplete && Number.isFinite(c.distAtrH1));
const capped = base.filter((c) => c.distAtrH1 <= CAP);

interface Ord extends GeoRow { effTtl: number; refreshes: number; createdMs: number }
function buildOrders(cs: GeoRow[]): Ord[] {
  const g = new Map<string, GeoRow[]>();
  for (const c of cs) {
    const k = `${c.symbol}|${c.direction}|${c.entryPrice}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k)!.push(c);
  }
  const out: Ord[] = [];
  for (const [, rows] of g) {
    rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    let run: GeoRow[] = [];
    const flush = () => {
      if (!run.length) return;
      const f = run[0], l = run[run.length - 1];
      out.push({ ...f, refreshes: run.length - 1, createdMs: Date.parse(f.t),
        effTtl: Math.round((Date.parse(l.t) - Date.parse(f.t)) / 60000) + TTL_MIN });
      run = [];
    };
    for (const c of rows) {
      if (run.length && (Date.parse(c.t) - Date.parse(run[run.length - 1].t)) / 60000 > TTL_MIN) flush();
      run.push(c);
    }
    flush();
  }
  return out;
}
const O = buildOrders(capped);
const OB = buildOrders(base);

const q = (a: number[], p: number) => { const s = a.filter(Number.isFinite).slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : NaN; };
const f = (n: number, d = 1) => Number.isFinite(n) ? n.toFixed(d) : "-";
const pc = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : "-";
const rch = (o: Ord[], h: number) => o.filter((x) => x.touchMin !== null && x.touchMin <= h);

console.log("═══ 1. DATA VALIDITY / 2. BOUNDED POPULATION ═══");
console.log(`candidates ${all.length}  usable ${base.length}  <=${CAP} ATR ${capped.length}`);
console.log(`orders: uncapped ${OB.length}   BOUNDED ${O.length}  (prior audit expected ~502)`);
console.log(`bounded med dist ${f(q(O.map((x) => x.distAtrH1), .5), 2)} ATR  p75 ${f(q(O.map((x) => x.distAtrH1), .75), 2)}  p90 ${f(q(O.map((x) => x.distAtrH1), .9), 2)}`);
const tot24 = rch(O, 1440).length;

console.log("\n═══ 3. TTL REACHABILITY CURVE (bounded, ALL) ═══");
console.log(`horiz     n reached  reach%   incr   medTTR   p25   p75  medATRhit  medATRmiss`);
let prev = 0;
for (const h of H) {
  const r = rch(O, h), t = r.map((x) => x.touchMin!);
  const miss = O.filter((x) => !(x.touchMin !== null && x.touchMin <= h));
  console.log(`${hl(h).padEnd(6)} ${String(O.length).padStart(5)} ${String(r.length).padStart(6)} ${pc(r.length, O.length).padStart(7)} ` +
    `${pc(r.length - prev, O.length).padStart(6)} ${f(q(t, .5), 0).padStart(8)} ${f(q(t, .25), 0).padStart(5)} ${f(q(t, .75), 0).padStart(5)} ` +
    `${f(q(r.map((x) => x.distAtrH1), .5), 2).padStart(10)} ${f(q(miss.map((x) => x.distAtrH1), .5), 2).padStart(11)}`);
  prev = r.length;
}

console.log("\n═══ 4. ARRIVAL CAPTURE BY TTL (main diagnostic) ═══");
console.log(`horiz   reach%   % of all 24h arrivals CAPTURED   % DISCARDED by expiry`);
for (const h of H) {
  const r = rch(O, h).length;
  console.log(`${hl(h).padEnd(6)} ${pc(r, O.length).padStart(7)} ${pc(r, tot24).padStart(31)} ${pc(tot24 - r, tot24).padStart(23)}`);
}
console.log(`(24h arrivals in the bounded population: ${tot24} of ${O.length} orders)`);

console.log("\n═══ 5. FX VS CRYPTO ═══");
console.log(`${"group".padEnd(8)} ${"n".padStart(5)} ${H.map((h) => hl(h).padStart(7)).join("")}`);
for (const [lab, fn] of [["ALL", () => true], ["FX", (x: Ord) => !isCrypto(x.symbol)], ["CRYPTO", (x: Ord) => isCrypto(x.symbol)]] as const) {
  const o = O.filter(fn as (x: Ord) => boolean);
  console.log(`${lab.padEnd(8)} ${String(o.length).padStart(5)} ${H.map((h) => pc(rch(o, h).length, o.length).padStart(7)).join("")}`);
}

console.log("\n═══ 6. INSTRUMENT RESULTS ═══");
console.log(`${"sym".padEnd(8)} ${"n".padStart(5)} ${H.map((h) => hl(h).padStart(7)).join("")}   medATR`);
for (const s of PRODUCTION_UNIVERSE) {
  const o = O.filter((x) => x.symbol === s);
  console.log(`${s.padEnd(8)} ${String(o.length).padStart(5)} ${H.map((h) => pc(rch(o, h).length, o.length).padStart(7)).join("")}   ${f(q(o.map((x) => x.distAtrH1), .5), 2)}`);
}

console.log("\n═══ 7. ZONE-TF RESULTS ═══");
console.log(`${"zoneTF".padEnd(8)} ${"n".padStart(5)} ${H.map((h) => hl(h).padStart(7)).join("")}   medATR`);
for (const tf of ["5m", "15m", "1H"]) {
  const o = O.filter((x) => (x.zoneTF ?? "") === tf);
  console.log(`${tf.padEnd(8)} ${String(o.length).padStart(5)} ${H.map((h) => pc(rch(o, h).length, o.length).padStart(7)).join("")}   ${f(q(o.map((x) => x.distAtrH1), .5), 2)}`);
}

console.log("\n═══ 8. ENTRY-SOURCE RESULTS (bounded) ═══");
console.log(`${"source".padEnd(14)} ${"n".padStart(5)} ${"medATR".padStart(7)} ${"60m".padStart(7)} ${"2h".padStart(7)} ${"4h".padStart(7)} ${"24h".padStart(7)}`);
for (const src of ["refinedEntry", "zoneMid", "unified"]) {
  const o = O.filter((x) => x.entrySource === src);
  console.log(`${src.padEnd(14)} ${String(o.length).padStart(5)} ${f(q(o.map((x) => x.distAtrH1), .5), 2).padStart(7)} ` +
    [60, 120, 240, 1440].map((h) => pc(rch(o, h).length, o.length).padStart(7)).join(""));
}

// ══════════ refinedEntry geometry, on the FULL (uncapped) population ══════════
const RE = base.filter((c) => c.refinedEntry !== null);
console.log("\n═══ 10. REFINED ENTRY GEOMETRY (uncapped candidates) ═══");
console.log(`refinedEntry present on ${RE.length} of ${base.length} candidates (${pc(RE.length, base.length)})`);
const zwAtr = RE.map((c) => (c.poiHigh - c.poiLow) / c.atrH1);
console.log(`zone width: med ${f(q(zwAtr, .5), 2)} ATR  p75 ${f(q(zwAtr, .75), 2)}  p90 ${f(q(zwAtr, .9), 2)}`);
console.log(`impulse range: med ${f(q(RE.map((c) => ((c.impulseHigh ?? NaN) - (c.impulseLow ?? NaN)) / c.atrH1), .5), 2)} ATR`);
console.log(`dist(refinedEntry): med ${f(q(RE.map((c) => Math.abs(c.refinedEntry! - c.lastPrice) / c.atrH1), .5), 2)} ATR`);

console.log("\n  decomposition: distance to NEAREST zone edge vs extra depth to refinedEntry");
const dz = RE.map((c) => (c.engineDistToZone ?? NaN) / c.atrH1);
const dEntry = RE.map((c) => Math.abs(c.refinedEntry! - c.lastPrice) / c.atrH1);
const extra = RE.map((c, i) => dEntry[i] - dz[i]);
console.log(`    to zone edge : med ${f(q(dz, .5), 2)} ATR   p75 ${f(q(dz, .75), 2)}`);
console.log(`    extra depth  : med ${f(q(extra, .5), 2)} ATR   p75 ${f(q(extra, .75), 2)}`);
console.log(`    share of total distance that is ZONE-DISTANCE: ${f(100 * q(dz, .5) / q(dEntry, .5), 0)}%`);

console.log("\n═══ 11. OUTSIDE-ZONE / GEOMETRY CHECK ═══");
const cls: Record<string, number> = {};
for (const c of RE) {
  const e = c.refinedEntry!, lo = c.poiLow, hi = c.poiHigh;
  const tol = (hi - lo) * 1e-9;
  let k: string;
  if (!Number.isFinite(e) || !(hi > lo)) k = "INVALID_GEOMETRY";
  else if (Math.abs(e - lo) <= tol || Math.abs(e - hi) <= tol) k = "ON_ZONE_BOUNDARY";
  else if (e > lo && e < hi) k = "INSIDE_VALID_ZONE";
  else k = "OUTSIDE_ZONE";
  cls[k] = (cls[k] || 0) + 1;
}
for (const [k, v] of Object.entries(cls).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}  ${pc(v, RE.length)}`);
// is refinedEntry the PROXIMAL or DISTAL edge?
const prox = RE.filter((c) => c.direction === "long"
  ? Math.abs(c.refinedEntry! - c.poiHigh) < Math.abs(c.refinedEntry! - c.poiLow)
  : Math.abs(c.refinedEntry! - c.poiLow) < Math.abs(c.refinedEntry! - c.poiHigh));
console.log(`  refinedEntry nearer the PROXIMAL zone edge (side price approaches from): ${prox.length}/${RE.length} (${pc(prox.length, RE.length)})`);

console.log("\n═══ 12. OTE / FIB CONSISTENCY (of the POI the entry sits in) ═══");
const fibRows = RE.filter((c) => c.fibLevel != null && c.impulseHigh != null && c.impulseLow != null && c.impulseHigh > c.impulseLow);
const diffs: number[] = [];
for (const c of fibRows) {
  const rng = c.impulseHigh! - c.impulseLow!;
  const exp = c.impulseDir === "bullish" ? c.impulseHigh! - c.fibLevel! * rng : c.impulseLow! + c.fibLevel! * rng;
  diffs.push(Math.abs(((c.poiHigh + c.poiLow) / 2) - exp) / c.atrH1);
}
console.log(`n=${fibRows.length}  |POI mid - expected Fib level|: med ${f(q(diffs, .5), 2)} ATR  p75 ${f(q(diffs, .75), 2)}  p90 ${f(q(diffs, .9), 2)}`);
console.log(`within 0.5 ATR of the stated Fib level: ${pc(diffs.filter((d) => d <= 0.5).length, diffs.length)}`);
const byFib: Record<string, number[]> = {};
for (const c of RE) {
  const k = c.fibLevel == null ? "null" : c.fibLevel.toFixed(3);
  (byFib[k] ??= []).push(Math.abs(c.refinedEntry! - c.lastPrice) / c.atrH1);
}
console.log("  distance by stated Fib level:");
for (const [k, v] of Object.entries(byFib).sort()) console.log(`    fib ${k.padEnd(6)} n=${String(v.length).padStart(5)} medDist=${f(q(v, .5), 2)} ATR`);

console.log("\n═══ 13. DISTANCE CAUSE DECOMPOSITION ═══");
const med = (rows: GeoRow[]) => q(rows.map((c) => Math.abs(c.refinedEntry! - c.lastPrice) / c.atrH1), .5);
console.log("  A. zone timeframe");
for (const tf of ["5m", "15m", "1H"]) {
  const r = RE.filter((c) => c.zoneTF === tf);
  console.log(`     ${tf.padEnd(4)} n=${String(r.length).padStart(5)} medDist=${f(med(r), 2)} ATR  medZoneWidth=${f(q(r.map((c) => (c.poiHigh - c.poiLow) / c.atrH1), .5), 2)}  medImpulse=${f(q(r.map((c) => ((c.impulseHigh ?? NaN) - (c.impulseLow ?? NaN)) / c.atrH1), .5), 2)}`);
}
console.log("  B. impulse leg length (ATR quintiles)");
const impR = RE.map((c) => ((c.impulseHigh ?? NaN) - (c.impulseLow ?? NaN)) / c.atrH1);
for (let i = 0; i < 5; i++) {
  const lo = q(impR, i / 5), hi = q(impR, (i + 1) / 5);
  const r = RE.filter((c) => { const v = ((c.impulseHigh ?? NaN) - (c.impulseLow ?? NaN)) / c.atrH1; return v >= lo && (i === 4 ? true : v < hi); });
  console.log(`     impulse ${f(lo, 1)}-${f(hi, 1)} ATR  n=${String(r.length).padStart(5)} medDist=${f(med(r), 2)}`);
}
console.log("  D. zone/impulse age (minutes since impulse end)");
const ages = RE.map((c) => c.impulseAgeMin).filter((x): x is number => x != null);
console.log(`     resolved on ${ages.length}/${RE.length}; med ${f(q(ages, .5), 0)}m  p75 ${f(q(ages, .75), 0)}m  p90 ${f(q(ages, .9), 0)}m`);
for (const [lab, lo, hi] of [["<60m", 0, 60], ["1-4h", 60, 240], ["4-12h", 240, 720], ["12-48h", 720, 2880], ["48h+", 2880, Infinity]] as const) {
  const r = RE.filter((c) => c.impulseAgeMin != null && c.impulseAgeMin >= lo && c.impulseAgeMin < hi);
  if (r.length) console.log(`     age ${lab.padEnd(7)} n=${String(r.length).padStart(5)} medDist=${f(med(r), 2)} ATR`);
}

console.log("\n═══ 14. UNIFIED VS REFINED (both present on the same setup) ═══");
const both = base.filter((c) => c.refinedEntry !== null && c.unifiedEntry !== null);
console.log(`n=${both.length}`);
if (both.length) {
  const dr = both.map((c) => Math.abs(c.refinedEntry! - c.lastPrice) / c.atrH1);
  const du = both.map((c) => Math.abs(c.unifiedEntry! - c.lastPrice) / c.atrH1);
  console.log(`  refined med ${f(q(dr, .5), 2)} ATR   unified med ${f(q(du, .5), 2)} ATR`);
  console.log(`  unified closer on ${pc(both.filter((c, i) => du[i] < dr[i]).length, both.length)}   median |diff| ${f(q(both.map((_, i) => Math.abs(dr[i] - du[i])), .5), 2)} ATR`);
  for (const tf of ["5m", "15m", "1H"]) {
    const idx = both.map((c, i) => [c, i] as const).filter(([c]) => c.zoneTF === tf);
    if (!idx.length) continue;
    console.log(`    ${tf.padEnd(4)} n=${String(idx.length).padStart(4)} refined ${f(q(idx.map(([, i]) => dr[i]), .5), 2)}  unified ${f(q(idx.map(([, i]) => du[i]), .5), 2)}  unified-closer ${pc(idx.filter(([, i]) => du[i] < dr[i]).length, idx.length)}`);
  }
  const bo = buildOrders(both.filter((c) => c.distAtrH1 <= CAP));
  console.log(`  bounded orders where both exist: n=${bo.length}, 60m reach ${pc(rch(bo, 60).length, bo.length)}`);
}
