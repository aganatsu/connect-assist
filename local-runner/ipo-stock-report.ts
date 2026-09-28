/**
 * IPO_STOCK_BASELINE_V1 — stage 3: statistics, audits and exports. READ-ONLY.
 *
 * Nothing here filters trades after the fact. The only exclusions are the ones
 * declared in the funnel: a trade the tape could not order, a trade with no 1m
 * coverage, or a trade whose parent bar reached the entry when the tape did
 * not. Every other candidate the engine produced is in the population.
 *
 *   deno run --allow-read --allow-write local-runner/ipo-stock-report.ts
 */

import type { Row } from "./ipo-stock-baseline.ts";

const CACHE = new URL("./.cache/", import.meta.url);
const OUT = new URL("../docs/exports/", import.meta.url);
try { Deno.mkdirSync(OUT, { recursive: true }); } catch { /* exists */ }

function load(): Row[] {
  const rows: Row[] = [];
  for (const e of Deno.readDirSync(CACHE)) {
    if (!/^stock_causal_.*\.json$/.test(e.name)) continue;
    rows.push(...JSON.parse(Deno.readTextFileSync(new URL(e.name, CACHE))) as Row[]);
  }
  return rows;
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
};

export interface Stats {
  n: number; wr: number; avgWin: number; avgLoss: number; expectancy: number;
  pf: number; netR: number; maxDD: number; medianR: number;
  p10: number; p90: number; lossP95: number; lossP99: number; worst: number;
  tradesPerMonth: number; rPerMonth: number; medianHoldMin: number;
}

/**
 * Drawdown is measured on the trade sequence in TIME order across the whole
 * population, not per symbol: a portfolio that runs eleven instruments at once
 * experiences their losses together, and per-symbol drawdown would understate
 * that by construction.
 */
function stats(rows: Row[]): Stats {
  const ok = rows.filter((r) => (r as any).causal_net_r !== null);
  const rs = ok.map((r) => (r as any).causal_net_r as number);
  const wins = rs.filter((r) => r > 0), losses = rs.filter((r) => r <= 0);
  const sum = rs.reduce((a, b) => a + b, 0);
  const gp = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);

  const byTime = [...ok].sort((a, b) =>
    Date.parse(a.actual_entry_time ?? a.strategy_bar_time)
    - Date.parse(b.actual_entry_time ?? b.strategy_bar_time));
  let eq = 0, peak = 0, maxDD = 0;
  for (const r of byTime) { eq += (r as any).causal_net_r as number; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }

  const times = byTime.map((r) => Date.parse(r.actual_entry_time ?? r.strategy_bar_time));
  const months = times.length > 1
    ? (times[times.length - 1] - times[0]) / (365.25 / 12 * 86_400_000) : 1;
  // Same-bar exits give a NEGATIVE hold: exit_bar_time is the bar, the entry
  // is a minute inside it, so the exit instant is unknown beyond "later in
  // this bar". Those are excluded from the minutes figure rather than clamped
  // to zero, which would drag the median down with a fabricated value. Median
  // bars-held covers the whole population and is reported beside it.
  const holds = ok.map((r) => (r as any).causal_hold_minutes as number|null)
    .filter((h): h is number => h !== null && h > 0);

  return {
    n: rs.length,
    wr: rs.length ? wins.length / rs.length : NaN,
    avgWin: wins.length ? gp / wins.length : NaN,
    avgLoss: losses.length ? -gl / losses.length : NaN,
    expectancy: rs.length ? sum / rs.length : NaN,
    pf: gl > 0 ? gp / gl : NaN,
    netR: sum, maxDD,
    medianR: q(rs, 0.5), p10: q(rs, 0.10), p90: q(rs, 0.90),
    lossP95: q(rs, 0.05), lossP99: q(rs, 0.01), worst: rs.length ? Math.min(...rs) : NaN,
    tradesPerMonth: months > 0 ? rs.length / months : NaN,
    rPerMonth: months > 0 ? sum / months : NaN,
    medianHoldMin: q(holds, 0.5),
  };
}

const f = (x: number, d = 3) => Number.isFinite(x) ? x.toFixed(d) : "—";

function table(title: string, groups: Array<[string, Row[]]>) {
  console.log(`\n### ${title}`);
  console.log("cohort              |    n |    WR | avgW  | avgL  |  exp   |   PF  |   netR |  maxDD | medR  |  p10  |  p90  | lossP95| worst | t/mo  | R/mo   | holdMin");
  console.log("-".repeat(165));
  for (const [name, rows] of groups) {
    const s = stats(rows);
    console.log(
      `${name.padEnd(19)} | ${String(s.n).padStart(4)} | ` +
      `${Number.isFinite(s.wr) ? (s.wr * 100).toFixed(1).padStart(5) : "  —  "} | ` +
      `${f(s.avgWin, 2).padStart(5)} | ${f(s.avgLoss, 2).padStart(5)} | ` +
      `${f(s.expectancy).padStart(6)} | ${f(s.pf, 2).padStart(5)} | ` +
      `${f(s.netR, 1).padStart(6)} | ${f(s.maxDD, 1).padStart(6)} | ` +
      `${f(s.medianR, 2).padStart(5)} | ${f(s.p10, 2).padStart(5)} | ${f(s.p90, 2).padStart(5)} | ` +
      `${f(s.lossP95, 2).padStart(6)} | ${f(s.worst, 2).padStart(5)} | ` +
      `${f(s.tradesPerMonth, 1).padStart(5)} | ${f(s.rPerMonth, 2).padStart(6)} | ` +
      `${f(s.medianHoldMin, 0).padStart(7)}`);
  }
}

