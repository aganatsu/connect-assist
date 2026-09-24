/**
 * IPO-CET-v2 EXPERIMENT 2 — SMC direction verdict and HTF structure as IPO
 * context filters.
 *
 * RESEARCH ONLY. Reads local research JSON and cached market data; writes local
 * JSON/CSV. No database, no schema, no cron, no deployment, no production code
 * change, no SMC rule change, no IPO rule change.
 *
 * THE QUESTION. The IPO engine is direction-aware per setup (demand -> long,
 * supply -> short) but never asks whether the broader market agrees. SMC already
 * computes two such opinions every scan. Do they separate stronger IPO setups
 * from weaker ones?
 *
 * WHAT IS REUSED, AND NOTHING ELSE. Two read-only outputs of the existing SMC
 * engine, imported from the production modules unmodified:
 *
 *   1. `computeDirectionVerdict` (directionVerdict.ts) — the single source of
 *      truth for SMC trade direction, fed exactly as bot-scanner feeds it.
 *   2. `analyzeMarketStructure(dailyCandles).trend` (smcAnalysis.ts) — the value
 *      bot-scanner calls `htfStructure` / `htfTrend` in legacy Gate 1.
 *
 * No SMC rule is reimplemented and no threshold is swept. The experiment asks
 * whether the context we ALREADY have carries information.
 *
 * CAUSALITY. Every context read uses ONLY candles that had fully closed at or
 * before the IPO entry bar's OPEN instant. Nothing from the entry bar itself is
 * visible — not even its close — so no SMC value can be informed by the price
 * action that produced the fill. This is STRICTER than production, which sees an
 * in-progress daily bar; the reconstruction is one bar behind on purpose.
 *
 * SERIES DEPTH MATTERS. `analyzeMarketStructure` and `confirmedTrend` read the
 * whole array they are given, so the reconstruction slices each series to the
 * exact depth bot-scanner fetches: daily 300, 4H 300 (LEGACY_H4_WINDOW), 1H 300,
 * weekly 300.
 *
 * TWO ANALYSES, NEVER CONFLATED.
 *   FIXED_POPULATION     — the Experiment 1 reconstructed HTF control population,
 *                          filtered by tag. Clean signal-quality comparison.
 *   TRUE_FILTERED_REPLAY — the engine's sequencing re-run with the filter live at
 *                          decision time, so a refused IPO leaves the
 *                          one-position-per-instrument slot free and later IPOs
 *                          the baseline never saw become eligible.
 */

import { computeDirectionVerdict } from "../supabase/functions/_shared/directionVerdict.ts";
import { determineDirection, confirmedTrend } from "../supabase/functions/_shared/directionEngine.ts";
import {
  analyzeMarketStructure,
  classifyInstrumentRegime,
  type Candle,
} from "../supabase/functions/_shared/smcAnalysis.ts";
import { analyzeWeeklyBiasAndDOL } from "../supabase/functions/_shared/weeklyBiasDOL.ts";
import { isEligible } from "../supabase/functions/_shared/ipoLiveVolatility.ts";
import type { VolBucket } from "../supabase/functions/_shared/ipoRegimeDescriptors.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

const EXP1 = "/tmp/v2-exp1-s2.json";
const CTX = "/tmp/v2-exp2-context-series.json";
const CAND = "/tmp/v2-exp2-candidates.json";
const MIN = "/tmp/td-1m-corpus.json";

interface Exp1Row {
  window: string; instrument: string; direction: string; vol: string;
  entryBarTime: string; entryMinute: string | null; entry: number; s2: number;
  target: number; risk: number; costR: number; status: string;
  A_outcome: string | null; A_exitTime: string | null; A_netR: number | null;
}
const exp1: Exp1Row[] = JSON.parse(await Deno.readTextFile(EXP1));
const ctx: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile(CTX));
const minutes: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile(MIN));

interface BarRecord {
  vol: string;
  hit: {
    candidateIndex: number; direction: "demand" | "supply";
    zoneLow: number; zoneHigh: number; invalidationLevel: number;
  } | null;
}
interface WindowTable {
  window: string; instrument: string; interval: string; from: string; to: string;
  bars: Candle[]; rows: BarRecord[]; completed: boolean;
}
const tables: Record<string, WindowTable> = JSON.parse(await Deno.readTextFile(CAND));

interface TD {
  entryIndex: number; exitIndex: number; netR: number; vol: string; ipoIndex: number;
  direction: string; entry: number; stop: number; target: number; risk: number;
  costR: number; entryBarTime: string; exitBarTime: string; ipoCandleTime: string;
}
const ckpt: Record<string, { window: string; instrument: string; from: string; to: string;
  completed: boolean; trades_detail: TD[] }> =
  JSON.parse(await Deno.readTextFile("/tmp/baseline-determinism-checkpoint.json"));

/** The window whose 1-minute feed carries the undocumented whole-bar corruption. */
const EXCLUDED_WINDOW = "p3-BTCUSD";

const H = (s: string) => console.log(`\n${"=".repeat(112)}\n${s}\n${"=".repeat(112)}`);
const ms = (iso: string) => Date.parse(iso);

// ─────────────────────────────────────────────────────────────────────────────
// PART A — the existing SMC features, verified against the live source
// ─────────────────────────────────────────────────────────────────────────────

H("PART A — SMC feature inventory, verified against the live source");
{
  const scanner = await Deno.readTextFile("supabase/functions/bot-scanner/index.ts");
  const checks: Array<[string, boolean]> = [
    ["directionVerdict is computed by computeDirectionVerdict()",
      scanner.includes("directionVerdict = computeDirectionVerdict({")],
    ["its spine is determineDirection() for the default day_trader style",
      scanner.includes("simpleDirectionResult = determineDirection(")],
    ["default trading style is day_trader",
      scanner.includes('const resolvedStyle = config.tradingStyle?.mode || "day_trader"')],
    ["HTF structure is analyzeMarketStructure(dailyCandles).trend",
      scanner.includes("analyzeMarketStructure(dailyCandles!)") && scanner.includes("const htfTrend = htfStructure.trend")],
    ["regime input is the daily classification",
      scanner.includes("regime: analysis.regimeInfo ? {")],
    ["weekly bias input comes from the ICT HTF result",
      scanner.includes("weeklyBias: ictHTFResult?.weeklyBias ? {")],
    ["game plan bias is an input and is LLM-generated",
      scanner.includes("gamePlanBias: gpCtx ? {")],
    ["daily / 1H / weekly depth is 300 bars", scanner.includes("const DEFAULT_CANDLE_LIMIT = 300")],
    ["4H legacy consumers see 300 bars", scanner.includes("export const LEGACY_H4_WINDOW = 300")],
  ];
  let allOk = true;
  for (const [claim, ok] of checks) {
    console.log(`  [${ok ? "OK " : "!! "}] ${claim}`);
    if (!ok) allOk = false;
  }
  if (!allOk) { console.error("\nFATAL: the source no longer matches the documented feature map."); Deno.exit(1); }
}

// ─────────────────────────────────────────────────────────────────────────────
// PART B — causal SMC context at an instant
// ─────────────────────────────────────────────────────────────────────────────

const BAR_MS: Record<string, number> = {
  "1day": 86_400_000, "1week": 7 * 86_400_000, "4h": 4 * 3_600_000, "1h": 3_600_000,
};

