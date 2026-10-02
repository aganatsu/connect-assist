/**
 * IPO_TTM_SQUEEZE_TELEMETRY_V1 — research telemetry, NOT a strategy test.
 *
 * Question: does TTM Squeeze state known BEFORE an IPO entry separate stronger
 * and weaker trades in the frozen IPO_BASELINE_1H_4H_CAUSAL_V1 control?
 *
 * NOTHING IS FILTERED. The control is the committed trade list
 * (docs/exports/ipo_1h_4h_combined_clean.csv) exactly as frozen: same 1,032
 * trades, same 1m-resolved exits, same net R. TTM is attached as telemetry.
 * The IPO engine, geometry, S2, costs, ordering and the one-slot rule are
 * untouched — not even re-run.
 *
 * ── WHY THE FROZEN TRADES ARE TAGGED RATHER THAN RE-SELECTED ───────────────
 * The frozen run's inputs lived in /tmp and are gone, and the script that wrote
 * its 1H/4H series was never committed. A re-run of the exact ARM C loop on
 * re-fetched bars (`--reconstruct`) re-selected 1,011 of 1,032 trades
 * exactly, missing 16 and adding 6. Diagnosed, 2026-10-01:
 *   - DATA IS IDENTICAL: all 1,032 frozen IPO candles are byte-identical in
 *     the re-fetched series.
 *   - THE DIFFERENCE IS THE DECISION START. The frozen scope began at the first
 *     1m bar, set by backward 1m paging; it cannot be recovered without
 *     re-fetching ~220 1m pages on the API key production shares. The anchor
 *     available lands 1-2 days late in 5 windows, dropping 18 early frozen
 *     trades as warm-up and shifting the one-slot state, which produces the
 *     paired shifts (e.g. BTC 1H entry 112474.31 at 22:00 frozen, 20:00 re-run).
 * TTM for a trade needs only the bars strictly before its entry bar, and those
 * are proven identical, so the frozen trades were tagged directly (decided by
 * the user, 2026-10-01).
 *
 * ── DATA-EQUIVALENCE GATE (every trade, not a sample) ──────────────────────
 * For each frozen trade: its IPO candle must be byte-identical in the
 * re-fetched series, and its entry bar must exist and reach the frozen entry
 * price. Any failure stops the study.
 *
 * ── CAUSALITY ──────────────────────────────────────────────────────────────
 * TTM is computed from series.slice(0, entryBarIndex): the bars strictly
 * before the IPO touch bar — the engine's own `barsBefore` prefix. The touch
 * bar is still forming when the resting order fills, so it is never read.
 * EMA/RMA warm-up is thousands of bars, so the series start has no effect
 * (residual below 1e-9).
 *
 *   deno run --allow-read --allow-write local-runner/ipo-ttm-telemetry.ts
 */

import { IncrementalEngine } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import type { LiveTrade } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { WINDOWS } from "./ipo-bos-fetch.ts";
import { CACHE, SPECS } from "./ipo-ttm-fetch.ts";
import { ttmAtDecision, squeezePhase, type TtmTelemetry, type SqueezePhase } from "./ttmSqueeze.ts";

const WARMUP = 400;                 // ipo-tf-baseline.ts
const MAX_BARS = 1800;              // ipo-m1-fetch.ts
const BAR_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000 };
const EXPORT = new URL("../docs/exports/ipo_1h_4h_combined_clean.csv", import.meta.url);
const OUT_DIR = new URL("../docs/exports/", import.meta.url);
const INSTRUMENT_MONTHS = 31.5;     // frozen corpus, commit 784aab32

const readJson = <T>(name: string): T => JSON.parse(Deno.readTextFileSync(new URL(name, CACHE)));

// ── frozen export ───────────────────────────────────────────────────────────

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n");
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const out: Record<string, string> = {}; const cells: string[] = [];
    let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') q = !q; else if (ch === "," && !q) { cells.push(cur); cur = ""; } else cur += ch;
    }
    cells.push(cur);
    head.forEach((h, i) => out[h] = cells[i] ?? "");
    return out;
  });
}
const frozen = parseCsv(Deno.readTextFileSync(EXPORT));
const keyOf = (inst: string, tf: string, entryTime: string, entry: number) =>
  `${inst}|${tf}|${entryTime}|${Number(entry).toPrecision(10)}`;
