/**
 * IPO-CET-v1 POST-MORTEM — descriptive analysis of the causal corpus.
 *
 * RESEARCH ONLY. Reads local research JSON, writes local JSON/CSV. No database,
 * no strategy code, no network, no deployment.
 *
 * DESCRIPTIVE, NOT PRESCRIPTIVE. Nothing here sets a threshold, selects a
 * subgroup or proposes a rule. It reports distributions so hypotheses can be
 * written from evidence and then tested on data this analysis never saw.
 *
 * BTC 2023-06..08 IS EXCLUDED throughout: its 1-minute feed carries corruption
 * the freeze document does not describe (31 whole-bar shifts), so no causal
 * claim is made over it.
 */

interface Row {
  window: string; instrument: string; entryBarTime: string; direction: string;
  entry: number; stop: number; target: number; risk: number; costR: number; vol: string;
  legacyNetR: number; sameBar: boolean; klass: string;
  entryMinute: string | null; entryBarOutcome: string | null; forwardOutcome: string | null;
  exitBarTime: string | null; causalNetR: number | null; mfeR: number | null; maeR: number | null;
  ipoCandleTime?: string;
}

const A: Row[] = JSON.parse(await Deno.readTextFile("/tmp/stage3-causal-A.json"));
// Join ipoCandleTime from the replay checkpoint so zone age is measurable.
const ck = JSON.parse(await Deno.readTextFile("/tmp/baseline-determinism-checkpoint.json"));
const ipoAt = new Map<string, string>();
for (const c of Object.values(ck) as Array<{ window: string; trades_detail: Array<Record<string, string>> }>) {
  for (const t of c.trades_detail) ipoAt.set(`${c.window}|${t.entryBarTime}|${t.entry}`, t.ipoCandleTime);
}
for (const r of A) r.ipoCandleTime = ipoAt.get(`${r.window}|${r.entryBarTime}|${r.entry}`) ?? "";

const CORRUPT = (r: Row) => r.instrument === "BTC/USD" && r.window === "p3-BTCUSD";
const clean = A.filter((r) => !CORRUPT(r));
const resolved = clean.filter((r) => r.causalNetR !== null) as Array<Row & { causalNetR: number }>;

const q = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const f = (n: number, d = 3) => n.toFixed(d).padStart(8);

function perf(rs: Array<{ causalNetR: number }>) {
  const n = rs.length; if (!n) return null;
  const w = rs.filter((r) => r.causalNetR > 0).map((r) => r.causalNetR);
  const l = rs.filter((r) => r.causalNetR < 0).map((r) => r.causalNetR);
  const gp = w.reduce((a, x) => a + x, 0), gl = Math.abs(l.reduce((a, x) => a + x, 0));
  const tot = rs.reduce((a, r) => a + r.causalNetR, 0);
  return { n, win: w.length / n * 100, expR: tot / n, pf: gl ? gp / gl : Infinity, totalR: tot,
           avgW: w.length ? gp / w.length : 0, avgL: l.length ? -gl / l.length : 0 };
}
const line = (lbl: string, rs: Array<{ causalNetR: number }>) => {
  const p = perf(rs);
  if (!p || p.n < 1) { console.log(`  ${lbl.padEnd(30)} —`); return; }
  console.log(`  ${lbl.padEnd(30)} n=${String(p.n).padStart(4)} win=${p.win.toFixed(1).padStart(5)}% ` +
    `expR=${f(p.expR)} PF=${p.pf.toFixed(2).padStart(5)} avgW=${f(p.avgW, 2)} avgL=${f(p.avgL, 2)}`);
};

const H = (s: string) => console.log(`\n${"=".repeat(94)}\n${s}\n${"=".repeat(94)}`);

// ── F. loss distribution ─────────────────────────────────────────────────────

H("PART F — causal loss distribution");
console.log(`${"".padEnd(12)}${"n".padStart(5)}${"med".padStart(8)}${"mean".padStart(8)}${"p75".padStart(8)}${"p90".padStart(8)}${"p95".padStart(8)}${"p99".padStart(8)}${"max".padStart(9)}  >1R   >1.5R  >2R   >3R   >5R`);
for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD", "PORTFOLIO"]) {
  const set = inst === "PORTFOLIO" ? resolved : resolved.filter((r) => r.instrument === inst);
  const L = set.filter((r) => r.causalNetR < 0).map((r) => Math.abs(r.causalNetR));
  if (!L.length) continue;
  const pct = (t: number) => `${(L.filter((x) => x > t).length / L.length * 100).toFixed(0)}%`.padStart(5);
  console.log(`${inst.padEnd(12)}${String(L.length).padStart(5)}${f(q(L, .5), 2)}${f(mean(L), 2)}${f(q(L, .75), 2)}` +
    `${f(q(L, .9), 2)}${f(q(L, .95), 2)}${f(q(L, .99), 2)}${f(Math.max(...L), 2)}  ${pct(1)} ${pct(1.5)} ${pct(2)} ${pct(3)} ${pct(5)}`);
}
console.log("\nbreak-even win rate required, from observed avgWin/avgLoss:");
for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD", "PORTFOLIO"]) {
  const set = inst === "PORTFOLIO" ? resolved : resolved.filter((r) => r.instrument === inst);
  const p = perf(set); if (!p) continue;
  const be = Math.abs(p.avgL) / (p.avgW + Math.abs(p.avgL)) * 100;
  console.log(`  ${inst.padEnd(12)} avgW ${p.avgW.toFixed(2)}R  avgL ${p.avgL.toFixed(2)}R  ` +
    `break-even win ${be.toFixed(1)}%  actual ${p.win.toFixed(1)}%  gap ${(p.win - be).toFixed(1)}pp`);
}

