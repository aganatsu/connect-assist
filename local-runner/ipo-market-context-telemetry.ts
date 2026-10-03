/**
 * IPO_MARKET_CONTEXT_TELEMETRY_V1 — research telemetry, NOT a strategy test.
 *
 * Question: does real FX market context known before entry separate stronger
 * and weaker IPO trades in the frozen IPO_BASELINE_1H_4H_CAUSAL_V1 control?
 *
 * NOTHING IS FILTERED. The control is the committed trade list exactly as
 * frozen (docs/exports/ipo_1h_4h_combined_clean.csv). Context is attached as
 * telemetry. The IPO engine is not run, configured or changed.
 *
 * CONTROL. Same accepted approach as IPO_TTM_SQUEEZE_TELEMETRY_V1: tag the
 * frozen trades behind a per-trade data-equivalence gate (IPO candle
 * byte-identical in the re-fetched series, entry bar present, entry price
 * reachable, entry after the IPO candle). The six control figures must also
 * reproduce. Either failing stops the study.
 *
 * DRAWDOWN. The frozen 41.3R was computed in file (window-major) order. The
 * true chronological DD of the same trades is 45.6R. Every NEW figure here is
 * chronological.
 *
 * SCOPE. FX mechanisms (sessions, London fix, rollover) are studied on
 * EUR/USD + USD/JPY only. BTC/USD is reported separately with generic labels
 * (UTC window, weekday, generic session label, volatility) and never pooled
 * into an FX conclusion.
 *
 * NEWS: NEWS_CONTEXT_UNAVAILABLE. The project has no historical economic
 * calendar. No table holds one, the only feed referenced (ForexFactory
 * ff_calendar_thisweek.json) covers the current week only, and the TwelveData
 * plan has no calendar endpoint. No news study is fabricated, and no current
 * calendar is used to infer old events.
 *
 * Every definition, bucket and threshold below was FROZEN before the first
 * run. None is to be tuned against results.
 *
 *   deno run --allow-read --allow-write local-runner/ipo-market-context-telemetry.ts
 */

import { CACHE, SPECS } from "./ipo-ttm-fetch.ts";
import {
  contextFeatures, FIX_BUCKETS, UTC_WINDOWS, type Bar, type ContextFeatures, type Session,
} from "./marketContext.ts";

const EXPORT = new URL("../docs/exports/ipo_1h_4h_combined_clean.csv", import.meta.url);
const OUT = new URL("../docs/exports/", import.meta.url);
const CACHE_OUT = new URL("./.cache/ipo-market-context/", import.meta.url);
const NEWS_STATUS = "NEWS_CONTEXT_UNAVAILABLE";

// ── frozen analysis constants ──────────────────────────────────────────────
const PERM_ITERS = 10_000, BOOT_ITERS = 5_000;
const CAND_MIN_N = 60, CAND_MIN_DIFF = 0.15, CAND_MAX_BH_Q = 0.10;
const SLICE_MIN_N = 15, SLICE_REVERSE_N = 30, MIN_EVALUABLE_SLICES = 4;

// ── frozen export ──────────────────────────────────────────────────────────
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n"); const head = lines[0].split(",");
  return lines.slice(1).map((l) => {
    const cells: string[] = []; let cur = "", q = false;
    for (const ch of l) { if (ch === '"') q = !q; else if (ch === "," && !q) { cells.push(cur); cur = ""; } else cur += ch; }
    cells.push(cur);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
  });
}
const frozen = parseCsv(Deno.readTextFileSync(EXPORT));
const readJson = <T>(n: string): T => JSON.parse(Deno.readTextFileSync(new URL(n, CACHE)));
const seriesCache = new Map<string, Bar[]>();
const series = (window: string, tf: string): Bar[] => {
  const s = SPECS.find((x) => `${x.inst}_${x.end}` === window)!;
  const f = `${s.inst.replace("/", "")}_${s.end}_${tf}.json`;
  if (!seriesCache.has(f)) seriesCache.set(f, readJson<Bar[]>(f));
  return seriesCache.get(f)!;
};
const near = (a: number, b: number) => Math.abs(a - b) <= Math.abs(b) * 1e-9;
const TF_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000 };