const frozenByKey = new Map(frozen.map((r) => [keyOf(r.instrument, r.ipo_timeframe, r.entry_time, +r.entry_price), r]));

// ── ARM C replica ───────────────────────────────────────────────────────────

interface Selected { spec: typeof SPECS[number]; tf: "1h" | "4h"; t: LiveTrade; bars: Candle[] }

function decisionStartMs(spec: typeof SPECS[number]): number {
  // ipo-m1-fetch: fromMs = first of the last 1,800 bos-window bars; the 1m
  // file began at the oldest minute of the page that crossed it, i.e. at or
  // just before fromMs. Same day-level anchor; verified by the gate below.
  const w = WINDOWS.find((x) => x.id === spec.m1)!;
  const bos = readJson<Candle[]>(`bos_${w.id}_${w.tf}.json`).slice(-MAX_BARS);
  return Date.parse(bos[0].datetime);
}

function runArmC(spec: typeof SPECS[number], decStart: number): { sel: Selected[]; series: Record<string, Candle[]> } {
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === spec.inst)!;
  const series: Record<string, Candle[]> = {};
  for (const tf of ["1h", "4h"]) {
    const full = readJson<Candle[]>(`${spec.inst.replace("/", "")}_${spec.end}_${tf}.json`);
    const startIdx = Math.max(0, full.findIndex((c) => Date.parse(c.datetime) >= decStart) - WARMUP);
    series[tf] = full.slice(startIdx);
  }
  const slot = { by: null as null | "1h" | "4h" };
  const eng: Record<string, IncrementalEngine> = {};
  for (const tf of ["1h", "4h"]) {
    eng[tf] = new IncrementalEngine({
      instrument: inst.instrument, timeframe: tf,
      highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide,
      entryGate: () => slot.by === null || slot.by === tf,
    });
  }
  type Ev = { tf: "1h" | "4h"; bar: Candle; close: number };
  const evs: Ev[] = [];
  for (const tf of ["1h", "4h"] as const) for (const b of series[tf]) evs.push({ tf, bar: b, close: Date.parse(b.datetime) + BAR_MS[tf] });
  evs.sort((a, b) => a.close - b.close || (a.tf === "1h" ? -1 : 1));
  for (const ev of evs) {
    const before = eng[ev.tf].openTrade;
    eng[ev.tf].feed(ev.bar);
    const after = eng[ev.tf].openTrade;
    if (after && slot.by === null) slot.by = ev.tf;
    if (!after && before && slot.by === ev.tf) slot.by = null;
    if (!after && slot.by === ev.tf) slot.by = null;
  }
  const sel: Selected[] = [];
  for (const tf of ["1h", "4h"] as const) {
    for (const t of eng[tf].trades) {
      if (Date.parse(series[tf][t.entryIndex].datetime) < decStart) continue;   // warm-up, out of scope
      sel.push({ spec, tf, t, bars: series[tf] });
    }
  }
  return { sel, series };
}

// ── --reconstruct: the diagnostic engine re-run (does NOT gate the study) ────────────────────────────────────────────────────────────────────

