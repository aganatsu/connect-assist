/**
 * TREND_PREREG_V1 — the study runner (docs/TREND_PREREG_V1.md). Reads the trend-fetch.ts cache only.
 *
 *   deno run --allow-read --allow-write local-runner/trend-backtest.ts           # in-sample + G1
 *   deno run --allow-read --allow-write local-runner/trend-backtest.ts --oos     # + OOS, once, only if G1 passed
 *
 * THE OOS LOCK IS IN CODE, not in discipline: without --oos no OOS trade is summarised or
 * written, and --oos refuses to run unless G1 passes on the in-sample result computed in the
 * same run. Descriptive extras (2× cost, neighbours, placebo) cover only the unlocked periods.
 */

import { type Bar, type Cost, mulberry32, PRIMARY, type Params, runTrend, summarize, type Summary, type Trade } from "./trendEngine.ts";
import { cacheFile, INSTRUMENTS } from "./trend-fetch.ts";

const IS = { from: "2015-01-01", to: "2023-01-01" };
const OOS = { from: "2023-01-01", to: "2026-11-01" };
const RISK_PCT = 0.5;

/** Round-trip costs and financing, frozen in the pre-registration. */
const PIP: Record<string, number> = { "USD/JPY": 0.01 };
const FX_RT_PIPS: Record<string, number> = { "EUR/USD": 2.0, "GBP/USD": 2.5, "USD/JPY": 2.0, "AUD/USD": 2.5, "NZD/USD": 3.0, "USD/CAD": 2.5, "USD/CHF": 2.5 };
export function costFor(inst: string, mult = 1): Cost {
  if (inst === "XAU/USD") return { roundTrip: 0.5 * mult, roundTripPct: 0, finPerYear: 0.01 * mult };
  if (inst === "BTC/USD") return { roundTrip: 0, roundTripPct: 0.002 * mult, finPerYear: 0.10 * mult };
  return { roundTrip: FX_RT_PIPS[inst] * (PIP[inst] ?? 0.0001) * mult, roundTripPct: 0, finPerYear: 0.01 * mult };
}

function loadBars(inst: string): Bar[] {
  const bars: Bar[] = JSON.parse(Deno.readTextFileSync(cacheFile(inst)));
  if (inst === "BTC/USD") return bars;
  return bars.filter((b) => { const d = new Date(b.t).getUTCDay(); return d !== 0 && d !== 6; });
}

/** Data integrity: reported, never repaired. A bad bar is printed so it can be judged by eye. */
function integrity(inst: string, bars: Bar[]): string {
  const bad = bars.filter((b) => b.h < b.l || b.o > b.h || b.o < b.l || b.c > b.h || b.c < b.l || b.l <= 0);
  const maxGap = inst === "BTC/USD" ? 2 : 4;
  let gaps = 0;
  for (let i = 1; i < bars.length; i++) if ((Date.parse(bars[i].t) - Date.parse(bars[i - 1].t)) / 86_400_000 > maxGap) gaps++;
  return `${inst.padEnd(8)} ${String(bars.length).padStart(5)} bars  ${bars[0].t.slice(0, 10)} → ${bars.at(-1)!.t.slice(0, 10)}  bad OHLC ${bad.length}  gaps>${maxGap}d ${gaps}`;
}

type Tagged = Trade & { inst: string };
const inWin = (t: Trade, w: { from: string; to: string }) => t.entryT >= w.from && t.entryT < w.to && t.reason !== "OPEN";

function runAll(p: Params, costMult = 1): Tagged[] {
  const out: Tagged[] = [];
  for (const inst of INSTRUMENTS) for (const t of runTrend(loadBars(inst), p, costFor(inst, costMult))) out.push({ ...t, inst });
  return out.sort((a, b) => a.exitT.localeCompare(b.exitT));
}

