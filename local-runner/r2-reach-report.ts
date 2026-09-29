/** §5-§9 reachability tables. Descriptive only — no filters, no tuning. */
import { HORIZONS_MIN, type R2Cand } from "./r2-candidates.ts";
import { PRODUCTION_UNIVERSE, isCrypto } from "./smc-corpus-fetch.ts";

const all: R2Cand[] = [];
for (const s of PRODUCTION_UNIVERSE) {
  try {
    all.push(...JSON.parse(Deno.readTextFileSync(
      new URL(`./.cache/r2c_${s.replace("/", "")}.json`, import.meta.url))));
  } catch { console.log(`missing cache: ${s}`); }
}
// A candidate whose 24h window runs off the end of the tape cannot answer the
// long horizons. Excluded outright rather than counted as "not reached".
const c = all.filter((x) => x.windowComplete);
console.log(`candidates total=${all.length}  windowComplete=${c.length}  dropped(incomplete 24h window)=${all.length - c.length}`);

const q = (a: number[], p: number) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : NaN;
const f = (n: number, d = 1) => Number.isFinite(n) ? n.toFixed(d) : "-";

function curve(rows: R2Cand[], label: string) {
  if (!rows.length) { console.log(`${label.padEnd(12)} n=0`); return; }
  const cells = HORIZONS_MIN.map((h) => {
    const r = rows.filter((x) => x.touchMin !== null && x.touchMin <= h);
    return `${f(100 * r.length / rows.length)}%`.padStart(7);
  });
  console.log(`${label.padEnd(12)} ${String(rows.length).padStart(5)} ${cells.join("")}`);
}

console.log("\n═══ §3/§7 CUMULATIVE REACHABILITY CURVE ═══");
console.log(`${"group".padEnd(12)} ${"n".padStart(5)} ${HORIZONS_MIN.map((h) => (h < 60 ? `${h}m` : `${h / 60}h`).padStart(7)).join("")}`);
curve(c, "ALL");
curve(c.filter((x) => !isCrypto(x.symbol)), "FX");
curve(c.filter((x) => isCrypto(x.symbol)), "CRYPTO");
console.log("  ─");
for (const s of PRODUCTION_UNIVERSE) curve(c.filter((x) => x.symbol === s), s);

console.log("\n═══ §5 ARRIVAL TABLE (per horizon, ALL) ═══");
console.log("horizon    n  reached  reach%   medTTR   p25   p75   medDistPips  medDist/ATR");
for (const h of HORIZONS_MIN) {
  const r = c.filter((x) => x.touchMin !== null && x.touchMin <= h);
  const ttr = r.map((x) => x.touchMin!);
  console.log(
    `${(h < 60 ? `${h}m` : `${h / 60}h`).padEnd(7)} ${String(c.length).padStart(5)} ${String(r.length).padStart(7)} ` +
    `${f(100 * r.length / c.length).padStart(7)} ${f(q(ttr, 0.5), 0).padStart(8)} ${f(q(ttr, 0.25), 0).padStart(5)} ${f(q(ttr, 0.75), 0).padStart(5)}  ` +
    `${f(q(c.map((x) => x.distPips), 0.5)).padStart(12)} ${f(q(c.map((x) => x.distAtrH1 ?? NaN).filter(Number.isFinite), 0.5), 2).padStart(12)}`);
}