if (Deno.args.includes("--reconstruct")) {
const matched: Array<{ s: Selected; row: Record<string, string> }> = [];
const extras: string[] = [];
const ohlcMismatch: string[] = [];
const seen = new Set<string>();

for (const spec of SPECS) {
  const decStart = decisionStartMs(spec);
  const { sel } = runArmC(spec, decStart);
  // The frozen export only holds trades the 1m file could resolve, i.e. those
  // entered before the 1m coverage ended; nothing later can be compared.
  const lastFrozen = Math.max(...frozen.filter((r) => r.window === `${spec.inst}_${spec.end}`).map((r) => Date.parse(r.entry_time)));
  for (const s of sel) {
    const et = s.bars[s.t.entryIndex].datetime;
    const k = keyOf(spec.inst, s.tf, et, s.t.entry);
    const row = frozenByKey.get(k);
    if (!row) { if (Date.parse(et) <= lastFrozen) extras.push(`${k}  stop=${s.t.stop}`); continue; }
    seen.add(k);
    matched.push({ s, row });
    const ipo = s.bars[s.t.ipoIndex];
    const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-9;
    if (!near(ipo.open, +row.ipo_open) || !near(ipo.high, +row.ipo_high) || !near(ipo.low, +row.ipo_low) ||
        !near(ipo.close, +row.ipo_close) || !near(s.t.stop, +row.s2_price) || !near(s.t.target, +row.target_price) ||
        ipo.datetime !== row.ipo_origin_time) {
      ohlcMismatch.push(k);
    }
  }
}
const missing = frozen.filter((r) => !seen.has(keyOf(r.instrument, r.ipo_timeframe, r.entry_time, +r.entry_price)));

console.log("═══ RECONSTRUCTION GATE ═══");
console.log(`frozen control trades        ${frozen.length}`);
console.log(`re-selected & matched         ${matched.length}`);
console.log(`frozen trades NOT re-selected ${missing.length}`);
console.log(`extra in-scope trades         ${extras.length}`);
console.log(`IPO candle / S2 / target diff ${ohlcMismatch.length}`);
if (missing.length) console.log("  missing (first 10):\n   " + missing.slice(0, 10).map((r) => `${r.window} ${r.ipo_timeframe} ${r.entry_time} ${r.entry_price}`).join("\n   "));
if (extras.length) console.log("  extras (first 10):\n   " + extras.slice(0, 10).join("\n   "));
if (ohlcMismatch.length) console.log("  mismatch (first 10):\n   " + ohlcMismatch.slice(0, 10).join("\n   "));
const GATE_PASS = missing.length === 0 && extras.length === 0 && ohlcMismatch.length === 0 && matched.length === frozen.length;
console.log(`RE-SELECTION: ${GATE_PASS ? "exact" : "not exact — see the header for the diagnosis"}`);
Deno.exit(GATE_PASS ? 0 : 3);
}

// ── data-equivalence gate + tagging of the FROZEN trades ─────────────────

const seriesCache = new Map<string, Candle[]>();
const seriesFor = (r: Record<string, string>): Candle[] => {
  const spec = SPECS.find((x) => `${x.inst}_${x.end}` === r.window)!;
  const f = `${spec.inst.replace("/", "")}_${spec.end}_${r.ipo_timeframe}.json`;
  if (!seriesCache.has(f)) seriesCache.set(f, readJson<Candle[]>(f));
  return seriesCache.get(f)!;
};
const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-9;

export interface TRow extends TtmTelemetry {
  instrument: string; tf: string; window: string; direction: string;
  entry_time: string; m1_entry_time: string; exit_time: string; exit_reason: string;
  net_r: number; ttm_phase: SqueezePhase;
}

const gateFailures: string[] = [];
const rows: TRow[] = [];
for (const r of frozen) {
  const bars = seriesFor(r);
  const ipoIdx = bars.findIndex((b) => b.datetime === r.ipo_origin_time);
  const entryIdx = bars.findIndex((b) => b.datetime === r.entry_time);
  const ipo = bars[ipoIdx], eb = bars[entryIdx];
  const long = r.direction === "demand";
  if (ipoIdx < 0 || entryIdx < 0) { gateFailures.push(`ABSENT ${r.window} ${r.ipo_timeframe} ${r.entry_time}`); continue; }
  if (!(near(ipo.open, +r.ipo_open) && near(ipo.high, +r.ipo_high) && near(ipo.low, +r.ipo_low) && near(ipo.close, +r.ipo_close))) {
    gateFailures.push(`IPO_CANDLE_DIFF ${r.window} ${r.ipo_origin_time}`); continue;
  }
  if (!(long ? eb.low <= +r.entry_price : eb.high >= +r.entry_price)) {
    gateFailures.push(`ENTRY_BAR_DOES_NOT_REACH ${r.window} ${r.entry_time} ${r.entry_price}`); continue;
  }
  if (entryIdx <= ipoIdx) { gateFailures.push(`ENTRY_NOT_AFTER_IPO ${r.window} ${r.entry_time}`); continue; }
  // CAUSAL PREFIX: the bars strictly before the touch bar.
  const prefix = bars.slice(0, entryIdx);
  const tel = ttmAtDecision(prefix, long ? "demand" : "supply", r.ipo_timeframe);
  rows.push({
    instrument: r.instrument, tf: r.ipo_timeframe, window: r.window, direction: r.direction,
    entry_time: r.entry_time, m1_entry_time: r.m1_entry_time, exit_time: r.exit_time,
    exit_reason: r.exit_reason, net_r: +r.net_r, ...tel, ttm_phase: squeezePhase(tel),
  });
}
console.log("═══ DATA-EQUIVALENCE GATE (every frozen trade) ═══");
console.log(`frozen control trades   ${frozen.length}`);
console.log(`passed                  ${rows.length}`);
console.log(`failed                  ${gateFailures.length}`);
for (const g of gateFailures.slice(0, 10)) console.log("   " + g);
const GATE_PASS = gateFailures.length === 0 && rows.length === frozen.length;
console.log(`GATE: ${GATE_PASS ? "PASS" : "FAIL — stopping before any TTM analysis"}`);
if (!GATE_PASS) Deno.exit(2);