const csv = (name: string, rows: Row[]) => {
  if (!rows.length) { Deno.writeTextFileSync(new URL(name, OUT), ""); return; }
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  Deno.writeTextFileSync(new URL(name, OUT),
    [cols.join(","), ...rows.map((r) => cols.map((c) => esc((r as never)[c])).join(","))].join("\n") + "\n");
};

if (import.meta.main) {
  const all = load();
  const clean = all.filter((r) => !r.ambiguous && !(r as any).causal_ambiguous && (r as any).causal_net_r !== null);
  const amb = all.filter((r) => r.ambiguous || (r as any).causal_ambiguous);

  console.log(`## FUNNEL — ARM A (large / liquid US equities)\n`);
  for (const tf of ["1h", "4h"]) {
    const t = all.filter((r) => r.timeframe === tf);
    const c = clean.filter((r) => r.timeframe === tf);
    console.log(`${tf}:`);
    console.log(`  symbols screened                 ${new Set(t.map((r) => r.symbol)).size}`);
    console.log(`  candidate entries (engine)       ${t.length}`);
    console.log(`  excluded — no 1m tape            ${t.filter((r) => r.entry_resolution === "NO_1M_TAPE").length}`);
    console.log(`  excluded — tape never reached E2 ${t.filter((r) => r.entry_resolution === "NO_MINUTE_REACHED_ENTRY").length}`);
    console.log(`  ambiguous — same-bar ordering    ${t.filter((r) => r.ambiguous && !/NO_1M|FEED/.test(r.ambiguity_reason)).length}`);
    console.log(`  CLEAN CAUSAL ENTRIES             ${c.length}`);
    console.log(`  entries outside 09:30-16:00 ET   ${t.filter((r) => /OUTSIDE_RTH/.test(r.ambiguity_reason)).length}`);
  }

  console.log(`\n## PRIMARY PERFORMANCE (net of 2.5 bps/side, clean causal entries only)`);
  table("by timeframe", [
    ["large-cap 1H", clean.filter((r) => r.timeframe === "1h")],
    ["large-cap 4H", clean.filter((r) => r.timeframe === "4h")],
    ["large-cap all", clean],
  ]);

  table("LONG vs SHORT", [
    ["1H long", clean.filter((r) => r.timeframe === "1h" && r.direction === "long")],
    ["1H short", clean.filter((r) => r.timeframe === "1h" && r.direction === "short")],
    ["4H long", clean.filter((r) => r.timeframe === "4h" && r.direction === "long")],
    ["4H short", clean.filter((r) => r.timeframe === "4h" && r.direction === "short")],
    ["all long", clean.filter((r) => r.direction === "long")],
    ["all short", clean.filter((r) => r.direction === "short")],
  ]);

  const syms = [...new Set(clean.map((r) => r.symbol))].sort();
  table("per symbol (both timeframes)", syms.map((s) =>
    [s, clean.filter((r) => r.symbol === s)] as [string, Row[]]));
  table("per symbol — 1H", syms.map((s) =>
    [s, clean.filter((r) => r.symbol === s && r.timeframe === "1h")] as [string, Row[]]));
  table("per symbol — 4H", syms.map((s) =>
    [s, clean.filter((r) => r.symbol === s && r.timeframe === "4h")] as [string, Row[]]));

  // Cost sensitivity: the cost model is an assumption, so show what it buys.
  console.log(`\n### cost sensitivity (net R per trade, recomputed from gross)`);
  for (const bps of [0, 2.5, 5, 10]) {
    const e = clean.map((r) => ((r as any).causal_gross_r ?? 0) - (2 * (bps / 10_000) * r.entry_price) / r.risk);
    const s = e.reduce((a, b) => a + b, 0);
    console.log(`  ${String(bps).padStart(4)} bps/side -> expectancy ${(s / e.length).toFixed(4)} R  net ${s.toFixed(1)} R`);
  }

  console.log(`\n### by year (consistency / regime breadth)`);
  const years = [...new Set(clean.map((r) =>
    (r.actual_entry_time ?? r.strategy_bar_time).slice(0, 4)))].sort();
  table("year", years.map((y) =>
    [y, clean.filter((r) => (r.actual_entry_time ?? r.strategy_bar_time).startsWith(y))] as [string, Row[]]));

  csv("ipo_stock_largecap_1h_clean.csv", clean.filter((r) => r.timeframe === "1h"));
  csv("ipo_stock_largecap_4h_clean.csv", clean.filter((r) => r.timeframe === "4h"));
  csv("ipo_stock_ambiguous.csv", amb);
  console.log(`\nexports written: ${clean.filter((r) => r.timeframe === "1h").length} 1h, ` +
    `${clean.filter((r) => r.timeframe === "4h").length} 4h, ${amb.length} ambiguous`);
}