/** Bars that had FULLY CLOSED at or before `t`. Never the bar in progress. */
function closedBy(series: Candle[], tf: string, t: number, depth = 300): Candle[] {
  const dur = BAR_MS[tf];
  const out: Candle[] = [];
  for (const b of series) {
    if (ms(b.datetime) + dur <= t) out.push(b); else break;
  }
  return out.slice(-depth);
}

export type Norm = "BULLISH" | "BEARISH" | "NEUTRAL" | "UNKNOWN";

interface SmcContext {
  available: boolean;
  unavailableReason: string | null;
  dirRaw: string;            // verdict + confidence + block flag, verbatim
  dirNorm: Norm;
  dirConfidence: number;
  dirShouldBlock: boolean;
  dirAgreement: number;
  htfRaw: string;            // "bullish" | "bearish" | "ranging" | "unavailable"
  htfNorm: Norm;
  contextTimestamp: string;
  counts: string;            // series depths actually used
}

const UNAVAILABLE = (reason: string, t: number): SmcContext => ({
  available: false, unavailableReason: reason,
  dirRaw: "UNAVAILABLE", dirNorm: "UNKNOWN", dirConfidence: 0,
  dirShouldBlock: false, dirAgreement: 0,
  htfRaw: "unavailable", htfNorm: "UNKNOWN",
  contextTimestamp: new Date(t).toISOString().replace(".000Z", "Z"), counts: "",
});

const ctxMemo = new Map<string, SmcContext>();

function smcContextAt(instrument: string, windowId: string, t: number): SmcContext {
  const daily = closedBy(ctx[`${instrument}|1day`] ?? [], "1day", t);
  const weekly = closedBy(ctx[`${instrument}|1week`] ?? [], "1week", t);
  const h4 = closedBy(ctx[`${instrument}|4h|${windowId}`] ?? [], "4h", t);
  const h1 = closedBy(ctx[`${instrument}|1h|${windowId}`] ?? [], "1h", t);

  // The verdict is fully determined by the four slices, and each slice is the
  // 300-bar suffix ending at its last closed bar. Memoise on the identity of
  // that suffix — the LAST BAR of each series plus its length — not on the
  // timestamp: USD/JPY decides twice an hour and the second decision usually
  // sees exactly the same closed candles as the first.
  //
  // Length alone is NOT an identity. Once a series passes 300 bars its length
  // saturates and every later decision point in the window would collide onto
  // the first one computed. That produced 28 distinct contexts for the whole
  // corpus on the first run of this script, and every number it produced was
  // wrong.
  const stamp = (a: Candle[]) => `${a.length}@${a.length ? a[a.length - 1].datetime : "-"}`;
  const memoKey = `${instrument}|${windowId}|${stamp(daily)}|${stamp(weekly)}|${stamp(h4)}|${stamp(h1)}`;
  const hit = ctxMemo.get(memoKey);
  if (hit) return { ...hit, contextTimestamp: new Date(t).toISOString().replace(".000Z", "Z") };

  if (daily.length < 20) return UNAVAILABLE(`daily_bars=${daily.length}<20`, t);
  if (h4.length < 20) return UNAVAILABLE(`h4_bars=${h4.length}<20`, t);
  if (h1.length < 20) return UNAVAILABLE(`h1_bars=${h1.length}<20`, t);

  // ── SMC direction verdict, fed exactly as bot-scanner feeds it ──
  // day_trader: bias=Daily, structure=4H, confirm=1H. confirmedTrend runs on the
  // style's bias timeframe, which for day_trader IS Daily.
  const ct = confirmedTrend(daily, 0.25, 5);
  const sd = determineDirection(daily, h4, h1, {
    h4ChochLookback: 10, h1BosLookback: 8, h4MinBosForFallback: 2,
    fibFactor: 0.25, trendSwingLookback: 5, useConfirmedTrend: true,
    priceAwareStructureBlocks: false,
  });
  const rg = classifyInstrumentRegime(daily);
  const lastPrice = h1[h1.length - 1].close;
  const wb = weekly.length >= 12 ? analyzeWeeklyBiasAndDOL(weekly, lastPrice) : null;

  const v = computeDirectionVerdict({
    confirmedTrend: { trend: ct.trend, reason: ct.reason },
    simpleDirection: {
      direction: sd.direction, bias: sd.bias, biasSource: sd.biasSource,
      h4Retrace: sd.h4Retrace, h4ChochAgainst: sd.h4ChochAgainst,
      h1Confirmed: sd.h1Confirmed, reason: sd.reason,
    },
    regime: { regime: rg.regime, confidence: rg.confidence, directionalBias: rg.directionalBias },
    weeklyBias: wb ? { bias: wb.bias, confidence: wb.confidence } : null,
    // NOT CAUSALLY RECONSTRUCTABLE. Game Plan bias is an LLM premarket output
    // generated on the day and never stored for 2021-2026 history. It is
    // advisory in the verdict — +/- 5 * conf/100 on confidence, and it can never
    // flip direction — so its absence bounds the confidence error at 5 points
    // and cannot change BULLISH/BEARISH. Reported as a limitation, not hidden.
    gamePlanBias: null,
  });

  // ── HTF structure: the value legacy Gate 1 calls htfTrend ──
  const htfRaw = analyzeMarketStructure(daily).trend;

  const out: SmcContext = {
    available: true, unavailableReason: null,
    dirRaw: `${v.verdict}/conf=${v.confidence}/block=${v.shouldBlock}`,
    dirNorm: v.verdict === "long" ? "BULLISH" : v.verdict === "short" ? "BEARISH" : "NEUTRAL",
    dirConfidence: v.confidence, dirShouldBlock: v.shouldBlock, dirAgreement: v.agreement,
    htfRaw, htfNorm: htfRaw === "bullish" ? "BULLISH" : htfRaw === "bearish" ? "BEARISH" : "NEUTRAL",
    contextTimestamp: new Date(t).toISOString().replace(".000Z", "Z"),
    counts: `d=${daily.length} w=${weekly.length} h4=${h4.length} h1=${h1.length}`,
  };
  ctxMemo.set(memoKey, out);
  return out;
}

type Align = "ALIGNED" | "OPPOSED" | "NEUTRAL" | "UNKNOWN";

function alignment(ipoDir: "LONG" | "SHORT", n: Norm): Align {
  if (n === "UNKNOWN") return "UNKNOWN";
  if (n === "NEUTRAL") return "NEUTRAL";
  const want: Norm = ipoDir === "LONG" ? "BULLISH" : "BEARISH";
  return n === want ? "ALIGNED" : "OPPOSED";
}

// ─────────────────────────────────────────────────────────────────────────────
// PART C — tag the Experiment 1 population
// ─────────────────────────────────────────────────────────────────────────────

interface Tagged extends Exp1Row {
  tradeId: string;
  ipoDir: "LONG" | "SHORT";
  smc: SmcContext;
  dirAlign: Align;
  htfAlign: Align;
  resolved: boolean;
  netR: number;
}