// ── gate + features ────────────────────────────────────────────────────────
export interface Row extends ContextFeatures {
  instrument: string; tf: string; window: string; direction: string; period: "2022" | "2025";
  entry_time: string; m1_entry_time: string; exit_time: string; exit_reason: string; net_r: number;
  news_status: string;
}
const fails: string[] = [];
const rows: Row[] = [];
for (const r of frozen) {
  const bars = series(r.window, r.ipo_timeframe);
  const ipoIdx = bars.findIndex((b) => b.datetime === r.ipo_origin_time);
  const entryIdx = bars.findIndex((b) => b.datetime === r.entry_time);
  if (ipoIdx < 0 || entryIdx < 0) { fails.push(`ABSENT ${r.window} ${r.entry_time}`); continue; }
  const ipo = bars[ipoIdx], eb = bars[entryIdx], long = r.direction === "demand";
  if (!(near(ipo.open, +r.ipo_open) && near(ipo.high, +r.ipo_high) && near(ipo.low, +r.ipo_low) && near(ipo.close, +r.ipo_close))) {
    fails.push(`IPO_CANDLE_DIFF ${r.window} ${r.ipo_origin_time}`); continue;
  }
  if (!(long ? eb.low <= +r.entry_price : eb.high >= +r.entry_price)) { fails.push(`ENTRY_BAR_DOES_NOT_REACH ${r.window} ${r.entry_time}`); continue; }
  if (entryIdx <= ipoIdx) { fails.push(`ENTRY_NOT_AFTER_IPO ${r.window} ${r.entry_time}`); continue; }
  const D = Date.parse(r.m1_entry_time), barOpen = Date.parse(r.entry_time);
  if (!(D >= barOpen && D < barOpen + TF_MS[r.ipo_timeframe])) { fails.push(`FILL_OUTSIDE_TOUCH_BAR ${r.window} ${r.m1_entry_time}`); continue; }
  const fx = r.instrument !== "BTC/USD";
  const h1 = series(r.window, "1h");
  const feat = contextFeatures({
    decisionMs: Date.parse(r.m1_entry_time),
    entryPrice: +r.entry_price, fx,
    // CAUSAL: own-timeframe bars strictly before the touch bar.
    ownPrefix: bars.slice(0, entryIdx),
    // 1H context: the module itself admits only bars closed by the fill minute.
    hourly: h1.filter((b) => { const t = Date.parse(b.datetime); return t > D - 8 * 86_400_000 && t <= D; }),
  });
  rows.push({
    instrument: r.instrument, tf: r.ipo_timeframe, window: r.window, direction: r.direction,
    period: r.entry_time.startsWith("2022") ? "2022" : "2025",
    entry_time: r.entry_time, m1_entry_time: r.m1_entry_time, exit_time: r.exit_time,
    exit_reason: r.exit_reason, net_r: +r.net_r, news_status: NEWS_STATUS, ...feat,
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

// control reproduction (all trades, and the frozen file-order DD)
const ctl = stats(rows)!;
let feq = 0, fpk = 0, fdd = 0;
for (const r of frozen) { feq += +r.net_r; fpk = Math.max(fpk, feq); fdd = Math.max(fdd, fpk - feq); }
const r1 = (x: number) => Math.round(x * 10) / 10, r3 = (x: number) => Math.round(x * 1000) / 1000;
const CONTROL_OK = ctl.n === 1032 && r1(100 * ctl.wr) === 61.5 && r3(ctl.exp) === 0.202 &&
  Math.round(ctl.pf * 100) / 100 === 1.25 && r1(ctl.net) === 208.3 && r1(fdd) === 41.3 && r1(ctl.dd) === 45.6;

console.log("═══ A. CONTROL RECONSTRUCTION ═══");
console.log(`per-trade data gate: ${rows.length}/${frozen.length} pass, ${fails.length} fail`);
for (const f of fails.slice(0, 10)) console.log("   " + f);
console.log(`n=${ctl.n} WR=${(100 * ctl.wr).toFixed(1)}% exp=${ctl.exp.toFixed(3)} PF=${ctl.pf.toFixed(2)} net=${ctl.net.toFixed(1)} DD file-order=${fdd.toFixed(1)} chronological=${ctl.dd.toFixed(1)}`);
const GATE_PASS = fails.length === 0 && rows.length === frozen.length && CONTROL_OK;
console.log(`GATE: ${GATE_PASS ? "PASS" : "FAIL — stopping before any context analysis"}`);
if (!GATE_PASS) Deno.exit(2);

// ── cohorts (frozen) ───────────────────────────────────────────────────────
type C = { family: "FX" | "BTC"; group: string; name: string; fn: (r: Row) => boolean };
const SESSIONS: Session[] = ["ASIA", "LONDON", "LONDON_NY_OVERLAP", "NEW_YORK", "LATE_NY_ROLLOVER"];
const fxCohorts: C[] = [
  ...Array.from({ length: 24 }, (_, h) => ({ family: "FX" as const, group: "UTC_HOUR", name: `HOUR_${String(h).padStart(2, "0")}`, fn: (r: Row) => r.utc_hour === h })),
  ...UTC_WINDOWS.map(([w]) => ({ family: "FX" as const, group: "UTC_WINDOW", name: `UTC_${w}`, fn: (r: Row) => r.utc_window === w })),
  ...SESSIONS.map((s) => ({ family: "FX" as const, group: "SESSION", name: s, fn: (r: Row) => r.session === s })),
  ...FIX_BUCKETS.map((b) => ({ family: "FX" as const, group: "LONDON_FIX", name: `FIX ${b}`, fn: (r: Row) => r.fix_bucket === b })),
  { family: "FX", group: "ROLLOVER", name: "ROLLOVER within 15 before", fn: (r) => r.rollover_pre_15 },
  { family: "FX", group: "ROLLOVER", name: "ROLLOVER within 15 after", fn: (r) => r.rollover_post_15 },
  { family: "FX", group: "ROLLOVER", name: "ROLLOVER within 30", fn: (r) => r.rollover_within_30 },
  { family: "FX", group: "ROLLOVER", name: "ROLLOVER within 60", fn: (r) => r.rollover_within_60 },
  { family: "FX", group: "ROLLOVER", name: "ROLLOVER outside 60", fn: (r) => r.rollover_outside_60 },
  ...(["LOW", "NORMAL", "HIGH"] as const).map((v) => ({ family: "FX" as const, group: "VOLATILITY", name: `VOL ${v}`, fn: (r: Row) => r.vol_regime === v })),
  { family: "FX", group: "PRICE_LOCATION", name: "NEAR PDH (<=0.25 ATR)", fn: (r) => r.near_pdh === true },
  { family: "FX", group: "PRICE_LOCATION", name: "NEAR PDL (<=0.25 ATR)", fn: (r) => r.near_pdl === true },
  { family: "FX", group: "PRICE_LOCATION", name: "NEAR DAY OPEN (<=0.25 ATR)", fn: (r) => r.near_day_open === true },
  { family: "FX", group: "PRICE_LOCATION", name: "INSIDE prior-day range", fn: (r) => r.prior_day_position === "INSIDE" },
  { family: "FX", group: "PRICE_LOCATION", name: "OUTSIDE prior-day range", fn: (r) => r.prior_day_position === "ABOVE_PDH" || r.prior_day_position === "BELOW_PDL" },
  { family: "FX", group: "PRICE_LOCATION", name: "ABOVE PDH", fn: (r) => r.prior_day_position === "ABOVE_PDH" },
  { family: "FX", group: "PRICE_LOCATION", name: "BELOW PDL", fn: (r) => r.prior_day_position === "BELOW_PDL" },
];
const btcCohorts: C[] = [
  ...UTC_WINDOWS.map(([w]) => ({ family: "BTC" as const, group: "UTC_WINDOW", name: `UTC_${w}`, fn: (r: Row) => r.utc_window === w })),
  ...SESSIONS.map((s) => ({ family: "BTC" as const, group: "GENERIC_SESSION_LABEL", name: s, fn: (r: Row) => r.session === s })),
  ...[1, 2, 3, 4, 5, 6, 0].map((d) => ({ family: "BTC" as const, group: "WEEKDAY", name: `WEEKDAY ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]}`, fn: (r: Row) => r.weekday === d })),
  ...(["LOW", "NORMAL", "HIGH"] as const).map((v) => ({ family: "BTC" as const, group: "VOLATILITY", name: `VOL ${v}`, fn: (r: Row) => r.vol_regime === v })),
];

// ── inference ──────────────────────────────────────────────────────────────
let seed = 20261001 >>> 0;               // mulberry32 — exact 32-bit arithmetic
const rand = () => {
  seed = (seed + 0x6D2B79F5) >>> 0; let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

interface Res {
  family: string; group: string; name: string; s: S | null; diff: number | null; p: number | null;
  holm: number | null; bh: number | null; ci: [number, number] | null;
  stability: Record<string, number | null>; slicesN: Record<string, number>; label: string; candidate: boolean;
}
const SLICES: Array<[string, (r: Row) => boolean]> = [
  ["EUR/USD", (r) => r.instrument === "EUR/USD"], ["USD/JPY", (r) => r.instrument === "USD/JPY"],
  ["1H", (r) => r.tf === "1h"], ["4H", (r) => r.tf === "4h"],
  ["2022 window", (r) => r.period === "2022"], ["2025 window", (r) => r.period === "2025"],
];

function analyse(pop: Row[], cohorts: C[], withSlices: boolean): Res[] {
  const out: Res[] = cohorts.map((c) => {
    const inn = pop.filter(c.fn), rest = pop.filter((r) => !c.fn(r));
    const s = stats(inn);
    const diff = inn.length && rest.length ? mean(inn.map((r) => r.net_r)) - mean(rest.map((r) => r.net_r)) : null;
    const p = inn.length >= 2 && rest.length >= 2 ? permP(inn.map((r) => r.net_r), rest.map((r) => r.net_r)) : null;
    const stab: Record<string, number | null> = {}, sn: Record<string, number> = {};
    if (withSlices) for (const [nm, sf] of SLICES) {
      const sub = pop.filter(sf), a = sub.filter(c.fn), b = sub.filter((r) => !c.fn(r));
      sn[nm] = a.length;
      stab[nm] = a.length && b.length ? mean(a.map((r) => r.net_r)) - mean(b.map((r) => r.net_r)) : null;
    }
    return { family: c.family, group: c.group, name: c.name, s, diff, p, holm: null, bh: null,
      ci: inn.length >= 2 ? bootCI(inn.map((r) => r.net_r)) : null, stability: stab, slicesN: sn, label: "", candidate: false };
  });
  // Holm and Benjamini-Hochberg within this family
  const tested = out.filter((x) => x.p !== null).sort((a, b) => a.p! - b.p!);
  const m = tested.length;
  let run = 0;
  tested.forEach((x, i) => { run = Math.max(run, Math.min(1, x.p! * (m - i))); x.holm = run; });
  let minQ = 1;
  for (let i = m - 1; i >= 0; i--) { minQ = Math.min(minQ, (tested[i].p! * m) / (i + 1)); tested[i].bh = Math.min(1, minQ); }
  // stability label (frozen)
  for (const x of out) {
    if (!x.s || x.s.n < 30 || x.diff === null) { x.label = "TOO_SMALL"; continue; }
    if (!withSlices) { x.label = "n/a"; continue; }
    const sign = Math.sign(x.diff);
    const evalS = SLICES.map(([nm]) => nm).filter((nm) => x.slicesN[nm] >= SLICE_MIN_N && x.stability[nm] !== null);
    if (evalS.length < MIN_EVALUABLE_SLICES) { x.label = "TOO_SMALL"; continue; }
    const opp = evalS.filter((nm) => Math.sign(x.stability[nm]!) !== sign);
    if (opp.some((nm) => x.slicesN[nm] >= SLICE_REVERSE_N)) x.label = "REVERSES";
    else if (opp.length === 0) x.label = "STABLE";
    else x.label = "MIXED";
    x.candidate = x.s.n >= CAND_MIN_N && Math.abs(x.diff) >= CAND_MIN_DIFF && x.label === "STABLE" &&
      x.bh !== null && x.bh <= CAND_MAX_BH_Q;
  }
  return out;
}

const fx = rows.filter((r) => r.instrument !== "BTC/USD");
const btc = rows.filter((r) => r.instrument === "BTC/USD");
const fxRes = analyse(fx, fxCohorts, true);
const btcRes = analyse(btc, btcCohorts, false);

// ── outputs ────────────────────────────────────────────────────────────────
const f3 = (x: number | null) => x === null ? "" : (x >= 0 ? "+" : "") + x.toFixed(3);
const warn = (n: number) => n < 15 ? "TOO SMALL FOR INFERENCE" : n < 30 ? "SMALL SAMPLE" : "";

await Deno.mkdir(CACHE_OUT, { recursive: true });

// trade-level CSV
const tcols = Object.keys(rows[0]) as (keyof Row)[];
const esc = (v: unknown) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
await Deno.writeTextFile(new URL("ipo_market_context_telemetry_v1.csv", OUT),
  [tcols.join(","), ...[...rows].sort((a, b) => a.m1_entry_time.localeCompare(b.m1_entry_time)).map((r) => tcols.map((c) => esc(r[c])).join(","))].join("\n") + "\n");

// cohort CSV
const ccols = ["family", "group", "cohort", "n", "sample_warning", "win_rate", "avg_winner_r", "avg_loser_r", "expectancy_r", "profit_factor",
  "net_r", "chron_max_dd_r", "exp_minus_complement_r", "boot_ci_lo", "boot_ci_hi", "perm_p_raw", "p_holm", "q_bh", "stability", "candidate"];
const cline = (x: Res) => [x.family, x.group, x.name, x.s?.n ?? 0, warn(x.s?.n ?? 0), x.s ? x.s.wr.toFixed(4) : "",
  x.s ? x.s.avgW.toFixed(4) : "", x.s ? x.s.avgL.toFixed(4) : "", x.s ? x.s.exp.toFixed(4) : "",
  x.s ? (Number.isFinite(x.s.pf) ? x.s.pf.toFixed(3) : "inf") : "", x.s ? x.s.net.toFixed(2) : "", x.s ? x.s.dd.toFixed(2) : "",
  x.diff === null ? "" : x.diff.toFixed(4), x.ci ? x.ci[0].toFixed(4) : "", x.ci ? x.ci[1].toFixed(4) : "",
  x.p === null ? "" : x.p.toFixed(4), x.holm === null ? "" : x.holm.toFixed(4), x.bh === null ? "" : x.bh.toFixed(4),
  x.label, x.candidate].map(esc).join(",");
await Deno.writeTextFile(new URL("ipo_market_context_cohorts_v1.csv", OUT),
  [ccols.join(","), ...fxRes.map(cline), ...btcRes.map(cline)].join("\n") + "\n");

// stability CSV (FX)
const scols = ["cohort", "group", "combined_n", "combined_diff", ...SLICES.flatMap(([n]) => [`${n} n`, `${n} diff`]), "label"];
await Deno.writeTextFile(new URL("ipo_market_context_stability_v1.csv", OUT),
  [scols.join(","), ...fxRes.map((x) => [x.name, x.group, x.s?.n ?? 0, x.diff === null ? "" : x.diff.toFixed(4),
    ...SLICES.flatMap(([n]) => [x.slicesN[n] ?? 0, x.stability[n] === null || x.stability[n] === undefined ? "" : x.stability[n]!.toFixed(4)]),
    x.label].map(esc).join(","))].join("\n") + "\n");

// markdown tables for the report
const tbl = (title: string, res: Res[]) => [`#### ${title}`, "",
  "| Cohort | n | WR | avg W | avg L | Exp R | PF | Net R | Chron DD | Δ vs rest | perm p | Holm | BH q | Stability |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ...res.map((x) => x.s ? `| ${x.name}${x.s.n < 15 ? " ⚠⚠" : x.s.n < 30 ? " ⚠" : ""} | ${x.s.n} | ${(100 * x.s.wr).toFixed(1)}% | ${f3(x.s.avgW)} | ${f3(x.s.avgL)} | ${f3(x.s.exp)} | ${Number.isFinite(x.s.pf) ? x.s.pf.toFixed(2) : "∞"} | ${(x.s.net >= 0 ? "+" : "") + x.s.net.toFixed(1)} | ${x.s.dd.toFixed(1)} | ${f3(x.diff)} | ${x.p?.toFixed(3) ?? ""} | ${x.holm?.toFixed(3) ?? ""} | ${x.bh?.toFixed(3) ?? ""} | ${x.label} |`
    : `| ${x.name} | 0 | | | | | | | | | | | | — |`)].join("\n");
const groups = (res: Res[]) => [...new Set(res.map((x) => x.group))];
const md: string[] = [];
const fxCtl = stats(fx)!, btcCtl = stats(btc)!;
md.push(`FX control (EUR/USD + USD/JPY): n=${fxCtl.n}, WR ${(100 * fxCtl.wr).toFixed(1)}%, exp ${f3(fxCtl.exp)}, PF ${fxCtl.pf.toFixed(2)}, net ${fxCtl.net.toFixed(1)}, chron DD ${fxCtl.dd.toFixed(1)}`);
md.push(`BTC control: n=${btcCtl.n}, WR ${(100 * btcCtl.wr).toFixed(1)}%, exp ${f3(btcCtl.exp)}, PF ${btcCtl.pf.toFixed(2)}, net ${btcCtl.net.toFixed(1)}, chron DD ${btcCtl.dd.toFixed(1)}`);
for (const g of groups(fxRes)) md.push(tbl(`FX — ${g}`, fxRes.filter((x) => x.group === g)));
for (const g of groups(btcRes)) md.push(tbl(`BTC/USD (separate, generic labels) — ${g}`, btcRes.filter((x) => x.group === g)));
// stability table for every cohort with n >= 30
md.push(["#### FX stability (Δ vs rest within each slice; n in brackets)", "",
  `| Feature | Combined | ${SLICES.map(([n]) => n).join(" | ")} | Label |`, `|---|---:|${SLICES.map(() => "---:").join("|")}|---|`,
  ...fxRes.filter((x) => (x.s?.n ?? 0) >= 30).map((x) => `| ${x.name} | ${f3(x.diff)} (${x.s!.n}) | ${SLICES.map(([n]) =>
    x.stability[n] === null || x.stability[n] === undefined ? "—" : `${f3(x.stability[n]!)} (${x.slicesN[n]})`).join(" | ")} | ${x.label} |`)].join("\n"));
await Deno.writeTextFile(new URL("tables.md", CACHE_OUT), md.join("\n\n") + "\n");

// console summary
console.log(`\nFX n=${fx.length}  BTC n=${btc.length}  news: ${NEWS_STATUS}`);
const fxTested = fxRes.filter((x) => x.p !== null);
console.log(`FX cohorts tested: ${fxTested.length}; raw p<.05: ${fxTested.filter((x) => x.p! < 0.05).length}; Holm<.05: ${fxTested.filter((x) => x.holm! < 0.05).length}; BH q<=.10: ${fxTested.filter((x) => x.bh! <= 0.10).length}`);
console.log(`labels: ${JSON.stringify(fxRes.reduce((a: Record<string, number>, x) => (a[x.label] = (a[x.label] || 0) + 1, a), {}))}`);
console.log(`CANDIDATES (n>=${CAND_MIN_N}, |Δ|>=${CAND_MIN_DIFF}, STABLE, BH q<=${CAND_MAX_BH_Q}): ${fxRes.filter((x) => x.candidate).map((x) => x.name).join(", ") || "NONE"}`);
console.log("\nlowest raw p (FX):");
for (const x of [...fxTested].sort((a, b) => a.p! - b.p!).slice(0, 8)) {
  console.log(`  ${x.name.padEnd(30)} n=${String(x.s!.n).padStart(4)} exp=${f3(x.s!.exp)} Δ=${f3(x.diff)} p=${x.p!.toFixed(3)} holm=${x.holm!.toFixed(3)} bh=${x.bh!.toFixed(3)} ${x.label}`);
}
const btcTested = btcRes.filter((x) => x.p !== null);
console.log(`\nBTC cohorts tested: ${btcTested.length}; raw p<.05: ${btcTested.filter((x) => x.p! < 0.05).length}; Holm<.05: ${btcTested.filter((x) => x.holm! < 0.05).length}; BH q<=.10: ${btcTested.filter((x) => x.bh! <= 0.10).length}`);