// ── I. same-bar vs multi-bar ─────────────────────────────────────────────────

H("PART I — structure: same-bar vs multi-bar vs tick-required");
for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD", "PORTFOLIO"]) {
  const set = inst === "PORTFOLIO" ? clean : clean.filter((r) => r.instrument === inst);
  console.log(`\n${inst}`);
  line("same-bar (1m resolved)", set.filter((r) => r.sameBar && r.causalNetR !== null) as never);
  line("multi-bar", set.filter((r) => !r.sameBar && r.causalNetR !== null) as never);
  const tick = set.filter((r) => r.klass === "TICK_REQUIRED").length;
  console.log(`  ${"tick-required (no outcome)".padEnd(30)} n=${String(tick).padStart(4)}`);
}

// ── C/D/E. per-instrument breakdowns ─────────────────────────────────────────

const hour = (r: Row) => Number(r.entryBarTime.slice(11, 13));
const dow = (r: Row) => new Date(r.entryBarTime).getUTCDay();
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const session = (h: number) => h < 7 ? "asia" : h < 12 ? "london" : h < 17 ? "overlap" : "ny-late";
const entryMinuteOffset = (r: Row) =>
  r.entryMinute ? Math.round((Date.parse(r.entryMinute) - Date.parse(r.entryBarTime)) / 60000) : null;
const barsHeld = (r: Row) => {
  if (!r.exitBarTime) return null;
  const ms = Date.parse(r.exitBarTime) - Date.parse(r.entryBarTime);
  return Math.round(ms / (r.instrument === "USD/JPY" ? 1800000 : 3600000));
};
const zoneAgeBars = (r: Row) => {
  if (!r.ipoCandleTime) return null;
  const ms = Date.parse(r.entryBarTime) - Date.parse(r.ipoCandleTime);
  return Math.round(ms / (r.instrument === "USD/JPY" ? 1800000 : 3600000));
};
/** Risk as a fraction of price — a scale-free proxy for zone width. */
const riskPct = (r: Row) => r.risk / r.entry * 100;

function breakdown(inst: string) {
  const set = resolved.filter((r) => r.instrument === inst);
  H(`${inst} — descriptive breakdown (causal, n=${set.length})`);
  const p = perf(set)!;
  console.log(`  OVERALL n=${p.n} win=${p.win.toFixed(1)}% expR=${p.expR.toFixed(3)} PF=${p.pf.toFixed(2)} totalR=${p.totalR.toFixed(1)}`);

  console.log("\n  by direction:");
  for (const d of ["demand", "supply"]) line(d, set.filter((r) => r.direction === d));

  console.log("\n  by volatility bucket:");
  for (const v of [...new Set(set.map((r) => r.vol))].sort()) line(v, set.filter((r) => r.vol === v));

  console.log("\n  by session (UTC hour of entry bar):");
  for (const s of ["asia", "london", "overlap", "ny-late"]) line(s, set.filter((r) => session(hour(r)) === s));

  console.log("\n  by day of week:");
  for (let d = 0; d < 7; d++) {
    const g = set.filter((r) => dow(r) === d);
    if (g.length) line(DOW[d], g);
  }

  console.log("\n  by entry-minute offset within the HTF bar:");
  for (const [lbl, lo, hi] of [["0-9 min", 0, 10], ["10-29", 10, 30], ["30-44", 30, 45], ["45+", 45, 999]] as Array<[string, number, number]>) {
    const g = set.filter((r) => { const o = entryMinuteOffset(r); return o !== null && o >= lo && o < hi; });
    if (g.length) line(lbl, g);
  }
  const noMin = set.filter((r) => entryMinuteOffset(r) === null);
  if (noMin.length) line("(multi-bar, no minute)", noMin);

  console.log("\n  by risk as % of price (zone-width proxy), quartiles:");
  const rp = set.map(riskPct).sort((a, b) => a - b);
  const cuts = [q(rp, .25), q(rp, .5), q(rp, .75)];
  const bands: Array<[string, (r: Row) => boolean]> = [
    [`Q1 <${cuts[0].toFixed(3)}%`, (r) => riskPct(r) < cuts[0]],
    [`Q2`, (r) => riskPct(r) >= cuts[0] && riskPct(r) < cuts[1]],
    [`Q3`, (r) => riskPct(r) >= cuts[1] && riskPct(r) < cuts[2]],
    [`Q4 >${cuts[2].toFixed(3)}%`, (r) => riskPct(r) >= cuts[2]],
  ];
  for (const [lbl, fn] of bands) line(lbl, set.filter(fn));

  console.log("\n  by costR quartile:");
  const cr = set.map((r) => r.costR).sort((a, b) => a - b);
  const cc = [q(cr, .25), q(cr, .5), q(cr, .75)];
  line(`Q1 <${cc[0].toFixed(3)}`, set.filter((r) => r.costR < cc[0]));
  line("Q2", set.filter((r) => r.costR >= cc[0] && r.costR < cc[1]));
  line("Q3", set.filter((r) => r.costR >= cc[1] && r.costR < cc[2]));
  line(`Q4 >${cc[2].toFixed(3)}`, set.filter((r) => r.costR >= cc[2]));

  console.log("\n  by zone age at entry (bars from IPO candle):");
  for (const [lbl, lo, hi] of [["1-5", 1, 6], ["6-20", 6, 21], ["21-60", 21, 61], ["61+", 61, 1e9]] as Array<[string, number, number]>) {
    const g = set.filter((r) => { const a = zoneAgeBars(r); return a !== null && a >= lo && a < hi; });
    if (g.length) line(lbl, g);
  }

  console.log("\n  by bars held:");
  for (const [lbl, lo, hi] of [["0 (same bar)", 0, 1], ["1-3", 1, 4], ["4-12", 4, 13], ["13+", 13, 1e9]] as Array<[string, number, number]>) {
    const g = set.filter((r) => { const b = barsHeld(r); return b !== null && b >= lo && b < hi; });
    if (g.length) line(lbl, g);
  }

  console.log("\n  by entry-bar outcome (same-bar trades only):");
  for (const o of ["TARGET_AFTER_ENTRY", "S2_CLOSE_AFTER_ENTRY", "STILL_OPEN_AT_BAR_END"]) {
    const g = set.filter((r) => r.entryBarOutcome === o);
    if (g.length) line(o, g);
  }
}
for (const i of ["EUR/USD", "USD/JPY", "BTC/USD"]) breakdown(i);