const tagged: Tagged[] = [];
for (const r of exp1) {
  const ipoDir: "LONG" | "SHORT" = r.direction === "demand" ? "LONG" : "SHORT";
  const smc = smcContextAt(r.instrument, r.window, ms(r.entryBarTime));
  tagged.push({
    ...r,
    tradeId: `${r.window}|${r.entryBarTime}`,
    ipoDir, smc,
    dirAlign: alignment(ipoDir, smc.dirNorm),
    htfAlign: alignment(ipoDir, smc.htfNorm),
    resolved: r.status === "OK" && typeof r.A_netR === "number" &&
      (r.A_outcome === "TARGET" || r.A_outcome === "S2_CLOSE"),
    netR: typeof r.A_netR === "number" ? r.A_netR : 0,
  });
}

H("PART C — causal availability audit");
{
  const unavail = tagged.filter((t) => !t.smc.available);
  console.log(`  population ${tagged.length}   context available ${tagged.length - unavail.length}   ` +
    `CONTEXT_UNAVAILABLE ${unavail.length}`);
  const reasons: Record<string, number> = {};
  for (const u of unavail) reasons[u.smc.unavailableReason!] = (reasons[u.smc.unavailableReason!] ?? 0) + 1;
  for (const [k, n] of Object.entries(reasons)) console.log(`    ${k}: ${n}`);
  const sample = tagged.find((t) => t.smc.available)!;
  console.log(`  series depths in use, sample: ${sample.smc.counts}`);
  console.log(`  decision instant = IPO entry bar OPEN; no candle overlapping the entry bar is read.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

interface Perf {
  n: number; wins: number; losses: number; win: number; avgW: number; avgL: number;
  expR: number; pf: number; totalR: number; maxDD: number; be: number; gap: number;
  lossStreak: number;
}
function perf(rs: number[]): Perf | null {
  const n = rs.length;
  if (!n) return null;
  const w = rs.filter((x) => x > 0), l = rs.filter((x) => x < 0);
  const gp = w.reduce((a, x) => a + x, 0), gl = Math.abs(l.reduce((a, x) => a + x, 0));
  const tot = rs.reduce((a, x) => a + x, 0);
  let peak = 0, cum = 0, mdd = 0, ls = 0, bl = 0;
  for (const x of rs) {
    cum += x; if (cum > peak) peak = cum; if (peak - cum > mdd) mdd = peak - cum;
    if (x < 0) { ls++; if (ls > bl) bl = ls; } else ls = 0;
  }
  const avgW = w.length ? gp / w.length : 0;
  const avgL = l.length ? -gl / l.length : 0;
  const be = (avgW + Math.abs(avgL)) > 0 ? (Math.abs(avgL) / (avgW + Math.abs(avgL))) * 100 : 0;
  const win = (w.length / n) * 100;
  return { n, wins: w.length, losses: l.length, win, avgW, avgL, expR: tot / n,
    pf: gl ? gp / gl : Infinity, totalR: tot, maxDD: mdd, be, gap: win - be, lossStreak: bl };
}

const PH = `${"cohort".padEnd(28)}${"n".padStart(6)}${"ret%".padStart(7)}${"win%".padStart(7)}${"BE%".padStart(7)}${"gap".padStart(7)}${"avgW".padStart(7)}${"avgL".padStart(7)}${"expR".padStart(9)}${"PF".padStart(7)}${"totR".padStart(9)}${"maxDD".padStart(8)}${"LS".padStart(4)}`;
function prow(label: string, p: Perf | null, base: number) {
  if (!p) { console.log(`${label.padEnd(28)}${"0".padStart(6)}   — no trades`); return; }
  console.log(`${label.padEnd(28)}${String(p.n).padStart(6)}${(base ? p.n / base * 100 : 0).toFixed(0).padStart(7)}` +
    `${p.win.toFixed(1).padStart(7)}${p.be.toFixed(1).padStart(7)}${p.gap.toFixed(1).padStart(7)}` +
    `${p.avgW.toFixed(2).padStart(7)}${p.avgL.toFixed(2).padStart(7)}${p.expR.toFixed(3).padStart(9)}` +
    `${(p.pf === Infinity ? 99.99 : p.pf).toFixed(2).padStart(7)}${p.totalR.toFixed(1).padStart(9)}` +
    `${p.maxDD.toFixed(1).padStart(8)}${String(p.lossStreak).padStart(4)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART D — FIXED_POPULATION cohorts
// ─────────────────────────────────────────────────────────────────────────────

const res = tagged.filter((t) => t.resolved);
const Rs = (ts: Tagged[]) => ts.map((t) => t.netR);
const BASE_N = res.length;

H("PART D — FIXED_POPULATION cohorts (Experiment 1 reconstructed HTF control outcomes)");
console.log(`  unresolved and excluded from every cohort: ${tagged.length - res.length} ` +
  `(TICK_REQUIRED / STILL_OPEN), identical across cohorts.\n`);
console.log(PH);

const COHORTS: Array<[string, (t: Tagged) => boolean]> = [
  ["A BASELINE", () => true],
  ["B DIRECTION_ALIGNED", (t) => t.dirAlign === "ALIGNED"],
  ["C DIRECTION_OPPOSED", (t) => t.dirAlign === "OPPOSED"],
  ["D HTF_STRUCTURE_ALIGNED", (t) => t.htfAlign === "ALIGNED"],
  ["E HTF_STRUCTURE_OPPOSED", (t) => t.htfAlign === "OPPOSED"],
  ["F BOTH_ALIGNED", (t) => t.dirAlign === "ALIGNED" && t.htfAlign === "ALIGNED"],
  ["G DIRECTION_ONLY_ALIGNED", (t) => t.dirAlign === "ALIGNED" && t.htfAlign !== "ALIGNED"],
  ["H HTF_ONLY_ALIGNED", (t) => t.htfAlign === "ALIGNED" && t.dirAlign !== "ALIGNED"],
  ["I BOTH_OPPOSED", (t) => t.dirAlign === "OPPOSED" && t.htfAlign === "OPPOSED"],
  ["J ANY_NEUTRAL_OR_UNKNOWN", (t) => t.dirAlign === "NEUTRAL" || t.dirAlign === "UNKNOWN" ||
    t.htfAlign === "NEUTRAL" || t.htfAlign === "UNKNOWN"],
];
for (const [label, f] of COHORTS) prow(label, perf(Rs(res.filter(f))), BASE_N);

// Accounting invariant: the direction tag and the HTF tag each partition.
for (const [name, get] of [["direction", (t: Tagged) => t.dirAlign], ["htf", (t: Tagged) => t.htfAlign]] as const) {
  const c: Record<string, number> = {};
  for (const t of res) c[get(t)] = (c[get(t)] ?? 0) + 1;
  const sum = Object.values(c).reduce((a, b) => a + b, 0);
  if (sum !== res.length) { console.error(`INVARIANT FAIL ${name}: ${sum} != ${res.length}`); Deno.exit(1); }
  console.log(`  partition ${name}: ${JSON.stringify(c)} sum ${sum} == ${res.length} OK`);
}
{
  const ids = new Set(res.map((t) => t.tradeId));
  if (ids.size !== res.length) { console.error(`INVARIANT FAIL: duplicate trade ids`); Deno.exit(1); }
  console.log(`  unique trade ids: ${ids.size} == ${res.length} OK`);
}

// ── Secondary cross-table ────────────────────────────────────────────────────
H("PART D2 — SMC direction x HTF structure (are the two features redundant?)");
{
  const DN: Norm[] = ["BULLISH", "BEARISH", "NEUTRAL", "UNKNOWN"];
  console.log(`${"".padEnd(12)}${DN.map((h) => `HTF ${h}`.padStart(16)).join("")}${"row total".padStart(12)}`);
  for (const d of DN) {
    const cells = DN.map((h) => res.filter((t) => t.smc.dirNorm === d && t.smc.htfNorm === h));
    console.log(`SMC ${d.padEnd(8)}` + cells.map((c) => {
      const p = perf(Rs(c));
      return `${c.length}/${p ? p.expR.toFixed(2) : "—"}`.padStart(16);
    }).join("") + String(cells.reduce((a, c) => a + c.length, 0)).padStart(12));
  }
  console.log("  cell = n / expectancy R\n");
  console.log("  split by IPO direction:");
  for (const dir of ["LONG", "SHORT"] as const) {
    console.log(`  ${dir}`);
    for (const d of DN) {
      const cells = DN.map((h) => res.filter((t) => t.ipoDir === dir && t.smc.dirNorm === d && t.smc.htfNorm === h));
      if (cells.every((c) => !c.length)) continue;
      console.log(`    SMC ${d.padEnd(8)}` + cells.map((c) => {
        const p = perf(Rs(c));
        return `${c.length}/${p ? p.expR.toFixed(2) : "—"}`.padStart(16);
      }).join(""));
    }
  }
}

// ── Per instrument, long/short, window ───────────────────────────────────────
const FIXED_FILTERS: Array<[string, (t: Tagged) => boolean]> = [
  ["FILTER_0_BASELINE", () => true],
  ["FILTER_1_DIRECTION_ONLY", (t) => t.dirAlign === "ALIGNED"],
  ["FILTER_2_HTF_STRUCTURE_ONLY", (t) => t.htfAlign === "ALIGNED"],
  ["FILTER_3_BOTH_ALIGNED", (t) => t.dirAlign === "ALIGNED" && t.htfAlign === "ALIGNED"],
  ["FILTER_4_EITHER_ALIGNED", (t) => t.dirAlign === "ALIGNED" || t.htfAlign === "ALIGNED"],
];

H("PART D3 — FIXED_POPULATION per instrument");
for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD"]) {
  const set = res.filter((t) => t.instrument === inst);
  console.log(`\n  ${inst}  (baseline n=${set.length})`);
  console.log("  " + PH);
  for (const [label, f] of FIXED_FILTERS) prow("  " + label, perf(Rs(set.filter(f))), set.length);
}

H("PART D4 — FIXED_POPULATION long vs short");
for (const [label, f] of FIXED_FILTERS) {
  console.log(`\n  ${label}`);
  console.log("  " + PH);
  for (const dir of ["LONG", "SHORT"] as const) {
    const set = res.filter((t) => t.ipoDir === dir);
    prow(`  ${dir}`, perf(Rs(set.filter(f))), set.length);
  }
}

const WINDOWS_P = ["p1", "p2", "p3", "p4", "p5"];
H("PART D5 — FIXED_POPULATION by validation window");
console.log(`${"filter".padEnd(30)}${WINDOWS_P.map((w) => w.padStart(18)).join("")}${"pos/total".padStart(12)}`);
for (const [label, f] of FIXED_FILTERS) {
  const cells = WINDOWS_P.map((w) => perf(Rs(res.filter((t) => t.window.startsWith(w + "-") && f(t)))));
  const pos = cells.filter((c) => c && c.totalR > 0).length;
  console.log(label.padEnd(30) + cells.map((c) => (c ? `${c.n}/${c.totalR.toFixed(1)}R` : "—").padStart(18)).join("") +
    `${pos}/${cells.filter(Boolean).length}`.padStart(12));
}

// ─────────────────────────────────────────────────────────────────────────────
// PART E — TRUE_FILTERED_REPLAY
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors ipoLiveEngine.manageOpen exactly. Stop-first on the bar, cost at entry. */
function manage(
  bars: Candle[], k: number, t: { long: boolean; entry: number; stop: number; target: number; risk: number; costR: number },
): { exitIndex: number; exitPrice: number; netR: number } | null {
  const c = bars[k];
  const hitTarget = t.long ? c.high >= t.target : c.low <= t.target;
  const closedBeyond = t.long ? c.close < t.stop : c.close > t.stop;
  if (closedBeyond) {
    const gross = (t.long ? c.close - t.entry : t.entry - c.close) / t.risk;
    return { exitIndex: k, exitPrice: c.close, netR: gross - t.costR };
  }
  if (hitTarget) {
    const gross = Math.abs(t.target - t.entry) / t.risk;
    return { exitIndex: k, exitPrice: t.target, netR: gross - t.costR };
  }
  return null;
}

interface ReplayTrade {
  window: string; instrument: string; entryIndex: number; exitIndex: number;
  ipoIndex: number; direction: "demand" | "supply"; entry: number; stop: number;
  target: number; risk: number; costR: number; vol: string;
  entryBarTime: string; exitBarTime: string; htfNetR: number;
}
interface Rejection { window: string; index: number; barTime: string; reason: string }

/**
 * Re-runs the engine's sequencing from the precomputed candidate table.
 *
 * Every rule comes from the frozen engine: the candidate itself is whatever
 * `runLifecycle` said about the prefix ending at that bar, volatility eligibility
 * is `isEligible`, reachability and E2 are the engine's, `manage` is a transcript
 * of `manageOpen`. The ONE addition is `gate`, and a refusal by `gate` does NOT
 * consume the position slot — which is the whole point of the analysis.
 *
 * Asserted below to reproduce `replay()` exactly when the gate is wired open.
 */
function sequence(
  w: WindowTable, highVolOnly: boolean, costPerSide: (p: number) => number,
  gate: (barTime: string, dir: "demand" | "supply") => { pass: boolean; reason: string },
): { trades: ReplayTrade[]; rejections: Rejection[] } {
  const trades: ReplayTrade[] = [];
  const rejections: Rejection[] = [];
  let open: (ReplayTrade & { long: boolean }) | null = null;
  let lastExit = -1;

  for (let k = 0; k < w.bars.length; k++) {
    const bar = w.bars[k];
    const bucket = w.rows[k].vol;

    if (open) {
      const done = manage(w.bars, k, open);
      if (done) {
        open.exitIndex = done.exitIndex; open.htfNetR = done.netR;
        open.exitBarTime = w.bars[done.exitIndex].datetime;
        trades.push(open); lastExit = k; open = null;
      }
    }
    if (open || k <= lastExit) continue;

    const hit = w.rows[k].hit;
    if (!hit) continue;
    if (!isEligible(bucket as VolBucket, highVolOnly)) continue;

    const long = hit.direction === "demand";
    const entry = long ? hit.zoneLow : hit.zoneHigh;
    const reached = long ? bar.low <= entry : bar.high >= entry;
    if (!reached) continue;
    const stop = hit.invalidationLevel;
    const risk = Math.abs(entry - stop);
    if (risk <= 0) continue;

    // ── the one added decision ──
    const g = gate(bar.datetime, hit.direction);
    if (!g.pass) { rejections.push({ window: w.window, index: k, barTime: bar.datetime, reason: g.reason }); continue; }

    open = {
      window: w.window, instrument: w.instrument, entryIndex: k, exitIndex: -1,
      ipoIndex: hit.candidateIndex, direction: hit.direction, entry, stop,
      target: long ? entry + 2 * risk : entry - 2 * risk, risk,
      costR: (2 * costPerSide(bar.close)) / risk, vol: bucket,
      entryBarTime: bar.datetime, exitBarTime: "", htfNetR: 0, long,
    };
    const sameBar = manage(w.bars, k, open);
    if (sameBar) {
      open.exitIndex = sameBar.exitIndex; open.htfNetR = sameBar.netR;
      open.exitBarTime = w.bars[sameBar.exitIndex].datetime;
      trades.push(open); lastExit = k; open = null;
    }
  }
  return { trades, rejections };
}

const OPEN_GATE = () => ({ pass: true, reason: "" });

H("PART E1 — sequencer equivalence with the unmodified ipoLiveEngine");
{
  let checked = 0, mismatches = 0;
  for (const w of Object.values(tables)) {
    if (!w.completed) continue;
    const inst = IPO_INSTRUMENTS.find((i) => i.instrument === w.instrument)!;
    const got = sequence(w, inst.highVolOnly, inst.costPerSide, OPEN_GATE).trades;
    const want = ckpt[w.window].trades_detail;
    if (got.length !== want.length) {
      console.log(`  ${w.window}: ${got.length} trades vs engine ${want.length}  <-- MISMATCH`);
      mismatches++; continue;
    }
    let bad = 0;
    for (let i = 0; i < got.length; i++) {
      const a = got[i], b = want[i];
      const same = a.entryIndex === b.entryIndex && a.exitIndex === b.exitIndex &&
        a.ipoIndex === b.ipoIndex && a.direction === b.direction && a.vol === b.vol &&
        Math.abs(a.entry - b.entry) < 1e-12 && Math.abs(a.stop - b.stop) < 1e-12 &&
        Math.abs(a.target - b.target) < 1e-12 && Math.abs(a.risk - b.risk) < 1e-12 &&
        Math.abs(a.costR - b.costR) < 1e-12 && Math.abs(a.htfNetR - b.netR) < 1e-9;
      if (!same) bad++;
    }
    checked += got.length;
    if (bad) { console.log(`  ${w.window}: ${bad}/${got.length} trades differ  <-- MISMATCH`); mismatches++; }
  }
  if (mismatches) {
    console.error(`\nFATAL: the sequencer is not equivalent to the frozen engine in ${mismatches} window(s).`);
    Deno.exit(1);
  }
  console.log(`  ${checked} trades across ${Object.keys(tables).length} windows reproduce ` +
    `ipoLiveEngine.replay() field-for-field. Sequencer validated.`);
}

// ── 1m resolution for trades the baseline never took ─────────────────────────

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const isDecimalShift = (b: Candle) => b.low < Math.min(b.open, b.close) / 100;
const isWholeBarShift = (b: Candle, ref: number) => b.high < ref / 100;

function tape(sym: string, fromMs: number, toMs: number, ref: number): Candle[] {
  const out: Candle[] = [];
  for (let d = new Date(fromMs).toISOString().slice(0, 10);
    Date.parse(`${d}T00:00:00Z`) <= toMs; d = addDays(d, 1)) {
    for (const m of minutes[`${sym}|${d}`] ?? []) {
      const t = ms(m.datetime);
      if (t >= fromMs && t <= toMs) out.push(m);
    }
  }
  return out.filter((m) => !isDecimalShift(m) && !isWholeBarShift(m, ref));
}

/**
 * The Experiment 1 reconstructed HTF control, applied to one trade: causal entry
 * minute inside the entry bar, target tested every minute, S2 confirmed only at
 * HTF bar closes. Identical semantics to `runVersion("A_HTF", ...)`.
 */
function resolve1m(
  t: ReplayTrade, htfBars: Candle[], barMs: number, windowEndMs: number,
): { status: string; netR: number | null } {
  const long = t.direction === "demand";
  const barStart = ms(t.entryBarTime);
  const tp = tape(t.instrument, barStart, windowEndMs, t.entry);
  if (!tp.length) return { status: "DATA_UNAVAILABLE", netR: null };
  const barEnd = barStart + barMs;
  const eIdx = tp.findIndex((m) => {
    const x = ms(m.datetime);
    return x >= barStart && x < barEnd && (long ? m.low <= t.entry : m.high >= t.entry);
  });
  if (eIdx < 0) return { status: "NO_ENTRY_AT_1M", netR: null };
  const em = tp[eIdx];
  if (long ? em.high >= t.target : em.low <= t.target) return { status: "TICK_REQUIRED", netR: null };

  const htfClose = new Map(htfBars.filter((b) => ms(b.datetime) >= barStart)
    .map((h) => [ms(h.datetime) + barMs, h.close]));
  for (let i = eIdx; i < tp.length; i++) {
    const m = tp[i];
    if (long ? m.high >= t.target : m.low <= t.target) {
      return { status: "TARGET", netR: Math.abs(t.target - t.entry) / t.risk - t.costR };
    }
    const close = htfClose.get(ms(m.datetime) + 60000);
    if (close !== undefined && (long ? close < t.stop : close > t.stop)) {
      const gross = (long ? close - t.entry : t.entry - close) / t.risk;
      return { status: "S2_CLOSE", netR: gross - t.costR };
    }
  }
  return { status: "STILL_OPEN", netR: null };
}

const htfCache: Record<string, Candle[]> = JSON.parse(await Deno.readTextFile("/tmp/td-htf-windows.json"));
const exp1ByIdWithStatus = new Map(tagged.map((t) => [t.tradeId, t]));
const resolveMemo = new Map<string, { status: string; netR: number | null }>();

function outcomeOf(t: ReplayTrade): { status: string; netR: number | null; fromExp1: boolean } {
  const id = `${t.window}|${t.entryBarTime}`;
  const known = exp1ByIdWithStatus.get(id);
  if (known) {
    return {
      status: known.status === "OK" ? (known.A_outcome ?? "STILL_OPEN") : known.status,
      netR: known.resolved ? known.netR : null,
      fromExp1: true,
    };
  }
  const memo = resolveMemo.get(id);
  if (memo) return { ...memo, fromExp1: false };
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === t.instrument)!;
  const w = tables[t.window];
  const interval = inst.timeframe === "30min" ? "30min" : "1h";
  const htfBars = (htfCache[`${t.instrument}|${interval}|${w.from}|${w.to}`] ?? [])
    .filter((b) => !isDecimalShift(b));
  const out = resolve1m(t, htfBars, inst.barMs, ms(`${w.to}T00:00:00Z`));
  resolveMemo.set(id, out);
  return { ...out, fromExp1: false };
}

// ── run the filter variants ──────────────────────────────────────────────────

type GateFn = (barTime: string, dir: "demand" | "supply", inst: string, win: string) =>
  { pass: boolean; reason: string };

function contextGate(mode: "none" | "dir" | "htf" | "both" | "either"): GateFn {
  return (barTime, dir, inst, win) => {
    if (mode === "none") return { pass: true, reason: "" };
    const ipoDir: "LONG" | "SHORT" = dir === "demand" ? "LONG" : "SHORT";
    const c = smcContextAt(inst, win, ms(barTime));
    const d = alignment(ipoDir, c.dirNorm);
    const h = alignment(ipoDir, c.htfNorm);
    const ok = mode === "dir" ? d === "ALIGNED"
      : mode === "htf" ? h === "ALIGNED"
      : mode === "both" ? (d === "ALIGNED" && h === "ALIGNED")
      : (d === "ALIGNED" || h === "ALIGNED");
    return { pass: ok, reason: ok ? "" : `dir=${d} htf=${h}` };
  };
}

const VARIANTS: Array<[string, "none" | "dir" | "htf" | "both" | "either"]> = [
  ["FILTER_0_BASELINE", "none"],
  ["FILTER_1_DIRECTION_ONLY", "dir"],
  ["FILTER_2_HTF_STRUCTURE_ONLY", "htf"],
  ["FILTER_3_BOTH_ALIGNED", "both"],
  ["FILTER_4_EITHER_ALIGNED", "either"],
];

interface VariantResult {
  label: string;
  trades: ReplayTrade[];
  rejections: Rejection[];
  resolved: Array<{ t: ReplayTrade; netR: number }>;
  unresolved: Record<string, number>;
  newTrades: number;
  droppedBaseline: number;
}
const variantResults: VariantResult[] = [];

for (const [label, mode] of VARIANTS) {
  const gate = contextGate(mode);
  const trades: ReplayTrade[] = [];
  const rejections: Rejection[] = [];
  for (const w of Object.values(tables)) {
    if (!w.completed) continue;
    if (w.window === EXCLUDED_WINDOW) continue;
    const inst = IPO_INSTRUMENTS.find((i) => i.instrument === w.instrument)!;
    const r = sequence(w, inst.highVolOnly, inst.costPerSide,
      (bt, d) => gate(bt, d, w.instrument, w.window));
    trades.push(...r.trades);
    rejections.push(...r.rejections);
  }
  const resolvedT: Array<{ t: ReplayTrade; netR: number }> = [];
  const unresolved: Record<string, number> = {};
  for (const t of trades) {
    const o = outcomeOf(t);
    if (o.netR !== null && (o.status === "TARGET" || o.status === "S2_CLOSE")) {
      resolvedT.push({ t, netR: o.netR });
    } else unresolved[o.status] = (unresolved[o.status] ?? 0) + 1;
  }
  const baselineIds = new Set(tagged.filter((t) => t.window !== EXCLUDED_WINDOW).map((t) => t.tradeId));
  const ids = new Set(trades.map((t) => `${t.window}|${t.entryBarTime}`));
  variantResults.push({
    label, trades, rejections, resolved: resolvedT, unresolved,
    newTrades: [...ids].filter((i) => !baselineIds.has(i)).length,
    droppedBaseline: [...baselineIds].filter((i) => !ids.has(i)).length,
  });
}

H("PART E2 — TRUE_FILTERED_REPLAY accounting");
{
  const base = variantResults[0];
  console.log(`  FILTER_0 reproduces the baseline population: ${base.trades.length} trades, ` +
    `${base.newTrades} new, ${base.droppedBaseline} dropped (both must be 0)`);
  if (base.newTrades !== 0 || base.droppedBaseline !== 0) {
    console.error("FATAL: the unfiltered true replay does not reproduce the baseline population.");
    Deno.exit(1);
  }
  console.log(`\n${"variant".padEnd(30)}${"taken".padStart(8)}${"refused".padStart(9)}${"resolved".padStart(10)}` +
    `${"new".padStart(6)}${"dropped".padStart(9)}  unresolved`);
  for (const v of variantResults) {
    const cand = v.trades.length + v.rejections.length;
    console.log(`${v.label.padEnd(30)}${String(v.trades.length).padStart(8)}${String(v.rejections.length).padStart(9)}` +
      `${String(v.resolved.length).padStart(10)}${String(v.newTrades).padStart(6)}${String(v.droppedBaseline).padStart(9)}  ` +
      `${JSON.stringify(v.unresolved)}   [taken+refused=${cand}]`);
    const sum = v.resolved.length + Object.values(v.unresolved).reduce((a, b) => a + b, 0);
    if (sum !== v.trades.length) { console.error(`INVARIANT FAIL ${v.label}: ${sum} != ${v.trades.length}`); Deno.exit(1); }
  }
}

H("PART E3 — TRUE_FILTERED_REPLAY performance");
console.log(PH);
const trueBaseN = variantResults[0].resolved.length;
for (const v of variantResults) prow(v.label, perf(v.resolved.map((x) => x.netR)), trueBaseN);

H("PART E4 — TRUE_FILTERED_REPLAY per instrument");
for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD"]) {
  console.log(`\n  ${inst}`);
  console.log("  " + PH);
  const bn = variantResults[0].resolved.filter((x) => x.t.instrument === inst).length;
  for (const v of variantResults) {
    prow("  " + v.label, perf(v.resolved.filter((x) => x.t.instrument === inst).map((x) => x.netR)), bn);
  }
}

