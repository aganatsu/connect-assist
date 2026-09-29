/**
 * SMC_ROUTE2_PENDING_DISTANCE_V1 — pre-registered ATR distance caps.
 *
 * The cap REJECTS a candidate before pending creation. It never moves the
 * entry price. Because rejection happens at creation, the cap is applied to
 * the per-scan candidate stream BEFORE production's refresh-in-place dedup:
 * an order is created at the first ACCEPTED detection and refreshed only on
 * subsequent accepted ones, so a cap can also split or delay a run.
 *
 * Geometry, TTL, confirmation and gates are all unchanged.
 */
import { HORIZONS_MIN, type R2Cand } from "./r2-candidates.ts";
import { PRODUCTION_UNIVERSE, isCrypto } from "./smc-corpus-fetch.ts";

const TTL_MIN = 60;
/** Pre-registered. No other cutoff is evaluated. */
const CAPS: Array<[string, number]> = [["NO_CAP", Infinity], ["1.5 ATR", 1.5], ["1.0 ATR", 1.0], ["0.5 ATR", 0.5]];

const all: R2Cand[] = [];
for (const s of PRODUCTION_UNIVERSE) {
  try {
    all.push(...JSON.parse(Deno.readTextFileSync(
      new URL(`./.cache/r2c_${s.replace("/", "")}.json`, import.meta.url))));
  } catch { console.log(`MISSING CACHE ${s}`); }
}

interface Order {
  symbol: string; direction: string; entryPrice: number; zoneTF: string | null;
  entrySource: string; distAtr: number; distPips: number;
  touchMin: number | null; effTtl: number; refreshes: number; createdMs: number;
}
/** Stable identity. touchMin must NOT be part of it: ~52% of orders are never
 *  touched, so a key containing it collides across distinct orders. */
const oid = (o: Order) => `${o.symbol}|${o.direction}|${o.entryPrice}|${o.createdMs}`;