console.log("\n═══ §6 THE 60-MINUTE TTL ═══");
const R = (rows: R2Cand[]) => rows.filter((x) => x.touchMin !== null && x.touchMin <= 60);
const N = (rows: R2Cand[]) => rows.filter((x) => !(x.touchMin !== null && x.touchMin <= 60));
function ttlRow(label: string, rows: R2Cand[]) {
  if (!rows.length) return;
  const r = R(rows), n = N(rows);
  console.log(`${label.padEnd(12)} ${String(rows.length).padStart(5)} ${f(100 * r.length / rows.length).padStart(7)}% ` +
    `${f(100 * n.length / rows.length).padStart(7)}%   ` +
    `${f(q(r.map((x) => x.distPips), 0.5)).padStart(9)} ${f(q(n.map((x) => x.distPips), 0.5)).padStart(11)}  ` +
    `${f(q(r.map((x) => x.distAtrH1 ?? NaN).filter(Number.isFinite), 0.5), 2).padStart(8)} ${f(q(n.map((x) => x.distAtrH1 ?? NaN).filter(Number.isFinite), 0.5), 2).padStart(10)}`);
}
console.log(`${"group".padEnd(12)} ${"n".padStart(5)} reached%  missed%   medPipsR  medPipsMiss   ATR_R   ATR_miss`);
ttlRow("ALL", c);
ttlRow("FX", c.filter((x) => !isCrypto(x.symbol)));
ttlRow("CRYPTO", c.filter((x) => isCrypto(x.symbol)));
console.log("  ─");
for (const s of PRODUCTION_UNIVERSE) ttlRow(s, c.filter((x) => x.symbol === s));
console.log("  ─ by zone timeframe ─");
for (const tf of [...new Set(c.map((x) => x.zoneTF ?? "null"))].sort()) ttlRow(String(tf), c.filter((x) => (x.zoneTF ?? "null") === tf));

console.log("\n═══ §8 REACHABILITY BY INITIAL DISTANCE (H1 ATR) ═══");
const BUCKETS: Array<[string, number, number]> = [
  ["0-0.25 ATR", 0, 0.25], ["0.25-0.5", 0.25, 0.5], ["0.5-1.0", 0.5, 1.0],
  ["1.0-1.5", 1.0, 1.5], ["1.5+", 1.5, Infinity],
];
console.log(`${"bucket".padEnd(12)} ${"n".padStart(5)} ${HORIZONS_MIN.map((h) => (h < 60 ? `${h}m` : `${h / 60}h`).padStart(7)).join("")}   medPips`);
for (const [lab, lo, hi] of BUCKETS) {
  const rows = c.filter((x) => x.distAtrH1 !== null && x.distAtrH1 >= lo && x.distAtrH1 < hi);
  if (!rows.length) { console.log(`${lab.padEnd(12)} ${String(0).padStart(5)}`); continue; }
  const cells = HORIZONS_MIN.map((h) => `${f(100 * rows.filter((x) => x.touchMin !== null && x.touchMin <= h).length / rows.length)}%`.padStart(7));
  console.log(`${lab.padEnd(12)} ${String(rows.length).padStart(5)} ${cells.join("")}   ${f(q(rows.map((x) => x.distPips), 0.5))}`);
}

console.log("\n═══ §9 REACHABILITY BY ZONE TIMEFRAME ═══");
console.log(`${"zoneTF".padEnd(12)} ${"n".padStart(5)} ${HORIZONS_MIN.map((h) => (h < 60 ? `${h}m` : `${h / 60}h`).padStart(7)).join("")}   medPips  medATR`);
for (const tf of [...new Set(c.map((x) => x.zoneTF ?? "null"))].sort()) {
  const rows = c.filter((x) => (x.zoneTF ?? "null") === tf);
  const cells = HORIZONS_MIN.map((h) => `${f(100 * rows.filter((x) => x.touchMin !== null && x.touchMin <= h).length / rows.length)}%`.padStart(7));
  console.log(`${String(tf).padEnd(12)} ${String(rows.length).padStart(5)} ${cells.join("")}   ${f(q(rows.map((x) => x.distPips), 0.5)).padStart(6)}  ${f(q(rows.map((x) => x.distAtrH1 ?? NaN).filter(Number.isFinite), 0.5), 2)}`);
}

console.log("\n═══ entry-price source mix (production precedence) ═══");
const src: Record<string, number> = {};
for (const x of c) src[x.entrySource] = (src[x.entrySource] || 0) + 1;
console.log(JSON.stringify(src));
console.log(`median distance overall: ${f(q(c.map((x) => x.distPips), 0.5))} pips, ${f(q(c.map((x) => x.distAtrH1 ?? NaN).filter(Number.isFinite), 0.5), 2)} ATR`);
