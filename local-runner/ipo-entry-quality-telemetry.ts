/**
 * IPO_ENTRY_QUALITY_TELEMETRY_V1 — research telemetry, NOT a strategy test.
 *
 * Question: does the behaviour of price as it approaches, touches, penetrates
 * and leaves the IPO zone carry causal information about trade quality in the
 * frozen IPO_BASELINE_1H_4H_CAUSAL_V1 control?
 *
 * NOTHING IS FILTERED. The control is the committed trade list exactly as
 * frozen (docs/exports/ipo_1h_4h_combined_clean.csv). Features are attached as
 * telemetry; the IPO engine is not run, configured or changed.
 *
 * CONTROL. The accepted tag-the-frozen-trades approach, with a stricter gate:
 * besides the IPO-candle / entry-bar / fill-in-touch-bar checks, the re-fetched
 * 1m stream must re-derive every frozen 1m decision — the fill minute, the
 * target minute and the S2 bar — for all 1,032 trades, and the zone must equal
 * production ipoGeometry(). Any failure, or a control figure that does not
 * reproduce, stops the study before a single feature is analysed.
 *
 * FIREWALL. Pre-entry features come from preEntryFeatures(), which is handed
 * only 1m bars that closed before the fill minute. Cohorts and trend tests see
 * a projection holding pre-entry keys only (pickPre), and the declared feature
 * list is checked by assertPreEntryOnly() before any analysis.
 *
 * DRAWDOWN. Every new figure is chronological (the frozen 41.3R was file order).
 *
 * Every definition, bucket and threshold was FROZEN before the first run.
 *
 *   deno run --allow-read --allow-write local-runner/ipo-entry-quality-telemetry.ts
 */

import { CACHE } from "./ipo-ttm-fetch.ts";
import { EXPORT, exitInstant, firstProblem, gapOk, loadM1, loadManifest, readCsv, sanitizeM1 } from "./ipo-entry-m1-fetch.ts";
import { ipoGeometry } from "../supabase/functions/_shared/ipoZones.ts";
import { runLifecycle, type LifecycleIPO } from "../supabase/functions/_shared/ipoLifecycle.ts";
import { episodesFor } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import {
  assertPreEntryOnly, EARLY_HORIZONS, pickPre, POST_ENTRY_OUTCOMES, postEntryOutcomes, PRE_COHORTS,
  PRE_ENTRY_FEATURES, preEntryFeatures, R_LEVELS, TREND_FEATURES, STRUCTURE_BARS,
  type Bar, type Geom, type PostOutcomes, type PreFeatures,
} from "./entryQuality.ts";

const OUT = new URL("../docs/exports/", import.meta.url);
const CACHE_OUT = new URL("./.cache/ipo-entry-quality/", import.meta.url);

// ── frozen analysis constants (identical to the market-context study) ─────
const PERM_ITERS = 10_000, BOOT_ITERS = 5_000;
const CAND_MIN_N = 60, CAND_MIN_DIFF = 0.15, CAND_MAX_BH_Q = 0.10;
const SLICE_MIN_N = 15, SLICE_REVERSE_N = 30, MIN_EVALUABLE_SLICES = 4;
const PIP: Record<string, number> = { "EUR/USD": 0.0001, "USD/JPY": 0.01, "BTC/USD": 1 };
const TF_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000 };
const M1_LOOKBACK = 1500;            // closed 1m bars before the fill handed to the pre-entry module

// ── firewall check BEFORE anything else ────────────────────────────────────
assertPreEntryOnly(PRE_COHORTS.map((c) => c.feature));
assertPreEntryOnly(TREND_FEATURES);