H("PART E5 — TRUE_FILTERED_REPLAY long vs short");
for (const v of variantResults) {
  console.log(`\n  ${v.label}`);
  console.log("  " + PH);
  for (const dir of ["demand", "supply"] as const) {
    const bn = variantResults[0].resolved.filter((x) => x.t.direction === dir).length;
    prow(`  ${dir === "demand" ? "LONG" : "SHORT"}`,
      perf(v.resolved.filter((x) => x.t.direction === dir).map((x) => x.netR)), bn);
  }
}

H("PART E6 — TRUE_FILTERED_REPLAY by validation window");
console.log(`${"filter".padEnd(30)}${WINDOWS_P.map((w) => w.padStart(18)).join("")}${"pos/total".padStart(12)}`);
for (const v of variantResults) {
  const cells = WINDOWS_P.map((w) => perf(v.resolved.filter((x) => x.t.window.startsWith(w + "-")).map((x) => x.netR)));
  const pos = cells.filter((c) => c && c.totalR > 0).length;
  console.log(v.label.padEnd(30) + cells.map((c) => (c ? `${c.n}/${c.totalR.toFixed(1)}R` : "—").padStart(18)).join("") +
    `${pos}/${cells.filter(Boolean).length}`.padStart(12));
}

// ─────────────────────────────────────────────────────────────────────────────
// PART F — feature value, interaction, concentration
// ─────────────────────────────────────────────────────────────────────────────