// ── stats ───────────────────────────────────────────────────────────────────

interface Stats { n: number; wr: number; avgW: number; avgL: number; exp: number; pf: number; net: number; dd: number; tpm: number | null }
function stats(rs: TRow[], months: number | null): Stats | null {
  if (!rs.length) return null;
  const r = rs.map((x) => x.net_r);
  const w = r.filter((x) => x > 0), l = r.filter((x) => x <= 0);
  // CHRONOLOGICAL drawdown (by 1m entry). The frozen 41.3 used window-major
  // file order; the chronological control is 45.6 — reported, not hidden.
  const chron = [...rs].sort((a, b) => a.m1_entry_time.localeCompare(b.m1_entry_time));
  let eq = 0, pk = 0, dd = 0;
  for (const x of chron) { eq += x.net_r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const sumW = w.reduce((a, b) => a + b, 0), sumL = l.reduce((a, b) => a + b, 0);
  return {
    n: r.length, wr: w.length / r.length,
    avgW: w.length ? sumW / w.length : 0, avgL: l.length ? sumL / l.length : 0,
    exp: (sumW + sumL) / r.length, pf: sumL < 0 ? sumW / -sumL : Infinity,
    net: sumW + sumL, dd, tpm: months ? r.length / months : null,
  };
}
const flag = (n: number) => n < 15 ? " ⚠ too small for inference" : n < 30 ? " ⚠ small sample" : "";
const f2 = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);

const COHORTS: Array<[string, (r: TRow) => boolean]> = [
  ["CONTROL", () => true],
  ["SQUEEZE_ON at entry", (r) => r.ttm_phase === "SQUEEZE_ON"],
  ["RELEASED_SAME_BAR", (r) => r.ttm_phase === "RELEASED_SAME_BAR"],
  ["RELEASED_1_BAR_AGO", (r) => r.ttm_phase === "RELEASED_1_BAR_AGO"],
  ["RELEASED_2_TO_3_BARS_AGO", (r) => r.ttm_phase === "RELEASED_2_TO_3_BARS_AGO"],
  ["RECENTLY_RELEASED (0-3)", (r) => r.ttm_release_detected && r.ttm_squeeze_on === false],
  ["NO_RECENT_SQUEEZE", (r) => r.ttm_phase === "NO_RECENT_SQUEEZE"],
  ["ALIGNED_MOMENTUM", (r) => r.ttm_direction_alignment === "aligned"],
  ["OPPOSED_MOMENTUM", (r) => r.ttm_direction_alignment === "opposed"],
  ["RELEASED + ALIGNED", (r) => r.ttm_release_detected && r.ttm_squeeze_on === false && r.ttm_direction_alignment === "aligned"],
  ["RELEASED + OPPOSED", (r) => r.ttm_release_detected && r.ttm_squeeze_on === false && r.ttm_direction_alignment === "opposed"],
  ["SQUEEZE_ON + ALIGNED", (r) => r.ttm_phase === "SQUEEZE_ON" && r.ttm_direction_alignment === "aligned"],
  ["SQUEEZE_ON + OPPOSED", (r) => r.ttm_phase === "SQUEEZE_ON" && r.ttm_direction_alignment === "opposed"],
  ["MOMENTUM RISING", (r) => r.ttm_momentum_slope === "rising"],
  ["MOMENTUM FALLING", (r) => r.ttm_momentum_slope === "falling"],
];

