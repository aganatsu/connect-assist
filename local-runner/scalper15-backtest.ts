/**
 * SCALPER15_PREREG_V1 — the study runner (docs/SCALPER15_PREREG_V1.md). Reads the
 * scalper15-fetch.ts cache only. RESEARCH ONLY: nothing here touches production.
 *
 *   deno run --allow-read --allow-write local-runner/scalper15-backtest.ts             # IS + G1
 *   deno run --allow-read --allow-write local-runner/scalper15-backtest.ts --holdout   # + holdout, once, only if G1 passed
 *
 * The zone and the confirmation are the PRODUCTION modules, called unmodified:
 * findBestEntryZone (15m series in the impulse slot), detectZoneConfirmation, classifyZoneExit.
 * The holdout lock is in code: no holdout trade is summarised or written without --holdout,
 * and --holdout refuses unless G1 passes in the same run.
 */

import { classifyZoneExit, DEFAULT_ZONE_CONFIRMATION_CONFIG, detectZoneConfirmation } from "../supabase/functions/_shared/zoneConfirmation.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { biasNow, type Dir, planScalper15, plannedR, SCALPER15_DEFAULTS, S15_DEPTH } from "../supabase/functions/_shared/scalper15.ts";
import {
  COST_PIPS, entryFill, type ExitReason, H, lastClosedIndex, MIN, pipOf, resolveExit, STOP_SLIP_PIPS, ZONE_LIFETIME_MS,
} from "./scalper15Engine.ts";
import { loadTf, SYMBOLS } from "./scalper15Corpus.ts";
import { summarize, type Summary } from "./trendEngine.ts";

const IS = { from: Date.parse("2026-03-29"), to: Date.parse("2026-09-26") };
const HOLDOUT = { from: Date.parse("2026-09-26"), to: Date.parse("2026-11-05") };
const CONFIRM_BARS = 300;
const SETTINGS = { ...SCALPER15_DEFAULTS, enabled: true };

export interface Trade {
  sym: string; dir: Dir; armedT: string; touchT: string; entryT: string; exitT: string;
  zoneLow: number; zoneHigh: number; entry: number; stop: number; target: number;
  plannedR: number; riskPips: number; reason: ExitReason; netR: number; altNetR: number | null;
  holdMin: number; session: string; confType: string; confTier: number;
}

export type Funnel = Record<string, number>;

const iso = (ms: number) => new Date(ms).toISOString();
const firstAtOrAfter = (openMs: number[], t: number) => { let lo = 0, hi = openMs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (openMs[m] < t) lo = m + 1; else hi = m; } return lo; };
const session = (ms: number) => { const h = new Date(ms).getUTCHours(); return h < 7 ? "ASIA" : h < 12 ? "LONDON" : h < 16 ? "OVERLAP" : h < 21 ? "NEWYORK" : "OFF"; };