H("PART F1 — feature value: does the context separate outcomes?");
{
  const pairs: Array<[string, Tagged[], string, Tagged[]]> = [
    ["direction ALIGNED", res.filter((t) => t.dirAlign === "ALIGNED"),
      "direction OPPOSED", res.filter((t) => t.dirAlign === "OPPOSED")],
    ["HTF ALIGNED", res.filter((t) => t.htfAlign === "ALIGNED"),
      "HTF OPPOSED", res.filter((t) => t.htfAlign === "OPPOSED")],
    ["BOTH ALIGNED", res.filter((t) => t.dirAlign === "ALIGNED" && t.htfAlign === "ALIGNED"),
      "BOTH OPPOSED", res.filter((t) => t.dirAlign === "OPPOSED" && t.htfAlign === "OPPOSED")],
  ];
  console.log(`${"comparison".padEnd(34)}${"n+".padStart(6)}${"n-".padStart(6)}${"dWin".padStart(8)}${"dExpR".padStart(9)}${"dPF".padStart(8)}${"dAvgL".padStart(8)}${"dMaxDD".padStart(9)}`);
  for (const [la, a, lb, b] of pairs) {
    const pa = perf(Rs(a)), pb = perf(Rs(b));
    if (!pa || !pb) { console.log(`${(la + " vs " + lb).padEnd(34)}  insufficient`); continue; }
    console.log(`${(la + " vs " + lb).padEnd(34)}${String(pa.n).padStart(6)}${String(pb.n).padStart(6)}` +
      `${(pa.win - pb.win).toFixed(1).padStart(8)}${(pa.expR - pb.expR).toFixed(3).padStart(9)}` +
      `${(pa.pf - pb.pf).toFixed(2).padStart(8)}${(pa.avgL - pb.avgL).toFixed(2).padStart(8)}` +
      `${(pa.maxDD - pb.maxDD).toFixed(1).padStart(9)}`);
  }
}