const frozen = readCsv(EXPORT);
const seriesCache = new Map<string, Bar[]>();
const series = (window: string, tf: string): Bar[] => {
  const k = `${window.replace("/", "")}_${tf}.json`;
  if (!seriesCache.has(k)) seriesCache.set(k, JSON.parse(Deno.readTextFileSync(new URL(k, CACHE))));
  return seriesCache.get(k)!;
};
const m1Cache = new Map<string, { bars: Bar[]; t: number[]; man: [number, number][]; glitch: Uint8Array; clamped: Uint8Array }>();
const m1For = (inst: string) => {
  if (!m1Cache.has(inst)) {
    const { bars, clamped, glitch } = sanitizeM1(loadM1(inst));   // repair + glitch rules: see sanitizeM1
    m1Cache.set(inst, { bars, t: bars.map((b) => Date.parse(b.datetime)), man: loadManifest(inst), glitch, clamped });
  }
  return m1Cache.get(inst)!;
};
const lowerBound = (t: number[], x: number) => { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-9;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

// ── gate + features ────────────────────────────────────────────────────────
export interface Row {
  instrument: string; tf: string; window: string; direction: string; period: "older" | "newer";
  m1_entry_time: string; exit_reason: string; net_r: number;
  pre: PreFeatures; post: PostOutcomes;
  ipoIdx: number; entryIdx: number; touchBarClose: number; nextBarClose: number | null; stop: number; s2Offset: number | null;
}
const fails: string[] = [];
const rows: Row[] = [];
let repairedTrades = 0, repairedBars = 0;
for (const r of frozen) {
  const tag = `${r.window} ${r.entry_time}`;
  const tfMs = TF_MS[r.ipo_timeframe];
  const bars = series(r.window, r.ipo_timeframe);
  const ipoIdx = bars.findIndex((b) => b.datetime === r.ipo_origin_time);
  const entryIdx = bars.findIndex((b) => b.datetime === r.entry_time);
  if (ipoIdx < 0 || entryIdx < 0) { fails.push(`ABSENT ${tag}`); continue; }
  const ipo = bars[ipoIdx], eb = bars[entryIdx], long = r.direction === "demand";
  if (!(near(ipo.open, +r.ipo_open) && near(ipo.high, +r.ipo_high) && near(ipo.low, +r.ipo_low) && near(ipo.close, +r.ipo_close))) {
    fails.push(`IPO_CANDLE_DIFF ${tag}`); continue;
  }
  const pg = ipoGeometry(ipo, long ? "demand" : "supply");
  if (!(near(pg.zoneHigh, +r.zone_high) && near(pg.zoneLow, +r.zone_low) && near(pg.distal, +r.entry_price) && near(pg.extent, +r.s2_price))) {
    fails.push(`ZONE_GEOMETRY_DIFF ${tag}`); continue;
  }
  if (!(long ? eb.low <= +r.entry_price : eb.high >= +r.entry_price)) { fails.push(`ENTRY_BAR_DOES_NOT_REACH ${tag}`); continue; }
  if (entryIdx <= ipoIdx) { fails.push(`ENTRY_NOT_AFTER_IPO ${tag}`); continue; }
  const D = Date.parse(r.m1_entry_time), barOpen = Date.parse(r.entry_time);
  if (!(D >= barOpen && D < barOpen + tfMs)) { fails.push(`FILL_OUTSIDE_TOUCH_BAR ${tag}`); continue; }

  // 1m equivalence: re-derive the frozen runner's three 1m decisions.
  const { bars: m1, t, man, glitch, clamped } = m1For(r.instrument);
  const fx = r.instrument !== "BTC/USD";
  const entry = +r.entry_price, target = +r.target_price, stop = +r.s2_price;
  let ei = -1;
  for (let i = lowerBound(t, barOpen); i < m1.length && t[i] < barOpen + tfMs; i++) {
    if (long ? m1[i].low <= entry : m1[i].high >= entry) { ei = i; break; }
  }
  if (ei < 0 || t[ei] !== D) { fails.push(`M1_FILL_MINUTE_DIFF ${tag} got ${ei < 0 ? "none" : m1[ei].datetime}`); continue; }
  let s2Bar = -1;
  for (let k = entryIdx; k < bars.length; k++) if (long ? bars[k].close < stop : bars[k].close > stop) { s2Bar = k; break; }
  const s2Instant = s2Bar >= 0 ? Date.parse(bars[s2Bar].datetime) + tfMs : Infinity;
  if ((s2Bar >= 0 ? bars[s2Bar].datetime : "") !== r.s2_invalidation_time) { fails.push(`S2_BAR_DIFF ${tag}`); continue; }
  let ti = -1;
  for (let i = ei; i < m1.length && t[i] <= s2Instant; i++) if (long ? m1[i].high >= target : m1[i].low <= target) { ti = i; break; }
  const gotTarget = ti >= 0 && t[ti] + 60_000 <= s2Instant ? m1[ti].datetime : "";
  if (gotTarget !== r.m1_target_time) { fails.push(`M1_TARGET_MINUTE_DIFF ${tag} got ${gotTarget || "none"}`); continue; }
  const reason = r.exit_reason as "TARGET" | "S2_CLOSE_INVALIDATION";
  if ((reason === "TARGET") !== (gotTarget !== "")) { fails.push(`EXIT_REASON_DIFF ${tag}`); continue; }
  const exitMs = exitInstant(r);
  // Coverage: the pre-entry run back from the fill and the whole trade must
  // contain no hole — only short gaps, FX weekends, or gaps a fetched page
  // proved the provider has no bars for.
  let lo = ei;
  while (lo > 0 && ei - lo < M1_LOOKBACK && gapOk(t[lo - 1], t[lo], fx, man)) lo--;
  if (ei - lo < STRUCTURE_BARS) { fails.push(`M1_PRE_COVERAGE ${tag} only ${ei - lo} bars`); continue; }
  if (firstProblem(t, D, exitMs, fx, man) !== null) { fails.push(`M1_TRADE_COVERAGE ${tag}`); continue; }
  const xi = lowerBound(t, exitMs);
  if (glitch.subarray(lo, Math.min(m1.length, xi + 1)).some((x) => x === 1)) { fails.push(`M1_GLITCH_BAR ${tag}`); continue; }
  const clampedInWindow = clamped.subarray(lo, Math.min(m1.length, xi + 1)).reduce((a, x) => a + x, 0);
  if (clampedInWindow) { repairedTrades++; repairedBars += clampedInWindow; }

  const g: Geom = {
    long, proximal: pg.proximal, distal: pg.distal, extent: pg.extent,
    entry, stop, target, risk: +r.risk_price, pip: PIP[r.instrument],
  };
  const pre = preEntryFeatures({
    g, decisionMs: D, touchBarOpenMs: barOpen, tfMs, fillBarOpen: m1[ei].open,
    // CAUSAL: closed 1m bars strictly before the fill minute.
    m1Before: m1.slice(lo, ei),
    ownBetween: bars.slice(ipoIdx + 1, entryIdx),
    ownPrefix: bars.slice(0, entryIdx),
    ipo, costR: +r.cost_r,
  });
  const post = postEntryOutcomes({
    g, decisionMs: D, exitMs, exitReason: reason,
    m1From: m1.slice(ei, Math.min(m1.length, xi + 1)),
    netR: +r.net_r, grossR: +r.gross_r,
    minutesTouchToFill: pre.minutes_from_first_touch_to_fill as number | null,
  });
  rows.push({
    instrument: r.instrument, tf: r.ipo_timeframe, window: r.window, direction: r.direction,
    period: r.entry_time.startsWith("2022") ? "older" : "newer",
    m1_entry_time: r.m1_entry_time, exit_reason: reason, net_r: +r.net_r, pre, post,
    ipoIdx, entryIdx, touchBarClose: eb.close, nextBarClose: bars[entryIdx + 1]?.close ?? null, stop,
    s2Offset: reason === "S2_CLOSE_INVALIDATION" ? s2Bar - entryIdx : null,
  });
}

// ── stats ──────────────────────────────────────────────────────────────────
interface S { n: number; wr: number; avgW: number; avgL: number; exp: number; pf: number; net: number; dd: number }
function stats(rs: Row[]): S | null {
  if (!rs.length) return null;
  const r = rs.map((x) => x.net_r), w = r.filter((x) => x > 0), l = r.filter((x) => x <= 0);
  const chron = [...rs].sort((a, b) => a.m1_entry_time.localeCompare(b.m1_entry_time));
  let eq = 0, pk = 0, dd = 0;
  for (const x of chron) { eq += x.net_r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const sw = w.reduce((a, b) => a + b, 0), sl = l.reduce((a, b) => a + b, 0);
  return { n: r.length, wr: w.length / r.length, avgW: w.length ? sw / w.length : 0, avgL: l.length ? sl / l.length : 0,
    exp: (sw + sl) / r.length, pf: sl < 0 ? sw / -sl : Infinity, net: sw + sl, dd };
}

const ctl = stats(rows)!;
let feq = 0, fpk = 0, fdd = 0;
for (const r of frozen) { feq += +r.net_r; fpk = Math.max(fpk, feq); fdd = Math.max(fdd, fpk - feq); }
const r1 = (x: number) => Math.round(x * 10) / 10, r3 = (x: number) => Math.round(x * 1000) / 1000;
const CONTROL_OK = ctl.n === 1032 && r1(100 * ctl.wr) === 61.5 && r3(ctl.exp) === 0.202 &&
  Math.round(ctl.pf * 100) / 100 === 1.25 && r1(ctl.net) === 208.3 && r1(fdd) === 41.3 && r1(ctl.dd) === 45.6;

console.log("═══ A. CONTROL RECONSTRUCTION ═══");
console.log(`per-trade data + 1m equivalence gate: ${rows.length}/${frozen.length} pass, ${fails.length} fail`);
const failKinds: Record<string, number> = {};
for (const f of fails) failKinds[f.split(" ")[0]] = (failKinds[f.split(" ")[0]] ?? 0) + 1;
console.log("   fail kinds:", JSON.stringify(failKinds));
for (const f of fails.slice(0, 12)) console.log("   " + f);
for (const [inst, c] of m1Cache) console.log(`   1m ${inst}: ${c.bars.length} bars, ${c.clamped.reduce((a, b) => a + b, 0)} open/close clamped, ${c.glitch.reduce((a, b) => a + b, 0)} isolated spikes (anywhere in the cache)`);
console.log(`   trades whose windows hold a clamped bar: ${repairedTrades} (${repairedBars} bars)`);
console.log(`n=${ctl.n} WR=${(100 * ctl.wr).toFixed(1)}% exp=${ctl.exp.toFixed(3)} PF=${ctl.pf.toFixed(2)} net=${ctl.net.toFixed(1)} DD file-order=${fdd.toFixed(1)} chronological=${ctl.dd.toFixed(1)}`);
const GATE_PASS = fails.length === 0 && rows.length === frozen.length && CONTROL_OK;
console.log(`GATE: ${GATE_PASS ? "PASS" : "FAIL — stopping before any entry-quality analysis"}`);
if (!GATE_PASS) Deno.exit(2);

// ── inference ──────────────────────────────────────────────────────────────
let seed = 20261001 >>> 0;               // mulberry32 — exact 32-bit arithmetic
const rand = () => {
  seed = (seed + 0x6D2B79F5) >>> 0; let x = seed;
  x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
function permP(a: number[], b: number[]): number {
  const all = [...a, ...b], k = a.length, obs = Math.abs(mean(a) - mean(b));
  let hits = 0;
  for (let it = 0; it < PERM_ITERS; it++) {
    for (let i = 0; i < k; i++) { const j = i + Math.floor(rand() * (all.length - i)); [all[i], all[j]] = [all[j], all[i]]; }
    if (Math.abs(mean(all.slice(0, k)) - mean(all.slice(k))) >= obs - 1e-12) hits++;
  }
  return (hits + 1) / (PERM_ITERS + 1);
}
function bootCI(r: number[]): [number, number] {
  const ms: number[] = [];
  for (let it = 0; it < BOOT_ITERS; it++) { let s = 0; for (let i = 0; i < r.length; i++) s += r[Math.floor(rand() * r.length)]; ms.push(s / r.length); }
  ms.sort((x, y) => x - y);
  return [ms[Math.floor(0.025 * BOOT_ITERS)], ms[Math.floor(0.975 * BOOT_ITERS)]];
}
/** Average ranks (ties share the mean rank). */
function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(v.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) out[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}
function pearson(a: number[], b: number[]): number {
  const ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da > 0 && db > 0 ? n / Math.sqrt(da * db) : 0;
}
const spearman = (x: number[], y: number[]) => pearson(ranks(x), ranks(y));
function spearmanP(x: number[], y: number[]): [number, number] {
  const rx = ranks(x), ry = ranks(y), obs = Math.abs(pearson(rx, ry)), sh = [...ry];
  let hits = 0;
  for (let it = 0; it < PERM_ITERS; it++) {
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    if (Math.abs(pearson(rx, sh)) >= obs - 1e-12) hits++;
  }
  return [pearson(rx, ry), (hits + 1) / (PERM_ITERS + 1)];
}

const SLICES: Array<[string, (r: Row) => boolean]> = [
  ["EUR/USD", (r) => r.instrument === "EUR/USD"], ["USD/JPY", (r) => r.instrument === "USD/JPY"],
  ["BTC/USD", (r) => r.instrument === "BTC/USD"],
  ["1H", (r) => r.tf === "1h"], ["4H", (r) => r.tf === "4h"],
  ["Older (2022)", (r) => r.period === "older"], ["Newer (2025)", (r) => r.period === "newer"],
];
const label = (sign: number, eff: Record<string, number | null>, ns: Record<string, number>) => {
  const evalS = SLICES.map(([nm]) => nm).filter((nm) => ns[nm] >= SLICE_MIN_N && eff[nm] !== null);
  if (evalS.length < MIN_EVALUABLE_SLICES) return "TOO_SMALL";
  const opp = evalS.filter((nm) => Math.sign(eff[nm]!) !== sign);
  if (opp.some((nm) => ns[nm] >= SLICE_REVERSE_N)) return "REVERSES";
  return opp.length === 0 ? "STABLE" : "MIXED";
};

interface Test {
  kind: "COHORT" | "TREND"; family: string; group: string; name: string; feature: string;
  n: number; s: S | null; restN: number; diff: number | null; rho: number | null; q5q1: number | null;
  p: number | null; holm: number | null; bh: number | null; ci: [number, number] | null;
  eff: Record<string, number | null>; ns: Record<string, number>; label: string; candidate: boolean; note: string;
}
const preView = rows.map((r) => pickPre(r.pre as unknown as Record<string, unknown>));   // FIREWALL: cohorts see this only
const tests: Test[] = [];

for (const c of PRE_COHORTS) {
  const mask = preView.map((p) => c.test(p[c.feature]));
  const inn = rows.filter((_, i) => mask[i]), rest = rows.filter((_, i) => !mask[i]);
  const diff = inn.length && rest.length ? mean(inn.map((r) => r.net_r)) - mean(rest.map((r) => r.net_r)) : null;
  const p = inn.length >= 2 && rest.length >= 2 ? permP(inn.map((r) => r.net_r), rest.map((r) => r.net_r)) : null;
  const eff: Record<string, number | null> = {}, ns: Record<string, number> = {};
  for (const [nm, sf] of SLICES) {
    const a = rows.filter((r, i) => sf(r) && mask[i]), b = rows.filter((r, i) => sf(r) && !mask[i]);
    ns[nm] = a.length;
    eff[nm] = a.length && b.length ? mean(a.map((r) => r.net_r)) - mean(b.map((r) => r.net_r)) : null;
  }
  tests.push({ kind: "COHORT", family: c.family, group: c.group, name: c.name, feature: c.feature, n: inn.length,
    s: stats(inn), restN: rest.length, diff, rho: null, q5q1: null, p, holm: null, bh: null,
    ci: inn.length >= 2 ? bootCI(inn.map((r) => r.net_r)) : null, eff, ns, label: "", candidate: false,
    note: rest.length === 0 ? "DEGENERATE: every trade is in this cohort" : inn.length === 0 ? "EMPTY" : "" });
}

const deciles: Array<{ feature: string; bucket: string; lo: number; hi: number; n: number; exp: number; wr: number }> = [];
for (const f of TREND_FEATURES) {
  const idx = preView.map((p, i) => [p[f], i] as const).filter(([v]) => typeof v === "number" && Number.isFinite(v)) as Array<readonly [number, number]>;
  const x = idx.map(([v]) => v), y = idx.map(([, i]) => rows[i].net_r);
  const distinct = new Set(x).size;
  const [rho, p] = x.length >= 30 && distinct > 1 ? spearmanP(x, y) : [null, null];
  // deciles (or distinct values when <= 10), ordered by value, ties by time
  const ord = [...idx].sort((a, b) => a[0] - b[0] || rows[a[1]].m1_entry_time.localeCompare(rows[b[1]].m1_entry_time));
  let q5q1: number | null = null;
  if (distinct <= 10) {
    for (const v of [...new Set(x)].sort((a, b) => a - b)) {
      const g = ord.filter(([w]) => w === v).map(([, i]) => rows[i]);
      deciles.push({ feature: f, bucket: `= ${v}`, lo: v, hi: v, n: g.length, exp: mean(g.map((r) => r.net_r)), wr: g.filter((r) => r.net_r > 0).length / g.length });
    }
  } else {
    const nb = ord.length >= 100 ? 10 : 5;
    for (let d = 0; d < nb; d++) {
      const g = ord.slice(Math.floor((d * ord.length) / nb), Math.floor(((d + 1) * ord.length) / nb));
      deciles.push({ feature: f, bucket: `D${d + 1}/${nb}`, lo: g[0][0], hi: g[g.length - 1][0], n: g.length,
        exp: mean(g.map(([, i]) => rows[i].net_r)), wr: g.filter(([, i]) => rows[i].net_r > 0).length / g.length });
    }
    const q = Math.floor(ord.length / 5);
    q5q1 = mean(ord.slice(-q).map(([, i]) => rows[i].net_r)) - mean(ord.slice(0, q).map(([, i]) => rows[i].net_r));
  }
  const eff: Record<string, number | null> = {}, ns: Record<string, number> = {};
  for (const [nm, sf] of SLICES) {
    const sub = idx.filter(([, i]) => sf(rows[i]));
    ns[nm] = sub.length;
    eff[nm] = sub.length >= 3 && new Set(sub.map(([v]) => v)).size > 1 ? spearman(sub.map(([v]) => v), sub.map(([, i]) => rows[i].net_r)) : null;
  }
  tests.push({ kind: "TREND", family: "trend", group: "Spearman(feature, net R)", name: f, feature: f, n: x.length,
    s: null, restN: 0, diff: null, rho, q5q1, p, holm: null, bh: null, ci: null, eff, ns, label: "", candidate: false,
    note: distinct <= 10 ? `${distinct} distinct values: value table instead of deciles; not eligible via trend` : "" });
}

// Holm and Benjamini-Hochberg across ALL pre-entry tests (one family)
const tested = tests.filter((x) => x.p !== null).sort((a, b) => a.p! - b.p!);
const mT = tested.length;
let run = 0;
tested.forEach((x, i) => { run = Math.max(run, Math.min(1, x.p! * (mT - i))); x.holm = run; });
let minQ = 1;
for (let i = mT - 1; i >= 0; i--) { minQ = Math.min(minQ, (tested[i].p! * mT) / (i + 1)); tested[i].bh = Math.min(1, minQ); }

// stability labels + frozen candidate rules
for (const x of tests) {
  const effect = x.kind === "COHORT" ? x.diff : x.rho;
  if (effect === null || x.n < 30 || (x.kind === "COHORT" && x.restN < 30)) { x.label = "TOO_SMALL"; continue; }
  x.label = label(Math.sign(effect), x.eff, x.ns);
  if (x.kind === "COHORT") {
    x.candidate = x.n >= CAND_MIN_N && x.restN >= CAND_MIN_N && Math.abs(x.diff!) >= CAND_MIN_DIFF &&
      x.label === "STABLE" && x.bh !== null && x.bh <= CAND_MAX_BH_Q;
  } else {
    x.candidate = x.q5q1 !== null && Math.sign(x.q5q1) === Math.sign(x.rho!) && Math.abs(x.q5q1) >= CAND_MIN_DIFF &&
      x.label === "STABLE" && x.bh !== null && x.bh <= CAND_MAX_BH_Q;
  }
}

// ── management research (POST-ENTRY ONLY — never an entry feature) ─────────
type Mg = { finding: string; a: string; an: number; av: number; b: string; bn: number; bv: number; metric: string; p: number | null };
const mgmt: Mg[] = [];
const P = (r: Row, k: string) => r.post[k as keyof PostOutcomes] as number;
const winners = rows.filter((r) => r.net_r > 0), losers = rows.filter((r) => r.net_r <= 0);
const share = (rs: Row[], f: (r: Row) => boolean) => rs.filter(f).length / rs.length;
for (const h of EARLY_HORIZONS) {
  const f = (r: Row) => P(r, `mae_first_${h}m`) >= 0.5;
  mgmt.push({ finding: `reached -0.5R within ${h}m`, a: "losers", an: losers.length, av: share(losers, f), b: "winners", bn: winners.length, bv: share(winners, f), metric: "share", p: null });
}
for (const h of EARLY_HORIZONS) {
  const f = (r: Row) => P(r, `mfe_first_${h}m`) >= 0.25;
  const a = rows.filter((r) => !f(r)), b = rows.filter(f);
  mgmt.push({ finding: `failed to reach +0.25R within ${h}m`, a: "did not reach", an: a.length, av: mean(a.map((r) => r.net_r)),
    b: "reached", bn: b.length, bv: mean(b.map((r) => r.net_r)), metric: "expectancy R", p: permP(a.map((r) => r.net_r), b.map((r) => r.net_r)) });
}
for (const h of EARLY_HORIZONS) {
  const f = (r: Row) => P(r, `mae_first_${h}m`) >= 0.5;
  const a = rows.filter(f), b = rows.filter((r) => !f(r));
  mgmt.push({ finding: `early MAE >= 0.5R within ${h}m`, a: "early MAE >= 0.5R", an: a.length, av: mean(a.map((r) => r.net_r)),
    b: "not", bn: b.length, bv: mean(b.map((r) => r.net_r)), metric: "expectancy R", p: permP(a.map((r) => r.net_r), b.map((r) => r.net_r)) });
  mgmt.push({ finding: `early MAE >= 0.5R within ${h}m, then TARGET`, a: "recovered to target", an: a.filter((r) => r.exit_reason === "TARGET").length,
    av: share(a, (r) => r.exit_reason === "TARGET"), b: "rest of book", bn: b.length, bv: share(b, (r) => r.exit_reason === "TARGET"), metric: "target share", p: null });
}
for (const lv of [0.5, 1, 1.5]) {
  mgmt.push({ finding: `losers that first reached +${lv}R (give-back)`, a: "losers", an: losers.length, av: share(losers, (r) => r.post[`reached_${lv}r` as keyof PostOutcomes] === true),
    b: "winners", bn: winners.length, bv: share(winners, (r) => r.post[`reached_${lv}r` as keyof PostOutcomes] === true), metric: "share", p: null });
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
mgmt.push({ finding: "median minutes fill -> MFE peak", a: "winners", an: winners.length, av: median(winners.map((r) => P(r, "minutes_to_mfe"))),
  b: "losers", bn: losers.length, bv: median(losers.map((r) => P(r, "minutes_to_mfe"))), metric: "minutes", p: null });
mgmt.push({ finding: "median minutes fill -> MAE peak", a: "winners", an: winners.length, av: median(winners.map((r) => P(r, "minutes_to_mae"))),
  b: "losers", bn: losers.length, bv: median(losers.map((r) => P(r, "minutes_to_mae"))), metric: "minutes", p: null });
mgmt.push({ finding: "median MAE (R)", a: "winners", an: winners.length, av: median(winners.map((r) => P(r, "mae_r"))),
  b: "losers", bn: losers.length, bv: median(losers.map((r) => P(r, "mae_r"))), metric: "R", p: null });
mgmt.push({ finding: "median MFE (R)", a: "winners", an: winners.length, av: median(winners.map((r) => P(r, "mfe_r"))),
  b: "losers", bn: losers.length, bv: median(losers.map((r) => P(r, "mfe_r"))), metric: "R", p: null });

// ── POST-HOC (added after the first run; NONE of this can create a candidate) ─
//
// 1. ROBUSTNESS. 20 TARGET trades hit the target inside the fill minute. The
//    frozen runner searches for the target from the fill minute inclusive, but
//    1m cannot say whether that minute's extreme came before or after the fill.
// 2. TREND STATISTIC. The frozen Spearman(feature, net R) is mechanically
//    confounded: every TARGET trade nets 2 - cost_R and cost_R spans 0.008-3.0,
//    so ranking by net R orders the winners purely by cost, i.e. by risk size.
//    Replacement shown alongside: Pearson(rank(feature), net R), permutation p.
// 3. TOUCHES SINCE VALIDATION. The frozen touch count started at the IPO candle,
//    but production only tracks a zone from `validAt` (ipoLifecycle.ts). Touches
//    are re-counted from the production lifecycle record, using its own touch
//    list strictly before the touch bar.
// 4. BASELINE SELECTION. runLifecycle checks invalidation (a close beyond the
//    IPO extreme) BEFORE the touch, so a touch bar that closes beyond the stop is
//    never a touch and is never entered — although the fill is intrabar, before
//    that close exists. Measured here as evidence; the baseline is not changed.
const sameMinute = (r: Row) => r.exit_reason === "TARGET" && r.post.minutes_to_mfe === 0;
interface PostHoc { section: string; name: string; n: number; restN: number; a: number; b: number; diff: number; p: number | null; note: string }
const posthoc: PostHoc[] = [];
const cohortOn = (pop: Row[], fn: (r: Row) => boolean, section: string, name: string, note = "") => {
  const a = pop.filter(fn), b = pop.filter((r) => !fn(r));
  const ma = a.length ? mean(a.map((r) => r.net_r)) : NaN, mb = b.length ? mean(b.map((r) => r.net_r)) : NaN;
  posthoc.push({ section, name, n: a.length, restN: b.length, a: ma, b: mb, diff: ma - mb,
    p: a.length >= 2 && b.length >= 2 ? permP(a.map((r) => r.net_r), b.map((r) => r.net_r)) : null, note });
};
// 1. robustness: every frozen cohort re-tested without the same-minute targets
const clean = rows.filter((r) => !sameMinute(r));
for (const c of PRE_COHORTS) {
  const inC = new Set(rows.filter((_, i) => c.test(preView[i][c.feature])));
  cohortOn(clean, (r) => inC.has(r), "ROBUSTNESS: without the 20 same-minute targets", c.name,
    `${rows.filter((r) => inC.has(r) && sameMinute(r)).length} same-minute targets removed from this cohort`);
}
// 2. replacement trend statistic
const trendPH: Array<{ feature: string; n: number; r: number; p: number; eff: Record<string, number | null> }> = [];
for (const f of TREND_FEATURES) {
  const idx = preView.map((p, i) => [p[f], i] as const).filter(([v]) => typeof v === "number" && Number.isFinite(v)) as Array<readonly [number, number]>;
  if (idx.length < 30 || new Set(idx.map(([v]) => v)).size < 2) continue;
  const rx = ranks(idx.map(([v]) => v)), y = idx.map(([, i]) => rows[i].net_r), obs = pearson(rx, y), sh = [...y];
  let hits = 0;
  for (let it = 0; it < PERM_ITERS; it++) {
    for (let i = sh.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    if (Math.abs(pearson(rx, sh)) >= Math.abs(obs) - 1e-12) hits++;
  }
  const eff: Record<string, number | null> = {};
  for (const [nm, sf] of SLICES) {
    const sub = idx.filter(([, i]) => sf(rows[i]));
    eff[nm] = sub.length >= 15 && new Set(sub.map(([v]) => v)).size > 1 ? pearson(ranks(sub.map(([v]) => v)), sub.map(([, i]) => rows[i].net_r)) : null;
  }
  trendPH.push({ feature: f, n: idx.length, r: obs, p: (hits + 1) / (PERM_ITERS + 1), eff });
}
// 3. touches since validation, from the production lifecycle
const lifeBySeries = new Map<string, LifecycleIPO[]>();
const lifeFor = (r: Row) => {
  const k = `${r.window}|${r.tf}`;
  if (!lifeBySeries.has(k)) { const b = series(r.window, r.tf); lifeBySeries.set(k, runLifecycle(b, episodesFor(b))); }
  return lifeBySeries.get(k)!;
};
const touchPH = new Map<Row, { validAt: number; before: number; barsSinceValid: number; inEngineTouches: boolean }>();
for (const r of rows) {
  const rec = lifeFor(r).find((x) => x.candidateIndex === r.ipoIdx && x.direction === r.direction && x.validAt !== null);
  if (!rec || rec.validAt! >= r.entryIdx) continue;
  touchPH.set(r, { validAt: rec.validAt!, before: rec.touches.filter((t) => t < r.entryIdx).length,
    barsSinceValid: r.entryIdx - rec.validAt!, inEngineTouches: rec.touches.includes(r.entryIdx) });
}
// prefix-stability check on a fixed sample: the full-series record must equal the engine's prefix view
let stableChecked = 0, stableSame = 0;
{
  const sample = [...touchPH.keys()].map((r) => ({ r, u: rand() })).sort((a, b) => a.u - b.u).slice(0, 30).map((x) => x.r);
  for (const r of sample) {
    const pre = series(r.window, r.tf).slice(0, r.entryIdx + 1);
    const rec = runLifecycle(pre, episodesFor(pre)).find((x) => x.candidateIndex === r.ipoIdx && x.direction === r.direction && x.validAt !== null);
    const full = touchPH.get(r)!;
    stableChecked++;
    if (rec && rec.validAt === full.validAt && rec.touches.filter((t) => t < r.entryIdx).length === full.before) stableSame++;
  }
}
const touchRows = rows.filter((r) => touchPH.has(r));
cohortOn(touchRows, (r) => touchPH.get(r)!.before === 0, "POST-HOC: touches since validation (production lifecycle)", "FIRST TOUCH SINCE VALIDATION");
cohortOn(touchRows, (r) => touchPH.get(r)!.before >= 3, "POST-HOC: touches since validation (production lifecycle)", "3+ PRIOR TOUCHES SINCE VALIDATION");
// 4. baseline selection evidence
const s2Off: Record<string, number> = {};
for (const r of rows) if (r.s2Offset !== null) { const k = r.s2Offset >= 6 ? "6+" : String(r.s2Offset); s2Off[k] = (s2Off[k] ?? 0) + 1; }
const beyond = (r: Row, c: number | null) => c !== null && (r.direction === "demand" ? c < r.stop : c > r.stop);
const touchBeyond = rows.filter((r) => beyond(r, r.touchBarClose)).length, nextBeyond = rows.filter((r) => beyond(r, r.nextBarClose)).length;

// ── outputs ────────────────────────────────────────────────────────────────
await Deno.mkdir(CACHE_OUT, { recursive: true });
const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : typeof v === "number" ? String(+v.toPrecision(10)) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const f3 = (x: number | null | undefined) => x === null || x === undefined || !Number.isFinite(x) ? "" : (x >= 0 ? "+" : "") + x.toFixed(3);
const warn = (n: number) => n < 15 ? "TOO SMALL" : n < 30 ? "SMALL" : "";
const meta = ["instrument", "tf", "window", "direction", "period", "m1_entry_time", "exit_reason"] as const;

// trade-level CSV: meta, then pre__ (decision-time) and post__ (outcome) columns
{
  const cols = [...meta, ...PRE_ENTRY_FEATURES.map((k) => `pre__${k}`), ...POST_ENTRY_OUTCOMES.map((k) => `post__${k}`)];
  const lines = [cols.join(",")];
  for (const r of rows) lines.push([...meta.map((k) => r[k]), ...PRE_ENTRY_FEATURES.map((k) => r.pre[k]), ...POST_ENTRY_OUTCOMES.map((k) => r.post[k])].map(esc).join(","));
  await Deno.writeTextFile(new URL("ipo_entry_quality_telemetry_v1.csv", OUT), lines.join("\n") + "\n");
}
// MAE/MFE CSV
{
  const cols = [...meta, "net_r", ...POST_ENTRY_OUTCOMES.filter((k) => k !== "net_r")];
  const lines = [cols.join(",")];
  for (const r of rows) lines.push([...meta.map((k) => r[k]), r.net_r, ...POST_ENTRY_OUTCOMES.filter((k) => k !== "net_r").map((k) => r.post[k])].map(esc).join(","));
  await Deno.writeTextFile(new URL("ipo_entry_quality_mae_mfe_v1.csv", OUT), lines.join("\n") + "\n");
}
// cohorts CSV: cohort tests, trend tests, deciles, management
{
  const cols = ["section", "kind", "family", "group", "name", "feature", "n", "sample_warning", "win_rate", "expectancy_r", "profit_factor",
    "net_r", "chron_dd_r", "diff_vs_rest_r", "spearman_rho", "q5_minus_q1_r", "raw_p", "holm_p", "bh_q", "ci95_lo", "ci95_hi", "stability", "candidate", "note"];
  const lines = [cols.join(",")];
  for (const x of tests) lines.push(["PRE_ENTRY_TEST", x.kind, x.family, x.group, x.name, x.feature, x.n, warn(x.n),
    x.s ? x.s.wr.toFixed(4) : "", x.s ? x.s.exp.toFixed(4) : "", x.s ? (Number.isFinite(x.s.pf) ? x.s.pf.toFixed(3) : "inf") : "",
    x.s ? x.s.net.toFixed(2) : "", x.s ? x.s.dd.toFixed(2) : "", x.diff?.toFixed(4) ?? "", x.rho?.toFixed(4) ?? "", x.q5q1?.toFixed(4) ?? "",
    x.p?.toFixed(4) ?? "", x.holm?.toFixed(4) ?? "", x.bh?.toFixed(4) ?? "", x.ci?.[0].toFixed(4) ?? "", x.ci?.[1].toFixed(4) ?? "",
    x.label, x.candidate, x.note].map(esc).join(","));
  for (const d of deciles) lines.push(["PRE_ENTRY_DECILE", "DECILE", "trend", `${d.lo} .. ${d.hi}`, d.bucket, d.feature, d.n, warn(d.n),
    d.wr.toFixed(4), d.exp.toFixed(4), "", "", "", "", "", "", "", "", "", "", "", "descriptive", "", ""].map(esc).join(","));
  for (const g of mgmt) lines.push(["MANAGEMENT RESEARCH SIGNAL ONLY", "POST_ENTRY", "", g.metric, g.finding, `${g.a} vs ${g.b}`,
    `${g.an}/${g.bn}`, warn(Math.min(g.an, g.bn)), "", `${g.av.toFixed(4)} vs ${g.bv.toFixed(4)}`, "", "", "", (g.av - g.bv).toFixed(4), "", "",
    g.p?.toFixed(4) ?? "", "", "", "", "", "", "", "post-entry information; not an entry feature"].map(esc).join(","));
  for (const x of posthoc) lines.push([x.section, "POST_HOC", "", "", x.name, "", `${x.n}/${x.restN}`, warn(x.n), "", x.a.toFixed(4), "", "", "",
    x.diff.toFixed(4), "", "", x.p?.toFixed(4) ?? "", "", "", "", "", "", "not eligible", x.note].map(esc).join(","));
  for (const x of trendPH) lines.push(["POST-HOC TREND: Pearson(rank(feature), net R)", "POST_HOC", "trend", "", x.feature, x.feature, x.n, "", "", "", "", "", "",
    "", x.r.toFixed(4), "", x.p.toFixed(4), "", "", "", "", SLICES.map(([nm]) => `${nm} ${x.eff[nm]?.toFixed(3) ?? "-"}`).join("; "), "not eligible", "replaces the cost-confounded frozen Spearman"].map(esc).join(","));
  await Deno.writeTextFile(new URL("ipo_entry_quality_cohorts_v1.csv", OUT), lines.join("\n") + "\n");
}
// stability CSV
{
  const cols = ["kind", "name", "combined_n", "combined_effect", ...SLICES.flatMap(([n]) => [`${n} n`, `${n} effect`]), "label"];
  const lines = [cols.join(",")];
  for (const x of tests) lines.push([x.kind, x.name, x.n, (x.kind === "COHORT" ? x.diff : x.rho)?.toFixed(4) ?? "",
    ...SLICES.flatMap(([n]) => [x.ns[n], x.eff[n]?.toFixed(4) ?? ""]), x.label].map(esc).join(","));
  await Deno.writeTextFile(new URL("ipo_entry_quality_stability_v1.csv", OUT), lines.join("\n") + "\n");
}

// markdown tables + descriptive facts for the report
const md: string[] = [];
const fq = (rs: Row[], k: string, v: unknown) => rs.filter((r) => (r.pre as Record<string, unknown>)[k] === v).length;
md.push(`control n=${ctl.n} WR=${(100 * ctl.wr).toFixed(1)}% exp=${f3(ctl.exp)} PF=${ctl.pf.toFixed(2)} net=${ctl.net.toFixed(1)} DD file=${fdd.toFixed(1)} chron=${ctl.dd.toFixed(1)}`);
md.push(`fill_depth_pct_of_zone distinct: ${[...new Set(rows.map((r) => (r.pre.fill_depth_pct_of_zone as number).toFixed(6)))].join(",")}`);
md.push(`zone_width_to_risk distinct: ${[...new Set(rows.map((r) => (r.pre.zone_width_to_risk_ratio as number).toFixed(6)))].join(",")}`);
md.push(`planned_r distinct: ${[...new Set(rows.map((r) => (r.pre.planned_r as number).toFixed(6)))].join(",")}`);
md.push(`fill_bar_opened_through_entry: ${fq(rows, "fill_bar_opened_through_entry", true)}`);
md.push(`visit began before 1m window (ttf null): ${rows.filter((r) => r.pre.minutes_from_first_touch_to_fill === null).length}`);
md.push(`prior_visit_max_depth > 100: ${rows.filter((r) => (r.pre.prior_visit_max_depth_pct as number) > 100).length}`);
md.push(`target minute == fill minute: ${rows.filter((r) => r.exit_reason === "TARGET" && r.post.minutes_to_mfe === 0).length}`);
md.push(`m1 bars before fill: min ${Math.min(...rows.map((r) => r.pre.m1_bars_before_fill as number))}`);
for (const k of ["first_touch_trade", "sweep_present", "micro_choch_before_fill", "displacement_favorable", "displacement_adverse",
  "engulfing_before_fill", "last_bar_rejection_wick", "favorable_close_from_zone", "last_choch_direction_aligned"]) {
  md.push(`${k}: true ${fq(rows, k, true)} / false ${fq(rows, k, false)} / null ${fq(rows, k, null)}`);
}
md.push("", "| kind | family | name | n | warn | WR | exp | diff/rho | Q5-Q1 | p | Holm | BH | CI | " + SLICES.map(([n]) => n).join(" | ") + " | label | cand |");
md.push("|" + "---|".repeat(14 + SLICES.length + 1));
for (const x of tests) md.push(`| ${x.kind} | ${x.family} | ${x.name} | ${x.n} | ${warn(x.n)} | ${x.s ? (100 * x.s.wr).toFixed(1) + "%" : ""} | ${f3(x.s?.exp)} | ${f3(x.kind === "COHORT" ? x.diff : x.rho)} | ${f3(x.q5q1)} | ${x.p?.toFixed(3) ?? ""} | ${x.holm?.toFixed(3) ?? ""} | ${x.bh?.toFixed(3) ?? ""} | ${x.ci ? `[${f3(x.ci[0])}, ${f3(x.ci[1])}]` : ""} | ` +
  SLICES.map(([n]) => `${f3(x.eff[n])} (${x.ns[n]})`).join(" | ") + ` | ${x.label} | ${x.candidate ? "YES" : ""} |`);
md.push("", "deciles:");
for (const d of deciles) md.push(`${d.feature} ${d.bucket} [${+d.lo.toPrecision(5)}..${+d.hi.toPrecision(5)}] n=${d.n} exp=${f3(d.exp)} WR=${(100 * d.wr).toFixed(1)}%`);
md.push("", "management:");
for (const g of mgmt) md.push(`${g.finding}: ${g.a} ${g.av.toFixed(3)} (n ${g.an}) vs ${g.b} ${g.bv.toFixed(3)} (n ${g.bn}) [${g.metric}] p=${g.p?.toFixed(4) ?? "-"}`);
// MAE/MFE summary by outcome
for (const [nm, rs] of [["winners", winners], ["losers", losers]] as const) {
  md.push(`${nm}: n ${rs.length} | mean MAE ${mean(rs.map((r) => P(r, "mae_r"))).toFixed(3)} | mean MFE ${mean(rs.map((r) => P(r, "mfe_r"))).toFixed(3)} | ` +
    R_LEVELS.map((lv) => `reached ${lv}R ${(100 * share(rs, (r) => r.post[`reached_${lv}r` as keyof PostOutcomes] === true)).toFixed(1)}%`).join(" | ") + " | " +
    EARLY_HORIZONS.map((h) => `MAE${h}m ${mean(rs.map((r) => P(r, `mae_first_${h}m`))).toFixed(3)} MFE${h}m ${mean(rs.map((r) => P(r, `mfe_first_${h}m`))).toFixed(3)}`).join(" | "));
}
md.push("", "POST-HOC (not eligible):");
for (const x of posthoc) md.push(`${x.section} | ${x.name} | n ${x.n} vs ${x.restN} | ${f3(x.a)} vs ${f3(x.b)} | diff ${f3(x.diff)} | p ${x.p?.toFixed(4) ?? "-"} | ${x.note}`);
for (const x of trendPH) md.push(`POST-HOC TREND ${x.feature} n ${x.n} r ${f3(x.r)} p ${x.p.toFixed(4)} | ` + SLICES.map(([nm]) => `${nm} ${f3(x.eff[nm])}`).join(" | "));
md.push(`touches since validation: ${touchPH.size}/${rows.length} trades have a production lifecycle record validated before the touch bar; touch bar in the engine's own touch list: ${[...touchPH.values()].filter((x) => x.inEngineTouches).length}; prefix-stability sample ${stableSame}/${stableChecked} identical`);
{
  const d: Record<string, number> = {}; for (const v of touchPH.values()) { const k = v.before >= 5 ? "5+" : String(v.before); d[k] = (d[k] ?? 0) + 1; }
  md.push(`prior touches since validation distribution: ${JSON.stringify(d)}`);
}
md.push(`BASELINE SELECTION: S2 exits by bar offset from touch bar ${JSON.stringify(s2Off)}; touch bar closed beyond stop ${touchBeyond}/${rows.length}; next bar closed beyond stop ${nextBeyond}/${rows.length}`);
md.push(`same-minute targets: ${rows.filter(sameMinute).length}`);
await Deno.writeTextFile(new URL("tables.md", CACHE_OUT), md.join("\n") + "\n");

// console summary
console.log(`\n═══ PRE-ENTRY TESTS: ${mT} in one correction family ═══`);
for (const x of [...tested].slice(0, 12)) {
  console.log(`  ${x.kind.padEnd(6)} ${x.name.padEnd(44)} n=${String(x.n).padStart(4)} eff=${f3(x.kind === "COHORT" ? x.diff : x.rho)} p=${x.p!.toFixed(4)} holm=${x.holm!.toFixed(3)} bh=${x.bh!.toFixed(3)} ${x.label}${x.candidate ? " CANDIDATE" : ""}`);
}
const cands = tests.filter((x) => x.candidate);
console.log(`\ncandidates: ${cands.length ? cands.map((x) => x.name).join("; ") : "none"}`);
console.log(`tables -> ${new URL("tables.md", CACHE_OUT).pathname}`);