export function runSymbol(sym: string, costMult = 1, fromMs = IS.from, toMs = HOLDOUT.to): { trades: Trade[]; funnel: Funnel } {
  const [m1, m5, m15, h1] = ["1m", "5m", "15m", "1h"].map((tf) => loadTf(sym, tf));
  const o1 = m1.map((b) => Date.parse(b.datetime)), o5 = m5.map((b) => Date.parse(b.datetime));
  const o15 = m15.map((b) => Date.parse(b.datetime)), o1h = h1.map((b) => Date.parse(b.datetime));
  const pip = pipOf(sym), S = COST_PIPS[sym] * pip * costMult, slip = STOP_SLIP_PIPS * pip * costMult;
  const funnel: Funnel = { decisions15: 0, noBias: 0, noZone: 0, armed: 0, touched: 0, confirmed: 0, cancelledBreach: 0, cancelledFlip: 0, expired: 0, resetFavourable: 0, skipPlacementR: 0, skipAdmission: 0, entered: 0 };
  const trades: Trade[] = [];

  let armed: { low: number; high: number; dir: Dir; stop: number; target: number; armedAt: number; expires: number; touchMs: number | null } | null = null;
  let busyUntil = 0;

  for (let k = 0; k < m5.length; k++) {
    const t = o5[k] + 5 * MIN;               // decision time = this 5m bar's close
    if (t < fromMs || t >= toMs || t < busyUntil) continue;
    // The same closed-bar windows bot-scanner hands planScalper15 (S15_DEPTH), cut at t.
    const hi = lastClosedIndex(o1h, H, t);
    const h1Win = hi >= 0 ? h1.slice(Math.max(0, hi - S15_DEPTH.h1 + 1), hi + 1) : [];
    const bs = biasNow(h1Win);

    // 15m close: re-plan unless a touched zone is being hunted (live re-plans each scan and
    // supersedes an untouched order whose zone changed; the 15m series only changes here).
    if (t % (15 * MIN) === 0 && !armed?.touchMs) {
      funnel.decisions15++;
      armed = null;
      if (bs.bias === 0) { funnel.noBias++; continue; }
      const i15 = lastClosedIndex(o15, 15 * MIN, t);
      const plan = planScalper15({
        h1: h1Win,
        m15: m15.slice(Math.max(0, i15 - S15_DEPTH.m15 + 1), i15 + 1),
        m5: m5.slice(Math.max(0, k - S15_DEPTH.m5 + 1), k + 1),
        lastPrice: m5[k].close, pipSize: pip, settings: SETTINGS,
      });
      if (!plan.ok) { funnel[plan.reason.startsWith("1H target") ? "skipPlacementR" : "noZone"]++; continue; }
      armed = { low: plan.zone.low, high: plan.zone.high, dir: plan.dir, stop: plan.stop, target: plan.target, armedAt: t, expires: t + ZONE_LIFETIME_MS, touchMs: null };
      funnel.armed++;
    }
    if (!armed) continue;
    if (bs.bias !== armed.dir) { funnel.cancelledFlip++; armed = null; continue; }
    if (t >= armed.expires) { funnel.expired++; armed = null; continue; }

    const a = armed, bar = m5[k], dirStr = a.dir === 1 ? "long" : "short";
    if (a.touchMs === null) {
      // The touch must come from a bar that opened after arming: the bar that closed as the
      // zone was found is part of the scan that found it, and production could not see a
      // touch before the order existed.
      if (o5[k] < a.armedAt) continue;
      const touches = a.dir === 1 ? bar.low <= a.high : bar.high >= a.low;
      if (!touches) continue;
      a.touchMs = o5[k];
      funnel.touched++;
    }

    const w0 = Math.max(0, k - CONFIRM_BARS + 1);
    const win = m5.slice(w0, k + 1);
    const touchIdx = Math.max(0, firstAtOrAfter(o5, a.touchMs) - w0);
    const sig = detectZoneConfirmation(win, dirStr, DEFAULT_ZONE_CONFIRMATION_CONFIG, touchIdx, sym, { zoneHigh: a.high, zoneLow: a.low });
    if (!sig) {
      const kind = classifyZoneExit(bar.close, a.low, a.high, dirStr);
      if (kind === "inside") continue;
      if (kind === "left_breach") { funnel.cancelledBreach++; armed = null; }
      else { funnel.resetFavourable++; a.touchMs = null; }
      continue;
    }

    funnel.confirmed++;
    armed = null;
    const i1 = firstAtOrAfter(o1, t);
    if (i1 >= m1.length) break;
    const fill = entryFill(m1[i1].open, a.dir, S);
    // Stop and target are the order's, fixed at placement (Route 2 stores them on the order);
    // the fill re-checks R at the real price, as bot-scanner's hunt does.
    const stop = a.stop, target = a.target;
    const pr = plannedR(a.dir, fill, stop, target);
    if (!(pr >= SETTINGS.minPlannedR)) { funnel.skipAdmission++; continue; }

    const ex = resolveExit(m1, i1, a.dir, stop, target, S, slip);
    const risk = a.dir * (fill - stop);
    funnel.entered++;
    trades.push({
      sym, dir: a.dir, armedT: iso(a.armedAt), touchT: iso(a.touchMs!), entryT: iso(o1[i1]), exitT: iso(ex.exitMs),
      zoneLow: a.low, zoneHigh: a.high, entry: fill, stop, target, plannedR: pr, riskPips: risk / pip,
      reason: ex.reason, netR: a.dir * (ex.exit - fill) / risk,
      altNetR: ex.altExit === undefined ? null : a.dir * (ex.altExit - fill) / risk,
      holdMin: (ex.exitMs - o1[i1]) / MIN, session: session(o1[i1]), confType: String(sig.type), confTier: sig.tier,
    });
    busyUntil = ex.exitMs + MIN;
  }
  return { trades, funnel };
}

// ---- reporting -----------------------------------------------------------------------------------

const f = (x: number, d = 3) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(d) : String(x));
const line = (label: string, s: Summary) =>
  `${label.padEnd(24)} n=${String(s.n).padStart(4)}  WR ${(s.wr * 100).toFixed(1).padStart(5)}%  exp ${f(s.exp)}R  95%CI [${f(s.ciLo)}, ${f(s.ciHi)}]  PF ${s.pf.toFixed(2)}  total ${f(s.total, 1)}R  maxDD ${s.maxDD.toFixed(1)}R`;
const closed = (ts: Trade[]) => ts.filter((t) => t.reason !== "OPEN");
const inWin = (ts: Trade[], w: { from: number; to: number }) => closed(ts).filter((t) => { const e = Date.parse(t.entryT); return e >= w.from && e < w.to; });