H("PART F2 — interaction: does combining beat either alone?");
{
  const base = perf(Rs(res))!;
  const d = perf(Rs(res.filter((t) => t.dirAlign === "ALIGNED")));
  const h = perf(Rs(res.filter((t) => t.htfAlign === "ALIGNED")));
  const b = perf(Rs(res.filter((t) => t.dirAlign === "ALIGNED" && t.htfAlign === "ALIGNED")));
  const f = (p: Perf | null) => p ? `${p.expR.toFixed(3)} (n=${p.n}, PF ${p.pf.toFixed(2)})` : "—";
  console.log(`  baseline            ${f(base)}`);
  console.log(`  direction only      ${f(d)}`);
  console.log(`  HTF structure only  ${f(h)}`);
  console.log(`  both aligned        ${f(b)}`);
  if (d && h && b) {
    const best = Math.max(d.expR, h.expR);
    const lift = b.expR - best;
    console.log(`\n  both minus best single feature: ${lift >= 0 ? "+" : ""}${lift.toFixed(3)}R  ` +
      `-> ${Math.abs(lift) < 0.02 ? "REDUNDANT (within noise)" : lift > 0 ? "COMPLEMENTARY" : "WORSE THAN EITHER ALONE"}`);
  }
}

H("PART F3 — concentration of any profitable filter");
for (const [label, f] of FIXED_FILTERS.slice(1)) {
  const set = res.filter(f);
  const p = perf(Rs(set));
  if (!p || p.totalR <= 0) { console.log(`  ${label}: total ${p ? p.totalR.toFixed(1) : "—"}R — not profitable, no concentration check`); continue; }
  console.log(`  ${label}: ${p.totalR.toFixed(1)}R over ${p.n} trades`);
  const groups: Array<[string, (t: Tagged) => string]> = [
    ["instrument", (t) => t.instrument],
    ["direction", (t) => t.ipoDir],
    ["window", (t) => t.window.slice(0, 2)],
    ["instrument x direction", (t) => `${t.instrument} ${t.ipoDir}`],
  ];
  for (const [gname, key] of groups) {
    const by: Record<string, number[]> = {};
    for (const t of set) (by[key(t)] ??= []).push(t.netR);
    const rows = Object.entries(by).map(([k, v]) => ({ k, n: v.length, r: v.reduce((a, x) => a + x, 0) }))
      .sort((a, b) => b.r - a.r);
    const top = rows[0];
    const shareR = (top.r / p.totalR) * 100, shareN = (top.n / p.n) * 100;
    const flag = shareN < 20 && shareR > 50 ? "  <-- CONCENTRATION FLAG" : "";
    console.log(`    best ${gname.padEnd(22)} ${top.k.padEnd(18)} ${top.n} trades (${shareN.toFixed(0)}% of n) ` +
      `${top.r.toFixed(1)}R (${shareR.toFixed(0)}% of profit)${flag}`);
  }
}

