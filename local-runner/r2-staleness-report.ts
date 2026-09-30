/** Zone-staleness + TTL selection tables. Structural only, no profitability. */
import { PRODUCTION_UNIVERSE, isCrypto } from "./smc-corpus-fetch.ts";
import type { StaleRow } from "./r2-staleness.ts";

const TTLS = [120, 240, 480] as const;      // pre-registered: 2h, 4h, 8h
const BANDS: Array<[string, number, number]> = [
  ["<2h", 0, 120], ["2-6h", 120, 360], ["6-12h", 360, 720],
  ["12-24h", 720, 1440], ["24-48h", 1440, 2880], ["48h+", 2880, Infinity],
];

const R: StaleRow[] = [];
for (const s of PRODUCTION_UNIVERSE) {
  R.push(...JSON.parse(Deno.readTextFileSync(
    new URL(`./.cache/r2s_${s.replace("/", "")}.json`, import.meta.url))));
}
const q = (a: number[], p: number) => { const s = a.filter(Number.isFinite).slice().sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : NaN; };
const f = (n: number, d = 1) => Number.isFinite(n) ? n.toFixed(d) : "-";
const pc = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}%` : "-";

const touched = R.filter((r) => r.touchMin !== null);
const validT = R.filter((r) => r.touchClass === "VALID_AT_TOUCH");

console.log("═══ 1/2. DATA VALIDITY + BOUNDED POPULATION ═══");
console.log(`bounded orders ${R.length}   touches<=24h ${touched.length} (${pc(touched.length, R.length)})`);
console.log(`zone age located on ${R.filter((r) => Number.isFinite(r.zoneAgeMin)).length}/${R.length}`);

console.log("\n═══ 3. ZONE AGE DISTRIBUTION (at pending creation) ═══");
const ages = R.map((r) => r.zoneAgeMin);
console.log(`p25 ${f(q(ages, .25), 0)}m   med ${f(q(ages, .5), 0)}m (${f(q(ages, .5) / 60, 1)}h)   p75 ${f(q(ages, .75), 0)}m   p90 ${f(q(ages, .9), 0)}m   max ${f(Math.max(...ages), 0)}m`);
console.log(`${"band".padEnd(8)} ${"n".padStart(5)} ${"share".padStart(7)}`);
for (const [lab, lo, hi] of BANDS) {
  const b = R.filter((r) => r.zoneAgeMin >= lo && r.zoneAgeMin < hi);
  console.log(`${lab.padEnd(8)} ${String(b.length).padStart(5)} ${pc(b.length, R.length).padStart(7)}`);
}

console.log("\n═══ 4. VALIDITY AT CREATION ═══");
const cc: Record<string, number> = {};
for (const r of R) cc[r.createdClass] = (cc[r.createdClass] || 0) + 1;
for (const k of ["VALID", "WEAKENED", "INVALID", "UNKNOWN"]) if (cc[k]) console.log(`  ${k.padEnd(9)} ${String(cc[k]).padStart(5)}  ${pc(cc[k], R.length)}`);
console.log(`  (WEAKENED = a closed 5m bar had already closed through the POI distal edge between zone formation and order creation)`);
console.log(`  impulse already broken at creation: ${R.filter((r) => r.createdImpulseBroken).length}`);

console.log("\n═══ 5. VALIDITY AT TOUCH ═══");
const tc: Record<string, number> = {};
for (const r of touched) tc[String(r.touchClass)] = (tc[String(r.touchClass)] || 0) + 1;
for (const [k, v] of Object.entries(tc).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(22)} ${String(v).padStart(5)}  ${pc(v, touched.length)}`);

console.log("\n═══ 6. TTL ARRIVAL CAPTURE (descriptive) ═══");
console.log(`${"TTL".padEnd(5)} ${"n".padStart(5)} ${"reached".padStart(8)} ${"reach%".padStart(7)} ${"%of24h".padStart(8)} ${"expired%".padStart(9)}`);
for (const T of TTLS) {
  const r = touched.filter((x) => x.touchMin! <= T);
  console.log(`${(T / 60 + "h").padEnd(5)} ${String(R.length).padStart(5)} ${String(r.length).padStart(8)} ${pc(r.length, R.length).padStart(7)} ${pc(r.length, touched.length).padStart(8)} ${pc(R.length - r.length, R.length).padStart(9)}`);
}