function report(title: string, ts: Trade[]) {
  console.log(`\n=== ${title} ===`);
  const all = summarize(ts.map((t) => t.netR));
  console.log(line("ALL (ambiguous = stop)", all));
  console.log(line("excluding ambiguous", summarize(ts.filter((t) => t.reason !== "AMBIGUOUS").map((t) => t.netR))));
  const med = (xs: number[]) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN;
  console.log(`median risk ${med(ts.map((t) => t.riskPips)).toFixed(1)} pips  median planned R ${med(ts.map((t) => t.plannedR)).toFixed(2)}  median hold ${med(ts.map((t) => t.holdMin)).toFixed(0)} min  ambiguous ${ts.filter((t) => t.reason === "AMBIGUOUS").length}`);
  const per: Record<string, Summary> = {};
  console.log("-- by pair");
  for (const s of SYMBOLS) { per[s] = summarize(ts.filter((t) => t.sym === s).map((t) => t.netR)); console.log(line(`  ${s}`, per[s])); }
  const group = (label: string, key: (t: Trade) => string) => {
    console.log(`-- by ${label}`);
    for (const g of [...new Set(ts.map(key))].sort()) console.log(line(`  ${g}`, summarize(ts.filter((t) => key(t) === g).map((t) => t.netR))));
  };
  group("session", (t) => t.session);
  group("month", (t) => t.entryT.slice(0, 7));
  group("exit reason", (t) => t.reason);
  group("planned R", (t) => (t.plannedR < 1.5 ? "1.0-1.5" : t.plannedR < 2.5 ? "1.5-2.5" : t.plannedR < 4 ? "2.5-4" : "4+"));
  return { all, per };
}

function writeCsv(name: string, ts: Trade[]) {
  if (ts.length === 0) return;
  const cols = Object.keys(ts[0]) as Array<keyof Trade>;
  Deno.writeTextFileSync(new URL(`../docs/exports/${name}`, import.meta.url), [cols.join(","), ...ts.map((t) => cols.map((c) => String(t[c])).join(","))].join("\n") + "\n");
  console.log(`wrote docs/exports/${name} (${ts.length} trades)`);
}

if (import.meta.main) {
  const wantHoldout = Deno.args.includes("--holdout");
  console.log("SCALPER15_PREREG_V1 — 15m impulse, 1H direction, 5m confirmation, stop beyond zone, target = 1H leg extreme");
  const all: Trade[] = [];
  const funnel: Funnel = {};
  for (const sym of SYMBOLS) {
    const counts = ["1m", "5m", "15m", "1h"].map((tf) => loadTf(sym, tf).length);
    if (counts.some((c) => c === 0)) { console.log(`  ${sym}: corpus missing (${counts.join("/")}) — run scalper15-fetch.ts`); Deno.exit(1); }
    const t0 = performance.now();
    // The loop runs through the holdout so state is continuous; holdout trades stay unreported unless unlocked.
    const r = runSymbol(sym);
    all.push(...r.trades);
    for (const [k, v] of Object.entries(r.funnel)) funnel[k] = (funnel[k] ?? 0) + v;
    console.log(`  ${sym.padEnd(8)} bars 1m/5m/15m/1h ${counts.join("/")}  trades ${r.trades.length}  ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log("\nfunnel (whole run, IS + holdout):", JSON.stringify(funnel));

  const isT = inWin(all, IS);
  const is = report("IN-SAMPLE decisions 2026-03-29 → 2026-09-25", isT);
  writeCsv("scalper15_v1_trades_is.csv", isT);

  const positive = SYMBOLS.filter((s) => is.per[s].exp > 0).length;
  const g1 = [
    [`≥ 100 trades (${is.all.n})`, is.all.n >= 100],
    ["net expectancy > 0", is.all.exp > 0],
    ["profit factor ≥ 1.10", is.all.pf >= 1.10],
    [`≥ 4 of 7 pairs positive (${positive})`, positive >= 4],
  ] as const;
  console.log("\n=== GATE G1 (pre-registered, ambiguous = stop) ===");
  for (const [k, ok] of g1) console.log(`  ${ok ? "PASS" : "FAIL"}  ${k}`);
  const g1Pass = g1.every(([, ok]) => ok);
  console.log(`  G1: ${g1Pass ? "PASSED" : "FAILED — idea rejected; the holdout stays locked"}`);
  console.log(`  reference: #677 15m zones −0.20R`);

  console.log("\n=== DESCRIPTIVE ONLY (in-sample) ===");
  const x2 = SYMBOLS.flatMap((s) => inWin(runSymbol(s, 2, IS.from, IS.to).trades, IS));
  console.log(line("2× costs", summarize(x2.map((t) => t.netR))));

  if (wantHoldout) {
    if (!g1Pass) { console.log("\n--holdout refused: G1 did not pass. The holdout stays unseen."); Deno.exit(1); }
    const hoT = inWin(all, HOLDOUT);
    const ho = report("HOLDOUT decisions 2026-09-26 → 2026-11-04 (single evaluation)", hoT);
    writeCsv("scalper15_v1_trades_holdout.csv", hoT);
    console.log(`\n=== GATE G2 ===\n  ${ho.all.exp > 0 ? "PASS" : "FAIL"}  net expectancy > 0 (${f(ho.all.exp)}R, n=${ho.all.n})`);
    console.log(`  G2: ${ho.all.exp > 0 ? "PASSED → design the production shadow arm" : "FAILED — idea rejected"}`);
  }
}