H("PART F4 — how much do the two features actually move?");
{
  // A slow feature over five two-month windows is close to a per-window
  // constant, and a per-window constant crossed with IPO direction is not a
  // signal, it is a relabelling of the window. Measure it rather than assume.
  console.log(`${"window".padEnd(14)}${"n".padStart(5)}  ${"SMC direction states".padEnd(34)}${"HTF structure states".padEnd(34)}${"dir flips".padStart(10)}${"htf flips".padStart(10)}`);
  for (const w of [...new Set(tagged.map((t) => t.window))].sort()) {
    const set = tagged.filter((t) => t.window === w);
    const d: Record<string, number> = {}, h: Record<string, number> = {};
    let df = 0, hf = 0;
    for (let i = 0; i < set.length; i++) {
      d[set[i].smc.dirNorm] = (d[set[i].smc.dirNorm] ?? 0) + 1;
      h[set[i].smc.htfNorm] = (h[set[i].smc.htfNorm] ?? 0) + 1;
      if (i && set[i].smc.dirNorm !== set[i - 1].smc.dirNorm) df++;
      if (i && set[i].smc.htfNorm !== set[i - 1].smc.htfNorm) hf++;
    }
    const fmt = (o: Record<string, number>) =>
      Object.entries(o).map(([k, v]) => `${k.slice(0, 4)}:${v}`).join(" ").padEnd(34);
    console.log(`${w.padEnd(14)}${String(set.length).padStart(5)}  ${fmt(d)}${fmt(h)}${String(df).padStart(10)}${String(hf).padStart(10)}`);
  }
  const blocked = tagged.filter((t) => t.smc.dirShouldBlock).length;
  const neutral = tagged.filter((t) => t.smc.dirNorm === "NEUTRAL").length;
  console.log(`\n  verdict NEUTRAL at ${neutral}/${tagged.length} decisions; verdict would BLOCK at ${blocked}/${tagged.length}.`);
  const conf = tagged.map((t) => t.smc.dirConfidence).sort((a, b) => a - b);
  console.log(`  verdict confidence: min ${conf[0]} p25 ${conf[Math.floor(conf.length * 0.25)]} ` +
    `median ${conf[Math.floor(conf.length * 0.5)]} p75 ${conf[Math.floor(conf.length * 0.75)]} max ${conf[conf.length - 1]}`);
}