function table(title: string, rs: TRow[], months: number | null): string {
  const lines = [`### ${title}`, "", "| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Max DD | Trades/mo |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
  for (const [name, fn] of COHORTS) {
    const s = stats(rs.filter(fn), months);
    if (!s) { lines.push(`| ${name} | 0 | | | | | | | | |`); continue; }
    lines.push(`| ${name}${flag(s.n)} | ${s.n} | ${(100 * s.wr).toFixed(1)}% | ${f2(s.avgW)} | ${f2(s.avgL)} | ${f2(s.exp)} | ${Number.isFinite(s.pf) ? s.pf.toFixed(2) : "∞"} | ${(s.net >= 0 ? "+" : "") + s.net.toFixed(1)} | ${s.dd.toFixed(1)} | ${s.tpm === null ? "" : s.tpm.toFixed(1)} |`);
  }
  return lines.join("\n");
}

const md: string[] = [];
md.push(table("COMBINED — 1H + 4H (the control)", rows, INSTRUMENT_MONTHS));
for (const tf of ["1h", "4h"]) md.push(table(`BY TIMEFRAME — ${tf.toUpperCase()} slice of the combined control`, rows.filter((r) => r.tf === tf), INSTRUMENT_MONTHS));
for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD"]) md.push(table(`BY INSTRUMENT — ${inst}`, rows.filter((r) => r.instrument === inst), INSTRUMENT_MONTHS / 3));
for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD"]) for (const tf of ["1h", "4h"]) {
  const sub = rows.filter((r) => r.instrument === inst && r.tf === tf);
  md.push(table(`INSTRUMENT × TIMEFRAME — ${inst} ${tf.toUpperCase()} (n=${sub.length})`, sub, null));
}

// ── inference: is any separation distinguishable from noise? ────────────────
//
// Each required cohort is compared with its COMPLEMENT (the other control
// trades). Permutation test: shuffle cohort labels 10,000 times (seeded, so
// reproducible) and ask how often a difference at least as large in absolute
// value arises by chance. Holm-Bonferroni across the 10 required cohorts,
// because ten looks at one dataset will produce a "significant" one by luck.
// Stability: does the sign of (cohort - complement) hold in BOTH periods
// (2022 windows vs 2025 windows) and in every instrument with n >= 15?

// mulberry32: exact 32-bit integer arithmetic via Math.imul. A classic
// `seed * 1103515245 % 2^31` LCG overflows 2^53 in JavaScript and silently
// loses precision, which would degrade the very randomness these p-values
// rest on.
let seed = 20261001 >>> 0;
const rand = () => {
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

function permP(inR: number[], outR: number[], iters = 10_000): number {
  const all = [...inR, ...outR], k = inR.length, obs = Math.abs(mean(inR) - mean(outR));
  let hits = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < k; i++) { const j = i + Math.floor(rand() * (all.length - i)); [all[i], all[j]] = [all[j], all[i]]; }
    const a = all.slice(0, k), b = all.slice(k);
    if (Math.abs(mean(a) - mean(b)) >= obs - 1e-12) hits++;
  }
  return (hits + 1) / (iters + 1);
}
function bootCI(r: number[], iters = 5_000): [number, number] {
  const ms: number[] = [];
  for (let it = 0; it < iters; it++) { let s2 = 0; for (let i = 0; i < r.length; i++) s2 += r[Math.floor(rand() * r.length)]; ms.push(s2 / r.length); }
  ms.sort((a, b) => a - b);
  return [ms[Math.floor(0.025 * iters)], ms[Math.floor(0.975 * iters)]];
}

const REQUIRED = new Set(["SQUEEZE_ON at entry", "RELEASED_SAME_BAR", "RELEASED_1_BAR_AGO", "RELEASED_2_TO_3_BARS_AGO",
  "RECENTLY_RELEASED (0-3)", "NO_RECENT_SQUEEZE", "ALIGNED_MOMENTUM", "OPPOSED_MOMENTUM", "RELEASED + ALIGNED", "RELEASED + OPPOSED"]);