console.log("\n═══ 7. TTL VALID-TOUCH CAPTURE (PRIMARY) ═══");
console.log(`all VALID_AT_TOUCH within 24h: ${validT.length}`);
console.log(`${"TTL".padEnd(5)} ${"valid".padStart(6)} ${"VALID_CAPTURE".padStart(14)} ${"weakened".padStart(9)} ${"invalidBefore".padStart(14)} ${"validShareOfArrivals".padStart(21)}`);
for (const T of TTLS) {
  const inT = touched.filter((x) => x.touchMin! <= T);
  const v = inT.filter((x) => x.touchClass === "VALID_AT_TOUCH");
  const w = inT.filter((x) => x.touchClass === "WEAKENED_AT_TOUCH");
  const i = inT.filter((x) => x.touchClass === "INVALID_BEFORE_TOUCH");
  console.log(`${(T / 60 + "h").padEnd(5)} ${String(v.length).padStart(6)} ${pc(v.length, validT.length).padStart(14)} ${String(w.length).padStart(9)} ${String(i.length).padStart(14)} ${pc(v.length, inT.length).padStart(21)}`);
}

console.log("\n═══ 8. ZONE AGE × TOUCH VALIDITY ═══");
console.log(`${"band".padEnd(8)} ${"n".padStart(5)} ${"24hReach".padStart(9)} ${"VALID".padStart(8)} ${"WEAKENED".padStart(9)} ${"INVALID_B4".padStart(11)} ${"medAgeMin".padStart(10)}`);
for (const [lab, lo, hi] of BANDS) {
  const b = R.filter((r) => r.zoneAgeMin >= lo && r.zoneAgeMin < hi);
  const t = b.filter((r) => r.touchMin !== null);
  if (!b.length) continue;
  console.log(`${lab.padEnd(8)} ${String(b.length).padStart(5)} ${pc(t.length, b.length).padStart(9)} ` +
    `${pc(t.filter((r) => r.touchClass === "VALID_AT_TOUCH").length, t.length).padStart(8)} ` +
    `${pc(t.filter((r) => r.touchClass === "WEAKENED_AT_TOUCH").length, t.length).padStart(9)} ` +
    `${pc(t.filter((r) => r.touchClass === "INVALID_BEFORE_TOUCH").length, t.length).padStart(11)} ` +
    `${f(q(b.map((r) => r.zoneAgeMin), .5), 0).padStart(10)}`);
}

console.log("\n═══ 9. ZONE TIMEFRAME ═══");
console.log(`${"tf".padEnd(5)} ${"n".padStart(5)} ${"medAge".padStart(7)} ${"24hReach".padStart(9)} ${"VALID@touch".padStart(12)} ${TTLS.map((T) => `cap${T / 60}h`.padStart(8)).join("")}`);
for (const tf of ["5m", "15m", "1H"]) {
  const b = R.filter((r) => r.zoneTF === tf);
  const t = b.filter((r) => r.touchMin !== null);
  const vAll = b.filter((r) => r.touchClass === "VALID_AT_TOUCH");
  console.log(`${tf.padEnd(5)} ${String(b.length).padStart(5)} ${f(q(b.map((r) => r.zoneAgeMin), .5), 0).padStart(7)} ${pc(t.length, b.length).padStart(9)} ` +
    `${pc(vAll.length, t.length).padStart(12)} ` +
    TTLS.map((T) => pc(vAll.filter((r) => r.touchMin! <= T).length, vAll.length).padStart(8)).join(""));
}

