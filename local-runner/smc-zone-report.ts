/**
 * SMC_IMPULSE_ZONE_CORPUS_BACKTEST_V1 — metrics, breakdowns, exports.
 *
 * Clean profitability uses RESOLVED trades only: outcome TRADE_TAKEN and not
 * ambiguous. Ambiguous and unresolved rows are counted in the funnel and
 * exported, never silently dropped and never decided by code precedence.
 *
 *   deno run --allow-read --allow-write local-runner/smc-zone-report.ts
 */

import type { Setup } from "./smc-zone-replay.ts";

const CACHE = new URL("./.cache/", import.meta.url);
const OUT = new URL("../docs/exports/", import.meta.url);
try { Deno.mkdirSync(OUT, { recursive: true }); } catch { /* exists */ }

function load(): Setup[] {
  const all: Setup[] = [];
  for (const e of Deno.readDirSync(CACHE)) {
    if (!/^smc_setups_.*\.json$/.test(e.name)) continue;
    all.push(...JSON.parse(Deno.readTextFileSync(new URL(e.name, CACHE))) as Setup[]);
  }
  return all.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
};
const f = (x: number, d = 3) => Number.isFinite(x) ? x.toFixed(d) : "—";

function stats(rows: Setup[]) {
  const rs = rows.map((r) => r.netR as number).filter((x) => Number.isFinite(x));
  const w = rs.filter((x) => x > 0), l = rs.filter((x) => x <= 0);
  const gp = w.reduce((a, b) => a + b, 0), gl = -l.reduce((a, b) => a + b, 0);
  const sum = rs.reduce((a, b) => a + b, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const r of rows) { eq += r.netR ?? 0; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const times = rows.map((r) => Date.parse(r.fillTime ?? r.t));
  const months = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / (365.25 / 12 * 86_400_000) : 1;
  const holds = rows.map((r) => r.holdMinutes).filter((h): h is number => h !== null);
  return {
    n: rs.length, wr: rs.length ? w.length / rs.length : NaN,
    avgW: w.length ? gp / w.length : NaN, avgL: l.length ? -gl / l.length : NaN,
    exp: rs.length ? sum / rs.length : NaN, pf: gl > 0 ? gp / gl : NaN,
    net: sum, dd, med: q(rs, .5), p10: q(rs, .1), p90: q(rs, .9),
    p95L: q(rs, .05), p99L: q(rs, .01), worst: rs.length ? Math.min(...rs) : NaN,
    tpm: months > 0 ? rs.length / months : NaN, rpm: months > 0 ? sum / months : NaN,
    avgHold: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : NaN,
    medHold: q(holds, .5),
  };
}

function table(title: string, groups: Array<[string, Setup[]]>) {
  console.log(`\n### ${title}`);
  console.log("cohort          |    n |   WR  | avgW | avgL |  exp   |  PF  |   netR |  maxDD | medR | p10  | p90  | p95L | worst | t/mo | R/mo  | medHold");
  console.log("-".repeat(150));
  for (const [name, rows] of groups) {
    const s = stats(rows);
    console.log(`${name.padEnd(15)} | ${String(s.n).padStart(4)} | ` +
      `${Number.isFinite(s.wr) ? (s.wr * 100).toFixed(1).padStart(5) : "  —  "} | ` +
      `${f(s.avgW, 2).padStart(4)} | ${f(s.avgL, 2).padStart(4)} | ${f(s.exp).padStart(6)} | ` +
      `${f(s.pf, 2).padStart(4)} | ${f(s.net, 1).padStart(6)} | ${f(s.dd, 1).padStart(6)} | ` +
      `${f(s.med, 2).padStart(4)} | ${f(s.p10, 2).padStart(4)} | ${f(s.p90, 2).padStart(4)} | ` +
      `${f(s.p95L, 2).padStart(4)} | ${f(s.worst, 2).padStart(5)} | ${f(s.tpm, 1).padStart(4)} | ` +
      `${f(s.rpm, 1).padStart(5)} | ${f(s.medHold, 0).padStart(7)}`);
  }
}

const csv = (name: string, rows: Record<string, unknown>[]) => {
  if (!rows.length) { Deno.writeTextFileSync(new URL(name, OUT), "empty\n"); return; }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  Deno.writeTextFileSync(new URL(name, OUT),
    [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n");
};

if (import.meta.main) {
  const all = load();
  const W = (r: Setup) => r.window === "primary";
  const taken = all.filter((r) => r.outcome === "TRADE_TAKEN");
  const clean = taken.filter((r) => !r.ambiguous && r.netR !== null);
  const amb = all.filter((r) => r.ambiguous);

  console.log("## SETUP FUNNEL (180d corpus; primary = last 90d)\n");
  const counts: Record<string, number> = {};
  for (const r of all) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  console.log(`  zone-bearing evaluations : ${all.length}`);
  for (const k of Object.keys(counts).sort((a, b) => counts[b] - counts[a])) {
    console.log(`  ${k.padEnd(28)}: ${counts[k]}`);
  }
  const st: Record<string, number> = {};
  for (const r of all) st[r.state] = (st[r.state] ?? 0) + 1;
  console.log(`  zone states              : ${JSON.stringify(st)}`);
  console.log(`  routes                   : MARKET ${taken.filter(r => r.route === "MARKET").length}, LIMIT ${taken.filter(r => r.route === "LIMIT").length}`);

  console.log("\n## PRIMARY PROFITABILITY (clean resolved trades, net of frozen costs)");
  table("window", [
    ["180d all", clean],
    ["90d primary", clean.filter(W)],
  ]);
  table("by symbol (180d)", [...new Set(clean.map((r) => r.symbol))].sort()
    .map((s) => [s, clean.filter((r) => r.symbol === s)] as [string, Setup[]]));
  table("by direction", [
    ["long", clean.filter((r) => r.direction === "long")],
    ["short", clean.filter((r) => r.direction === "short")],
  ]);
  table("by zone timeframe", [...new Set(clean.map((r) => r.selectedTF ?? "-"))].sort()
    .map((t) => [t, clean.filter((r) => (r.selectedTF ?? "-") === t)] as [string, Setup[]]));
  table("by session", ["ASIA", "LONDON", "OVERLAP", "NEWYORK", "OFF"]
    .map((s) => [s, clean.filter((r) => r.session === s)] as [string, Setup[]]));
  table("by route", [
    ["MARKET", clean.filter((r) => r.route === "MARKET")],
    ["LIMIT", clean.filter((r) => r.route === "LIMIT")],
  ]);

  console.log("\n### gross vs net");
  const g = clean.map((r) => r.grossR as number), nn = clean.map((r) => r.netR as number);
  console.log(`  gross  expectancy ${(g.reduce((a, b) => a + b, 0) / g.length).toFixed(4)} R   net ${g.reduce((a, b) => a + b, 0).toFixed(1)} R`);
  console.log(`  net    expectancy ${(nn.reduce((a, b) => a + b, 0) / nn.length).toFixed(4)} R   net ${nn.reduce((a, b) => a + b, 0).toFixed(1)} R`);
  console.log(`  median costR ${q(clean.map((r) => r.costR as number), .5).toFixed(4)}`);

  // ── exports ────────────────────────────────────────────────────────────────
  csv("impulse_zone_all_setups.csv", all as unknown as Record<string, unknown>[]);
  csv("impulse_zone_trades_clean.csv", clean as unknown as Record<string, unknown>[]);
  csv("impulse_zone_ambiguous.csv", amb as unknown as Record<string, unknown>[]);
  csv("impulse_zone_invalidated.csv",
    all.filter((r) => r.outcome === "INVALIDATED_BEFORE_ENTRY") as unknown as Record<string, unknown>[]);
  const sm = (label: string, rows: Setup[]) => ({ cohort: label, ...stats(rows) });
  csv("impulse_zone_summary.csv", [sm("180d_all", clean), sm("90d_primary", clean.filter(W))]);
  csv("impulse_zone_by_symbol.csv", [...new Set(clean.map((r) => r.symbol))].sort()
    .map((s) => sm(s, clean.filter((r) => r.symbol === s))));
  csv("impulse_zone_by_timeframe.csv", [...new Set(clean.map((r) => r.selectedTF ?? "-"))].sort()
    .map((t) => sm(t, clean.filter((r) => (r.selectedTF ?? "-") === t))));

  const pick = (rows: Setup[], n: number) => {
    const step = Math.max(1, Math.floor(rows.length / n));
    return rows.filter((_, i) => i % step === 0).slice(0, n);
  };
  const audit = [
    ...pick(clean.filter((r) => r.symbol === "EUR/USD"), 10),
    ...pick(clean.filter((r) => r.symbol === "USD/JPY"), 10),
    ...pick(clean.filter((r) => r.symbol === "GBP/USD"), 10),
    ...pick(clean.filter((r) => (r.netR ?? 0) > 0), 10),
    ...pick(clean.filter((r) => (r.netR ?? 0) <= 0), 10),
    ...pick(all.filter((r) => r.outcome === "INVALIDATED_BEFORE_ENTRY"), 10),
    ...pick(amb, 10),
  ];
  csv("impulse_zone_manual_audit.csv", audit as unknown as Record<string, unknown>[]);

  Deno.writeTextFileSync(new URL("impulse_zone_manifest.json", OUT), JSON.stringify({
    contract: "SMC_IMPULSE_ZONE_CORPUS_BACKTEST_V1",
    kind: "CAUSAL MARKET-LOGIC BACKTEST — not a live portfolio simulation",
    productionChain: ["smcDirectionDecision.decideDirection", "smcHtfContext.buildHtfContext",
                      "smcZoneDecision.decideZone", "unifiedZoneEngine.findUnifiedZone"],
    notUsed: ["backtest-engine", "findBestEntryZoneMultiTF (called directly)"],
    style: "scalper", provider: "twelvedata", timezone: "UTC",
    windows: { primary: "2026-06-27..2026-09-25", secondary: "2026-03-29..2026-09-25" },
    depths: { m5: 1440, m15: 480, h1: 120, h4: 300, d1: 260, w1: 52 },
    costModel: "frozen per-symbol spread + slippage, one-way, in pips",
    tpRatio: 1.5, sequencing: "ARM A — one open position per symbol",
    statefulGatesReconstructed: false,
  }, null, 2));

  console.log(`\nexports: all=${all.length} clean=${clean.length} amb=${amb.length} audit=${audit.length}`);
}