const period = (r: TRow) => r.entry_time.startsWith("2022") ? "2022" : "2025";
interface Inf { name: string; n: number; diff: number; p: number; pHolm: number; ci: [number, number]; periodsAgree: boolean; instAgree: string }
const inf: Inf[] = [];
for (const [name, fn] of COHORTS) {
  if (!REQUIRED.has(name)) continue;
  const inR = rows.filter(fn).map((r) => r.net_r), outR = rows.filter((r) => !fn(r)).map((r) => r.net_r);
  const diff = mean(inR) - mean(outR);
  const sgn = (sub: TRow[]) => { const a = sub.filter(fn).map((r) => r.net_r), b = sub.filter((r) => !fn(r)).map((r) => r.net_r);
    return a.length >= 15 && b.length ? Math.sign(mean(a) - mean(b)) : 0; };
  const per = ["2022", "2025"].map((pp) => sgn(rows.filter((r) => period(r) === pp)));
  const inst = ["EUR/USD", "USD/JPY", "BTC/USD"].map((i) => sgn(rows.filter((r) => r.instrument === i)));
  const usable = inst.filter((x) => x !== 0);
  inf.push({ name, n: inR.length, diff, p: permP(inR, outR), pHolm: 1, ci: bootCI(inR),
    periodsAgree: per.every((x) => x === Math.sign(diff)),
    instAgree: `${usable.filter((x) => x === Math.sign(diff)).length}/${usable.length}` });
}
// Holm step-down
const order = [...inf].sort((a, b) => a.p - b.p);
let runMax = 0;
order.forEach((x, i) => { runMax = Math.max(runMax, Math.min(1, x.p * (order.length - i))); x.pHolm = runMax; });

const infMd = ["### INFERENCE — each cohort vs its complement (combined control)", "",
  "| Cohort | n | Exp − complement | 95% CI of cohort Exp | perm p | Holm p | sign holds 2022 & 2025 | sign holds by instrument (n≥15) |",
  "|---|---:|---:|---|---:|---:|:---:|:---:|"];
for (const x of inf) {
  infMd.push(`| ${x.name}${flag(x.n)} | ${x.n} | ${f2(x.diff)} | [${f2(x.ci[0])}, ${f2(x.ci[1])}] | ${x.p.toFixed(3)} | ${x.pHolm.toFixed(3)} | ${x.periodsAgree ? "yes" : "NO"} | ${x.instAgree} |`);
}
md.unshift(infMd.join("\n"));
console.log("\n" + infMd.join("\n"));

// ── distribution facts ──────────────────────────────────────────────────────
const dist = (k: (r: TRow) => string) => {
  const m: Record<string, number> = {};
  for (const r of rows) m[k(r)] = (m[k(r)] || 0) + 1;
  return m;
};
const facts = {
  phase: dist((r) => r.ttm_phase),
  alignment: dist((r) => r.ttm_direction_alignment),
  slope: dist((r) => String(r.ttm_momentum_slope)),
  unavailable: rows.filter((r) => r.ttm_squeeze_on === null || r.ttm_momentum === null).length,
};

// ── exports ─────────────────────────────────────────────────────────────────
const cols: (keyof TRow)[] = ["instrument", "tf", "window", "direction", "entry_time", "m1_entry_time", "exit_time",
  "exit_reason", "net_r", "ttm_length", "ttm_bb_mult", "ttm_kc_mult", "ttm_timeframe", "ttm_decision_bar_index",
  "ttm_squeeze_on", "ttm_release_detected", "ttm_release_bars_ago", "ttm_momentum", "ttm_momentum_direction",
  "ttm_momentum_slope", "ttm_direction_alignment", "ttm_phase"];
const csv = [cols.join(","), ...[...rows].sort((a, b) => a.m1_entry_time.localeCompare(b.m1_entry_time))
  .map((r) => cols.map((c) => r[c] === null ? "" : String(r[c])).join(","))].join("\n");
await Deno.writeTextFile(new URL("ipo_ttm_squeeze_telemetry_v1.csv", OUT_DIR), csv + "\n");
await Deno.writeTextFile(new URL("./.cache/ipo-ttm/tables.md", import.meta.url), md.join("\n\n") + "\n");
await Deno.writeTextFile(new URL("./.cache/ipo-ttm/facts.json", import.meta.url), JSON.stringify(facts, null, 2));

console.log("\n═══ DISTRIBUTION ═══");
console.log(JSON.stringify(facts));
console.log("\n" + md[0]);
console.log("\nexports: docs/exports/ipo_ttm_squeeze_telemetry_v1.csv, local-runner/.cache/ipo-ttm/tables.md");