console.log("\n═══ 10. FX VS CRYPTO ═══");
console.log(`${"grp".padEnd(7)} ${"n".padStart(5)} ${"medAge".padStart(7)} ${"validTot".padStart(9)} ${TTLS.map((T) => `cap${T / 60}h`.padStart(8)).join("")} ${"invalidB4%".padStart(11)}`);
for (const [lab, fn] of [["FX", (r: StaleRow) => !isCrypto(r.symbol)], ["CRYPTO", (r: StaleRow) => isCrypto(r.symbol)]] as const) {
  const b = R.filter(fn);
  const t = b.filter((r) => r.touchMin !== null);
  const v = b.filter((r) => r.touchClass === "VALID_AT_TOUCH");
  console.log(`${lab.padEnd(7)} ${String(b.length).padStart(5)} ${f(q(b.map((r) => r.zoneAgeMin), .5), 0).padStart(7)} ${String(v.length).padStart(9)} ` +
    TTLS.map((T) => pc(v.filter((r) => r.touchMin! <= T).length, v.length).padStart(8)).join("") +
    ` ${pc(t.filter((r) => r.touchClass === "INVALID_BEFORE_TOUCH").length, t.length).padStart(11)}`);
}

console.log("\n═══ 11. INSTRUMENT STABILITY (valid-touch capture) ═══");
console.log(`${"sym".padEnd(8)} ${"n".padStart(5)} ${"validTot".padStart(9)} ${TTLS.map((T) => `cap${T / 60}h`.padStart(8)).join("")} ${"VALID@touch%".padStart(13)}`);
for (const s of PRODUCTION_UNIVERSE) {
  const b = R.filter((r) => r.symbol === s);
  const t = b.filter((r) => r.touchMin !== null);
  const v = b.filter((r) => r.touchClass === "VALID_AT_TOUCH");
  console.log(`${s.padEnd(8)} ${String(b.length).padStart(5)} ${String(v.length).padStart(9)} ` +
    TTLS.map((T) => pc(v.filter((r) => r.touchMin! <= T).length, v.length).padStart(8)).join("") +
    ` ${pc(v.length, t.length).padStart(13)}`);
}

console.log("\n═══ 12. STALENESS FAILURE MODES ═══");
const fm: Record<string, number> = {};
for (const r of touched) if (r.touchFailReason) fm[r.touchFailReason] = (fm[r.touchFailReason] || 0) + 1;
for (const [k, v] of Object.entries(fm).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}  ${pc(v, touched.length)} of arrivals`);
const inv = touched.filter((r) => r.touchClass === "INVALID_BEFORE_TOUCH");
if (inv.length) {
  const lead = inv.map((r) => r.touchMin! - Math.min(r.impulseBreakMin ?? Infinity, r.closeThroughMin ?? Infinity));
  console.log(`  invalidation lead time before touch: med ${f(q(lead, .5), 0)}m  p75 ${f(q(lead, .75), 0)}m`);
}

console.log("\n═══ 13. AGE VS WAIT-TIME DECOMPOSITION ═══");
console.log(`  A. already stale AT CREATION (closed through before the order existed): ${R.filter((r) => r.createdClosedThrough).length}/${R.length} (${pc(R.filter((r) => r.createdClosedThrough).length, R.length)})`);
console.log(`  B. becomes geometrically invalid AFTER creation, within 24h:`);
const firstInv = (r: StaleRow) => Math.min(r.impulseBreakMin ?? Infinity, r.closeThroughMin ?? Infinity);
for (const [lab, lo, hi] of [["0-2h", 0, 120], ["2-4h", 120, 240], ["4-8h", 240, 480], ["8h+", 480, Infinity]] as const) {
  const n = R.filter((r) => { const v = firstInv(r); return v >= lo && v < hi && Number.isFinite(v); }).length;
  console.log(`     ${lab.padEnd(6)} ${String(n).padStart(5)}  ${pc(n, R.length)}`);
}
console.log(`     never within 24h  ${String(R.filter((r) => !Number.isFinite(firstInv(r))).length).padStart(4)}  ${pc(R.filter((r) => !Number.isFinite(firstInv(r))).length, R.length)}`);