H("PART F5 — concentration of the OPPOSED cohorts (the result that came out inverted)");
for (const [label, f] of [
  ["HTF_STRUCTURE_OPPOSED", (t: Tagged) => t.htfAlign === "OPPOSED"],
  ["BOTH_OPPOSED", (t: Tagged) => t.dirAlign === "OPPOSED" && t.htfAlign === "OPPOSED"],
] as Array<[string, (t: Tagged) => boolean]>) {
  const set = res.filter(f);
  const p = perf(Rs(set));
  if (!p) continue;
  console.log(`  ${label}: ${p.totalR.toFixed(1)}R over ${p.n} trades, expR ${p.expR.toFixed(3)}, PF ${p.pf.toFixed(2)}`);
  for (const [gname, key] of [
    ["instrument", (t: Tagged) => t.instrument],
    ["direction", (t: Tagged) => t.ipoDir],
    ["window", (t: Tagged) => t.window.slice(0, 2)],
    ["instrument x direction", (t: Tagged) => `${t.instrument} ${t.ipoDir}`],
  ] as Array<[string, (t: Tagged) => string]>) {
    const by: Record<string, number[]> = {};
    for (const t of set) (by[key(t)] ??= []).push(t.netR);
    const rows = Object.entries(by).map(([k, v]) => ({ k, n: v.length, r: v.reduce((a, x) => a + x, 0) }))
      .sort((a, b) => b.r - a.r);
    const top = rows[0];
    const shareR = (top.r / p.totalR) * 100, shareN = (top.n / p.n) * 100;
    console.log(`    best ${gname.padEnd(22)} ${top.k.padEnd(18)} ${top.n} trades (${shareN.toFixed(0)}% of n) ` +
      `${top.r.toFixed(1)}R (${shareR.toFixed(0)}% of profit)${shareN < 20 && shareR > 50 ? "  <-- CONCENTRATION FLAG" : ""}`);
  }
  // Does the separation hold inside each instrument, or only in aggregate?
  console.log(`    within-instrument check (OPPOSED minus ALIGNED expectancy):`);
  for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD"]) {
    const isBoth = label === "BOTH_OPPOSED";
    const opp = res.filter((t) => t.instrument === inst && f(t));
    const ali = res.filter((t) => t.instrument === inst &&
      (isBoth ? (t.dirAlign === "ALIGNED" && t.htfAlign === "ALIGNED") : t.htfAlign === "ALIGNED"));
    const po = perf(Rs(opp)), pa = perf(Rs(ali));
    console.log(`      ${inst.padEnd(9)} opposed ${po ? `${po.expR.toFixed(3)} (n=${po.n})` : "—"}   ` +
      `aligned ${pa ? `${pa.expR.toFixed(3)} (n=${pa.n})` : "—"}   ` +
      `delta ${po && pa ? (po.expR - pa.expR >= 0 ? "+" : "") + (po.expR - pa.expR).toFixed(3) : "—"}`);
  }
  // Does it hold in every window?
  const wins = WINDOWS_P.map((w) => {
    const isBoth = label === "BOTH_OPPOSED";
    const opp = perf(Rs(res.filter((t) => t.window.startsWith(w + "-") && f(t))));
    const ali = perf(Rs(res.filter((t) => t.window.startsWith(w + "-") &&
      (isBoth ? (t.dirAlign === "ALIGNED" && t.htfAlign === "ALIGNED") : t.htfAlign === "ALIGNED"))));
    return opp && ali ? { w, d: opp.expR - ali.expR, no: opp.n, na: ali.n } : null;
  }).filter(Boolean) as Array<{ w: string; d: number; no: number; na: number }>;
  console.log(`    within-window check: ` + wins.map((x) => `${x.w} ${x.d >= 0 ? "+" : ""}${x.d.toFixed(2)}`).join("  ") +
    `   -> opposed better in ${wins.filter((x) => x.d > 0).length}/${wins.length} windows`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART G — machine-readable output
// ─────────────────────────────────────────────────────────────────────────────

const trueInclusion = new Map<string, string>();
for (const v of variantResults) {
  for (const t of v.trades) {
    const id = `${t.window}|${t.entryBarTime}`;
    trueInclusion.set(`${v.label}|${id}`, "INCLUDED");
  }
  for (const r of v.rejections) trueInclusion.set(`${v.label}|${r.window}|${r.barTime}`, `REFUSED:${r.reason}`);
}

const flat = tagged.map((t) => ({
  trade_id: t.tradeId,
  instrument: t.instrument,
  window: t.window,
  ipo_direction: t.ipoDir,
  ipo_timestamp: t.entryBarTime,
  entry_timestamp: t.entryMinute ?? t.entryBarTime,
  entry_price: t.entry,
  s2: t.s2,
  target: t.target,
  exit_reason: t.A_outcome ?? t.status,
  net_r: t.resolved ? t.netR : null,
  smc_direction_raw: t.smc.dirRaw,
  smc_direction_normalized: t.smc.dirNorm,
  smc_direction_alignment: t.dirAlign,
  smc_direction_confidence: t.smc.dirConfidence,
  smc_direction_would_block: t.smc.dirShouldBlock,
  htf_structure_raw: t.smc.htfRaw,
  htf_structure_normalized: t.smc.htfNorm,
  htf_structure_alignment: t.htfAlign,
  context_timestamp: t.smc.contextTimestamp,
  context_source_timeframe: "1d(bias,regime,htf-structure) / 4h(structure) / 1h(confirm) / 1w(weekly bias)",
  context_available: t.smc.available,
  context_unavailable_reason: t.smc.unavailableReason,
  cohort_fixed: [
    t.dirAlign === "ALIGNED" ? "DIRECTION_ALIGNED" : t.dirAlign === "OPPOSED" ? "DIRECTION_OPPOSED" : `DIRECTION_${t.dirAlign}`,
    t.htfAlign === "ALIGNED" ? "HTF_ALIGNED" : t.htfAlign === "OPPOSED" ? "HTF_OPPOSED" : `HTF_${t.htfAlign}`,
  ].join("+"),
  true_replay_f1: trueInclusion.get(`FILTER_1_DIRECTION_ONLY|${t.tradeId}`) ??
    trueInclusion.get(`FILTER_1_DIRECTION_ONLY|${t.window}|${t.entryBarTime}`) ?? "NOT_REACHED",
  true_replay_f2: trueInclusion.get(`FILTER_2_HTF_STRUCTURE_ONLY|${t.tradeId}`) ??
    trueInclusion.get(`FILTER_2_HTF_STRUCTURE_ONLY|${t.window}|${t.entryBarTime}`) ?? "NOT_REACHED",
  true_replay_f3: trueInclusion.get(`FILTER_3_BOTH_ALIGNED|${t.tradeId}`) ??
    trueInclusion.get(`FILTER_3_BOTH_ALIGNED|${t.window}|${t.entryBarTime}`) ?? "NOT_REACHED",
}));

await Deno.writeTextFile("/tmp/v2-exp2-smc-context.json", JSON.stringify(flat, null, 1));
const cols = Object.keys(flat[0]);
await Deno.writeTextFile("/tmp/v2-exp2-smc-context.csv",
  [cols.join(",")].concat(flat.map((r) =>
    cols.map((c) => {
      const v = (r as Record<string, unknown>)[c];
      return v === null || v === undefined ? "" : String(v).includes(",") ? `"${String(v)}"` : String(v);
    }).join(","))).join("\n"));

// New trades admitted by each filter, listed separately.
const newRows = variantResults.flatMap((v) => {
  const baselineIds = new Set(tagged.map((t) => t.tradeId));
  return v.trades
    .filter((t) => !baselineIds.has(`${t.window}|${t.entryBarTime}`))
    .map((t) => ({ filter: v.label, ...t, outcome: outcomeOf(t) }));
});
await Deno.writeTextFile("/tmp/v2-exp2-new-trades.json", JSON.stringify(newRows, null, 1));

console.log(`\nwrote ${flat.length} tagged rows to /tmp/v2-exp2-smc-context.{json,csv}`);
console.log(`wrote ${newRows.length} freed-slot admissions to /tmp/v2-exp2-new-trades.json`);
console.log(`context computations memoised: ${ctxMemo.size} distinct SMC states`);