// ── G. target efficiency (same-bar subset only — MFE exists there) ───────────

H("PART G — target efficiency (post-entry MFE, same-bar resolved only)");
console.log("NOTE: MFE was only computed for trades whose entry bar was resolved at 1m.");
console.log("Multi-bar trades have no post-entry MFE in this dataset — a gap, not a zero.\n");
const withMfe = resolved.filter((r) => r.mfeR !== null) as Array<Row & { causalNetR: number; mfeR: number }>;
for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD", "PORTFOLIO"]) {
  const set = inst === "PORTFOLIO" ? withMfe : withMfe.filter((r) => r.instrument === inst);
  if (!set.length) continue;
  const losers = set.filter((r) => r.causalNetR < 0);
  const winners = set.filter((r) => r.causalNetR > 0);
  const reach = (g: typeof set, t: number) => g.length ? `${(g.filter((r) => r.mfeR >= t).length / g.length * 100).toFixed(0)}%` : "—";
  console.log(`${inst}  losers n=${losers.length}: reached +0.5R ${reach(losers, .5)}, +1R ${reach(losers, 1)}, +1.5R ${reach(losers, 1.5)}, +2R ${reach(losers, 2)}`);
  console.log(`${"".padEnd(inst.length)}  winners n=${winners.length}: MFE beyond 2.5R ${reach(winners, 2.5)}, 3R ${reach(winners, 3)}, 4R ${reach(winners, 4)}, 5R ${reach(winners, 5)}`);
}

// ── machine-readable output ──────────────────────────────────────────────────

const enriched = clean.map((r) => ({
  ...r,
  hourUtc: hour(r), dayOfWeek: DOW[dow(r)], session: session(hour(r)),
  entryMinuteOffset: entryMinuteOffset(r), barsHeld: barsHeld(r),
  zoneAgeBars: zoneAgeBars(r), riskPctOfPrice: riskPct(r),
  excludedCorruptWindow: false,
}));
await Deno.writeTextFile("/tmp/v1-postmortem-trades.json", JSON.stringify(enriched, null, 1));
const cols = ["window", "instrument", "entryBarTime", "direction", "vol", "entry", "stop", "target",
  "risk", "riskPctOfPrice", "costR", "legacyNetR", "causalNetR", "sameBar", "klass",
  "entryBarOutcome", "forwardOutcome", "hourUtc", "dayOfWeek", "session",
  "entryMinuteOffset", "barsHeld", "zoneAgeBars", "mfeR", "maeR"];
const csv = [cols.join(",")].concat(enriched.map((r) =>
  cols.map((c) => { const v = (r as Record<string, unknown>)[c]; return v === null || v === undefined ? "" : String(v); }).join(",")));
await Deno.writeTextFile("/tmp/v1-postmortem-trades.csv", csv.join("\n"));
console.log(`\nwrote ${enriched.length} enriched trades to /tmp/v1-postmortem-trades.{json,csv}`);
console.log(`(BTC 2023-06..08 excluded: ${A.length - clean.length} rows)`);