const f = (x: number, d = 3) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : String(x));
const line = (label: string, s: Summary) =>
  `${label.padEnd(22)} n=${String(s.n).padStart(4)}  WR ${(s.wr * 100).toFixed(1).padStart(5)}%  exp ${f(s.exp)}R  95%CI [${f(s.ciLo)}, ${f(s.ciHi)}]  PF ${s.pf.toFixed(2)}  total ${f(s.total, 1)}R  maxDD ${s.maxDD.toFixed(1)}R`;

function report(title: string, ts: Tagged[], years: number) {
  console.log(`\n=== ${title} ===`);
  const all = summarize(ts.map((t) => t.netR));
  console.log(line("PORTFOLIO net", all));
  console.log(line("PORTFOLIO gross", summarize(ts.map((t) => t.grossR))));
  const avgCost = ts.reduce((s, t) => s + t.costR, 0) / ts.length;
  const avgDays = ts.reduce((s, t) => s + t.days, 0) / ts.length;
  console.log(`avg cost ${avgCost.toFixed(3)}R/trade  avg hold ${avgDays.toFixed(1)} days  trades/yr ${(ts.length / years).toFixed(1)}`);
  console.log(`at ${RISK_PCT}% risk/trade (non-compounding, closed-trade sequence): ${f(all.total * RISK_PCT, 1)}% total, ${f(all.total * RISK_PCT / years, 1)}%/yr, maxDD ${(all.maxDD * RISK_PCT).toFixed(1)}%`);
  console.log("-- by instrument");
  const per: Record<string, Summary> = {};
  for (const inst of INSTRUMENTS) { per[inst] = summarize(ts.filter((t) => t.inst === inst).map((t) => t.netR)); console.log(line(`  ${inst}`, per[inst])); }
  console.log("-- by entry year");
  for (const y of [...new Set(ts.map((t) => t.entryT.slice(0, 4)))].sort()) console.log(line(`  ${y}`, summarize(ts.filter((t) => t.entryT.startsWith(y)).map((t) => t.netR))));
  console.log("-- by exit reason");
  for (const r of ["STOP", "STOP_GAP", "CHANNEL"]) console.log(line(`  ${r}`, summarize(ts.filter((t) => t.reason === r).map((t) => t.netR))));
  return { all, per };
}

function writeCsv(name: string, ts: Tagged[]) {
  const cols = ["inst", "dir", "signalT", "entryT", "exitT", "entry", "stop", "risk", "exit", "reason", "days", "grossR", "costR", "netR"] as const;
  const rows = ts.map((t) => cols.map((c) => String(t[c])).join(","));
  Deno.writeTextFileSync(new URL(`../docs/exports/${name}`, import.meta.url), [cols.join(","), ...rows].join("\n") + "\n");
  console.log(`wrote docs/exports/${name} (${ts.length} trades)`);
}

/** Placebo: same exits and costs, entries on flat days at the real entry rate, random direction. */
function placebo(windows: Array<{ from: string; to: string }>, realCount: number, flatDays: number, sims = 200): number[] {
  const q = realCount / flatDays;
  const means: number[] = [];
  for (let s = 0; s < sims; s++) {
    const rnd = mulberry32(1000 + s);
    const rs: number[] = [];
    for (const inst of INSTRUMENTS) {
      const ts = runTrend(loadBars(inst), PRIMARY, costFor(inst), () => (rnd() < q ? (rnd() < 0.5 ? 1 : -1) : 0));
      for (const t of ts) if (windows.some((w) => inWin(t, w))) rs.push(t.netR);
    }
    means.push(rs.reduce((a, b) => a + b, 0) / rs.length);
  }
  return means.sort((a, b) => a - b);
}

function countFlatDays(trades: Tagged[], windows: Array<{ from: string; to: string }>): number {
  let flat = 0;
  for (const inst of INSTRUMENTS) {
    const mine = trades.filter((t) => t.inst === inst);
    for (const b of loadBars(inst)) {
      if (!windows.some((w) => b.t >= w.from && b.t < w.to)) continue;
      if (!mine.some((t) => b.t >= t.entryT && b.t <= t.exitT)) flat++;
    }
  }
  return flat;
}