/** Group accepted candidates into production orders. */
function buildOrders(cands: R2Cand[]): Order[] {
  const byKey = new Map<string, R2Cand[]>();
  for (const c of cands) {
    const k = `${c.symbol}|${c.direction}|${c.entryPrice}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(c);
  }
  const out: Order[] = [];
  for (const [, rows] of byKey) {
    rows.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    let run: R2Cand[] = [];
    const flush = () => {
      if (!run.length) return;
      const f = run[0], l = run[run.length - 1];
      out.push({
        symbol: f.symbol, direction: f.direction, entryPrice: f.entryPrice, zoneTF: f.zoneTF,
        entrySource: f.entrySource, distAtr: f.distAtrH1 as number, distPips: f.distPips,
        touchMin: f.touchMin, refreshes: run.length - 1, createdMs: Date.parse(f.t),
        effTtl: Math.round((Date.parse(l.t) - Date.parse(f.t)) / 60000) + TTL_MIN,
      });
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

// Only candidates with a complete 24h window and a defined ATR can be capped
// or scored. Excluded once, up front, so every cap sees the same base.
const base = all.filter((c) => c.windowComplete && c.distAtrH1 !== null && Number.isFinite(c.distAtrH1));
console.log("═══ 1. DATA VALIDITY ═══");
console.log(`raw candidates            ${all.length}`);
console.log(`usable (24h window + ATR) ${base.length}   dropped ${all.length - base.length}`);

const q = (a: number[], p: number) => a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : NaN;
const f = (n: number, d = 1) => Number.isFinite(n) ? n.toFixed(d) : "-";
const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : "-";
const reachedTTL = (o: Order[]) => o.filter((x) => x.touchMin !== null && x.touchMin <= x.effTtl);

const SETS = CAPS.map(([lab, cap]) => {
  const cands = base.filter((c) => (c.distAtrH1 as number) <= cap);
  return { lab, cap, cands, orders: buildOrders(cands) };
});
const baseOrders = SETS[0].orders.length;

console.log("\n═══ 2/3. BASELINE + CAP POPULATION ═══");
console.log(`${"cap".padEnd(8)} ${"cands".padStart(6)} ${"orders".padStart(7)} ${"retain".padStart(7)} ${"medATR".padStart(7)} ${"p75".padStart(6)} ${"p90".padStart(6)} ${"FX".padStart(5)} ${"CRYP".padStart(5)}`);
for (const s of SETS) {
  const d = s.orders.map((x) => x.distAtr);
  console.log(`${s.lab.padEnd(8)} ${String(s.cands.length).padStart(6)} ${String(s.orders.length).padStart(7)} ` +
    `${pct(s.orders.length, baseOrders).padStart(7)} ${f(q(d, .5), 2).padStart(7)} ${f(q(d, .75), 2).padStart(6)} ${f(q(d, .9), 2).padStart(6)} ` +
    `${String(s.orders.filter((x) => !isCrypto(x.symbol)).length).padStart(5)} ${String(s.orders.filter((x) => isCrypto(x.symbol)).length).padStart(5)}`);
}
console.log("\nper-instrument order counts");
console.log(`${"cap".padEnd(8)} ${PRODUCTION_UNIVERSE.map((s) => s.padStart(9)).join("")}   maxShare`);
for (const s of SETS) {
  const cnt = PRODUCTION_UNIVERSE.map((sy) => s.orders.filter((x) => x.symbol === sy).length);
  const mx = s.orders.length ? Math.max(...cnt) / s.orders.length : 0;
  console.log(`${s.lab.padEnd(8)} ${cnt.map((c) => String(c).padStart(9)).join("")}   ${(100 * mx).toFixed(1)}%`);
}

console.log("\n═══ 4. CURRENT-TTL REACHABILITY (primary metric; TTL unchanged) ═══");
console.log(`${"cap".padEnd(8)} ${"orders".padStart(7)} ${"reached".padStart(8)} ${"missed".padStart(7)} ${"reach%".padStart(7)} ${"medTTR".padStart(7)} ${"medATRhit".padStart(10)} ${"medATRmiss".padStart(11)}`);
for (const s of SETS) {
  const r = reachedTTL(s.orders);
  const m = s.orders.filter((x) => !(x.touchMin !== null && x.touchMin <= x.effTtl));
  console.log(`${s.lab.padEnd(8)} ${String(s.orders.length).padStart(7)} ${String(r.length).padStart(8)} ${String(m.length).padStart(7)} ` +
    `${pct(r.length, s.orders.length).padStart(7)} ${f(q(r.map((x) => x.touchMin!), .5), 0).padStart(7)} ` +
    `${f(q(r.map((x) => x.distAtr), .5), 2).padStart(10)} ${f(q(m.map((x) => x.distAtr), .5), 2).padStart(11)}`);
}

console.log("\n═══ 5. FIXED-HORIZON CURVES ═══");
console.log(`${"cap".padEnd(8)} ${"n".padStart(6)} ${HORIZONS_MIN.map((h) => (h < 60 ? `${h}m` : `${h / 60}h`).padStart(7)).join("")}`);
for (const s of SETS) {
  console.log(`${s.lab.padEnd(8)} ${String(s.orders.length).padStart(6)} ` +
    HORIZONS_MIN.map((h) => pct(s.orders.filter((x) => x.touchMin !== null && x.touchMin <= h).length, s.orders.length).padStart(7)).join(""));
}

console.log("\n═══ 6. INSTRUMENT BREAKDOWN — current-TTL reach% (n) ═══");
console.log(`${"cap".padEnd(8)} ${PRODUCTION_UNIVERSE.map((s) => s.padStart(13)).join("")}`);
for (const s of SETS) {
  console.log(`${s.lab.padEnd(8)} ` + PRODUCTION_UNIVERSE.map((sy) => {
    const o = s.orders.filter((x) => x.symbol === sy);
    return `${pct(reachedTTL(o).length, o.length)}(${o.length})`.padStart(13);
  }).join(""));
}

console.log("\n═══ 7. FX VS CRYPTO ═══");
console.log(`${"cap".padEnd(8)} ${"class".padEnd(7)} ${"n".padStart(6)} ${"retain".padStart(7)} ${"TTLreach".padStart(9)} ${"24hreach".padStart(9)}`);
for (const s of SETS) {
  for (const [lab, fn] of [["FX", (x: Order) => !isCrypto(x.symbol)], ["CRYPTO", (x: Order) => isCrypto(x.symbol)]] as const) {
    const o = s.orders.filter(fn);
    const b = SETS[0].orders.filter(fn);
    console.log(`${s.lab.padEnd(8)} ${lab.padEnd(7)} ${String(o.length).padStart(6)} ${pct(o.length, b.length).padStart(7)} ` +
      `${pct(reachedTTL(o).length, o.length).padStart(9)} ${pct(o.filter((x) => x.touchMin !== null && x.touchMin <= 1440).length, o.length).padStart(9)}`);
  }
}

console.log("\n═══ 8. ZONE-TF COMPOSITION of retained orders ═══");
const TFS = ["5m", "15m", "1H"];
console.log(`${"cap".padEnd(8)} ${TFS.map((t) => `${t}`.padStart(14)).join("")}`);
for (const s of SETS) {
  console.log(`${s.lab.padEnd(8)} ` + TFS.map((t) => {
    const o = s.orders.filter((x) => (x.zoneTF ?? "null") === t);
    return `${pct(o.length, s.orders.length)}(${o.length})`.padStart(14);
  }).join(""));
}

console.log("\n═══ 9. ENTRY-SOURCE COMPOSITION of retained orders ═══");
const SRC = ["refinedEntry", "zoneMid", "unified"];
console.log(`${"cap".padEnd(8)} ${SRC.map((t) => t.padStart(16)).join("")}`);
for (const s of SETS) {
  console.log(`${s.lab.padEnd(8)} ` + SRC.map((t) => {
    const o = s.orders.filter((x) => x.entrySource === t);
    return `${pct(o.length, s.orders.length)}(${o.length})`.padStart(16);
  }).join(""));
}
console.log("\nmedian distance by entry source (uncapped orders)");
for (const t of SRC) {
  const o = SETS[0].orders.filter((x) => x.entrySource === t);
  console.log(`  ${t.padEnd(14)} n=${String(o.length).padStart(5)} medATR=${f(q(o.map((x) => x.distAtr), .5), 2)} p90=${f(q(o.map((x) => x.distAtr), .9), 2)}`);
}

console.log("\n═══ 10. REJECTED-ORDER DIAGNOSTICS ═══");
for (const s of SETS.slice(1)) {
  const kept = new Set(s.orders.map(oid));
  const rej = SETS[0].orders.filter((o) => !kept.has(oid(o)));
  const retimed = s.orders.filter((o) => !new Set(SETS[0].orders.map(oid)).has(oid(o)));
  console.log(`\n  cap ${s.lab}: ${rej.length} of ${baseOrders} uncapped orders removed (${pct(rej.length, baseOrders)}); ${retimed.length} capped orders are re-timed (created at a later, closer detection of the same level)`);
  console.log(`    median distance ${f(q(rej.map((x) => x.distAtr), .5), 2)} ATR   FX ${rej.filter((x) => !isCrypto(x.symbol)).length}  crypto ${rej.filter((x) => isCrypto(x.symbol)).length}`);
  console.log(`    zoneTF  ` + TFS.map((t) => `${t}=${rej.filter((x) => x.zoneTF === t).length}`).join("  "));
  console.log(`    source  ` + SRC.map((t) => `${t}=${rej.filter((x) => x.entrySource === t).length}`).join("  "));
  console.log(`    by instrument  ` + PRODUCTION_UNIVERSE.map((sy) => `${sy}=${rej.filter((x) => x.symbol === sy).length}`).join(" "));
}