if (import.meta.main) {
  const wantOos = Deno.args.includes("--oos");
  console.log("TREND_PREREG_V1 — primary: 50/20 breakout, 2×ATR(20) stop. Data:");
  for (const inst of INSTRUMENTS) console.log("  " + integrity(inst, loadBars(inst)));

  const trades = runAll(PRIMARY);
  const isT = trades.filter((t) => inWin(t, IS));
  const is = report("IN-SAMPLE 2015-01-01 → 2022-12-31", isT, 8);
  writeCsv("trend_v1_trades_is.csv", isT);

  const positive = INSTRUMENTS.filter((i) => is.per[i].exp > 0).length;
  const g1 = [
    ["portfolio net expectancy > 0", is.all.exp > 0],
    ["portfolio PF ≥ 1.10", is.all.pf >= 1.10],
    [`≥ 5 of 9 instruments positive (${positive})`, positive >= 5],
  ] as const;
  console.log("\n=== GATE G1 (pre-registered) ===");
  for (const [k, ok] of g1) console.log(`  ${ok ? "PASS" : "FAIL"}  ${k}`);
  const g1Pass = g1.every(([, ok]) => ok);
  console.log(`  G1: ${g1Pass ? "PASSED" : "FAILED — idea rejected; OOS stays locked"}`);

  const windows = [IS];
  if (wantOos) {
    if (!g1Pass) { console.log("\n--oos refused: G1 did not pass. The OOS period stays unseen."); Deno.exit(1); }
    windows.push(OOS);
    const oosT = trades.filter((t) => inWin(t, OOS));
    const oos = report("OUT-OF-SAMPLE 2023-01-01 → 2026-10-31 (single evaluation)", oosT, 3.83);
    writeCsv("trend_v1_trades_oos.csv", oosT);
    const g2 = [["portfolio net expectancy > 0", oos.all.exp > 0], ["portfolio PF ≥ 1.0", oos.all.pf >= 1.0]] as const;
    console.log("\n=== GATE G2 (pre-registered) ===");
    for (const [k, ok] of g2) console.log(`  ${ok ? "PASS" : "FAIL"}  ${k}`);
    console.log(`  G2: ${g2.every(([, ok]) => ok) ? "PASSED → forward shadow arm next" : "FAILED — idea rejected"}`);
    const both = summarize([...isT, ...oosT].map((t) => t.netR));
    console.log(line("\nIS+OOS combined", both) + (both.ciLo > 0 ? "   → STRONG EVIDENCE (CI lower bound > 0)" : ""));
  }

  console.log("\n=== DESCRIPTIVE ONLY — not gates, not for choosing parameters ===");
  const scoped = (ts: Tagged[]) => ts.filter((t) => windows.some((w) => inWin(t, w)));
  console.log(line("2× costs", summarize(scoped(runAll(PRIMARY, 2)).map((t) => t.netR))));
  const neighbours: Array<[string, Params]> = [
    ["20/10 channels", { ...PRIMARY, entryN: 20, exitN: 10 }],
    ["100/50 channels", { ...PRIMARY, entryN: 100, exitN: 50 }],
    ["3×ATR stop", { ...PRIMARY, stopAtr: 3 }],
  ];
  for (const [label, p] of neighbours) console.log(line(label, summarize(scoped(runAll(p)).map((t) => t.netR))));
  const real = scoped(trades);
  const pl = placebo(windows, real.length, countFlatDays(trades, windows));
  const realExp = real.reduce((s, t) => s + t.netR, 0) / real.length;
  const beaten = pl.filter((m) => m >= realExp).length;
  console.log(`random-entry placebo (200 sims): median ${f(pl[100])}R, 5–95% [${f(pl[10])}, ${f(pl[189])}]; real ${f(realExp)}R beats ${200 - beaten}/200`);
}
