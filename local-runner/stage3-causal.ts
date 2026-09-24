/**
 * STAGE 3 FINAL — causal remeasurement of the recovered validation corpus.
 *
 * RESEARCH ONLY. Reads the replay checkpoint and Twelve Data 1m, writes local
 * JSON. No database, no strategy change, no deployment. The strategy rules are
 * untouched: E2, S2 close-confirmation, the 2R target, costs and sequencing all
 * come from the frozen engine's own output and are never recomputed here.
 *
 * WHAT IS CORRECTED, AND ONLY THIS. The frozen engine resolves a trade's entry
 * bar against the WHOLE of that bar, so a high that preceded the entry touch can
 * book a target the position never reached. This re-derives the entry bar from
 * its minutes, then hands survivors back to the unmodified HTF rules.
 *
 * PROVENANCE. Both the HTF bars and the minutes come from Twelve Data, fetched
 * by this research for this corpus, so the resolution is SOURCE_MATCHED by
 * construction rather than by comparison. The meaningful integrity check is
 * therefore whether the minutes aggregate back to their own HTF bar, which is
 * asserted per trade.
 */

import {
  resolveEntryBar, continueAfterEntryBar,
  type FeedIdentity, type TradeSpec, type Resolution, type ForwardResult,
} from "../supabase/functions/_shared/ipoIntrabarResolution.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

const KEY = Deno.env.get("TWELVE_DATA_API_KEY");
if (!KEY) { console.error("TWELVE_DATA_API_KEY not set; refusing to run."); Deno.exit(1); }

const FEED: FeedIdentity = {
  provider: "twelvedata", venue: "TwelveData composite", symbol: "*",
  provenance: "SOURCE_MATCHED",
  basis: "HTF bars and minutes both fetched from Twelve Data for this corpus; " +
         "same provider by construction, with per-trade aggregation verification.",
};

// ── inputs ───────────────────────────────────────────────────────────────────

interface TD {
  entryIndex: number; exitIndex: number; netR: number; vol: string;
  ipoIndex: number; direction: string; entry: number; stop: number; target: number;
  risk: number; costR: number; entryBarTime: string; exitBarTime: string; ipoCandleTime: string;
}
interface Ckpt {
  window: string; instrument: string; from: string; to: string;
  rawBars: number; droppedBars: number; bars: number; trades: number;
  totalR: number; completed: boolean; trades_detail: TD[];
}
const ckpts: Record<string, Ckpt> = JSON.parse(
  await Deno.readTextFile("/tmp/baseline-determinism-checkpoint.json"));
const htfCache: Record<string, Candle[]> = JSON.parse(
  await Deno.readTextFile("/tmp/td-htf-windows.json"));

const isDecimalShift = (b: Candle) => b.low < Math.min(b.open, b.close) / 100;

/** HTF bars for a window, under a given BTC treatment. */
function htfBars(c: Ckpt, treatment: "DROP" | "REPAIR"): Candle[] {
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === c.instrument)!;
  const key = `${c.instrument}|${inst.timeframe === "30min" ? "30min" : "1h"}|${c.from}|${c.to}`;
  const raw = htfCache[key] ?? [];
  if (c.instrument !== "BTC/USD") return raw;
  return treatment === "DROP"
    ? raw.filter((b) => !isDecimalShift(b))
    // Freeze §17's own documented alternative: repair rather than drop.
    : raw.map((b) => isDecimalShift(b) ? { ...b, low: Math.min(b.open, b.close) } : b);
}

// ── 1-minute fetch, three days per request ───────────────────────────────────

const M_CACHE = "/tmp/td-1m-corpus.json";
let minutes: Record<string, Candle[]> = {};
try { minutes = JSON.parse(await Deno.readTextFile(M_CACHE)); } catch { /* cold */ }
let requests = 0, rateLimited = 0, retries = 0, mCacheHits = 0, mCacheMisses = 0, apiErrors = 0;
let minutesCleaned = 0;

const dayOf = (iso: string) => iso.slice(0, 10);
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Fetches a 3-day block; ~4,300 minute rows, inside outputsize. */
async function fetchBlock(symbol: string, start: string): Promise<void> {
  const end = addDays(start, 3);
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("interval", "1min");
  u.searchParams.set("outputsize", "5000");
  u.searchParams.set("order", "ASC");
  u.searchParams.set("timezone", "UTC");
  u.searchParams.set("start_date", `${start} 00:00:00`);
  u.searchParams.set("end_date", `${end} 00:00:00`);
  u.searchParams.set("apikey", KEY!);

  // deno-lint-ignore no-explicit-any
  let b: any = {};
  for (let a = 0; a < 8; a++) {
    requests++; if (a > 0) retries++;
    const res = await fetch(u);
    b = await res.json();
    if (b?.status !== "error") break;
    if (String(b?.code) === "429") { rateLimited++; await new Promise((s) => setTimeout(s, 65_000)); continue; }
    apiErrors++; throw new Error(`twelvedata ${b?.code}: ${String(b?.message).slice(0, 90)}`);
  }
  if (b?.status === "error") { apiErrors++; throw new Error("gave up after retries"); }

  const rows: Candle[] = (b?.values ?? []).map((v: Record<string, string>) => ({
    datetime: `${v.datetime.replace(" ", "T")}Z`,
    open: Number(v.open), high: Number(v.high), low: Number(v.low),
    close: Number(v.close), volume: Number(v.volume ?? 0),
  }));
  // Bucket into days so a partial block still caches what it got.
  for (let i = 0; i < 3; i++) {
    const d = addDays(start, i);
    minutes[`${symbol}|${d}`] = rows.filter((r) => dayOf(r.datetime) === d);
  }
  await Deno.writeTextFile(M_CACHE, JSON.stringify(minutes));
  await new Promise((s) => setTimeout(s, 9000));
}

async function minutesFor(symbol: string, day: string): Promise<Candle[]> {
  const k = `${symbol}|${day}`;
  if (minutes[k]) { mCacheHits++; return minutes[k]; }
  mCacheMisses++;
  // Align blocks to a fixed 3-day grid so neighbouring days share a request.
  const epochDay = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86400000);
  const blockStart = new Date((epochDay - (epochDay % 3)) * 86400000).toISOString().slice(0, 10);
  await fetchBlock(symbol, blockStart);
  return minutes[k] ?? [];
}

// ── classify and resolve ─────────────────────────────────────────────────────

type Klass = "NOT_INTRABAR_SENSITIVE" | "1M_RESOLVED" | "TICK_REQUIRED"
  | "DATA_UNAVAILABLE" | "PROVIDER_UNCERTAIN";

interface Row {
  window: string; instrument: string; entryBarTime: string; direction: string;
  entry: number; stop: number; target: number; risk: number; costR: number; vol: string;
  legacyNetR: number; sameBar: boolean;
  klass: Klass;
  minutesSeen: number; aggOk: boolean | null;
  entryMinute: string | null; entryBarOutcome: string | null;
  forwardOutcome: string | null; exitBarTime: string | null;
  causalGrossR: number | null; causalNetR: number | null;
  mfeR: number | null; maeR: number | null;
}

const AGG_LIMIT = 0.0005;

async function run(treatment: "DROP" | "REPAIR"): Promise<Row[]> {
  const out: Row[] = [];
  for (const c of Object.values(ckpts)) {
    if (!c.completed) continue;
    const inst = IPO_INSTRUMENTS.find((i) => i.instrument === c.instrument)!;
    const bars = htfBars(c, treatment);
    const byTime = new Map(bars.map((b, i) => [b.datetime, i]));

    for (const t of c.trades_detail) {
      const base: Row = {
        window: c.window, instrument: c.instrument, entryBarTime: t.entryBarTime,
        direction: t.direction, entry: t.entry, stop: t.stop, target: t.target,
        risk: t.risk, costR: t.costR, vol: t.vol, legacyNetR: t.netR,
        sameBar: t.entryIndex === t.exitIndex, klass: "NOT_INTRABAR_SENSITIVE",
        minutesSeen: 0, aggOk: null, entryMinute: null, entryBarOutcome: null,
        forwardOutcome: null, exitBarTime: t.exitBarTime,
        causalGrossR: null, causalNetR: t.netR, mfeR: null, maeR: null,
      };
      if (t.entryIndex !== t.exitIndex) { out.push(base); continue; }

      // Same-bar: needs 1m.
      let ms: Candle[] = [];
      try { ms = await minutesFor(c.instrument, dayOf(t.entryBarTime)); }
      catch { out.push({ ...base, klass: "DATA_UNAVAILABLE", causalNetR: null }); continue; }

      const start = Date.parse(t.entryBarTime);
      const end = start + inst.barMs;
      // THE SAME DOCUMENTED CLEANING MUST APPLY TO THE MINUTES.
      // Freeze §17's decimal-shift glitch is a property of the FEED, not of the
      // 1-hour aggregation, so the minute series carries it too. Cleaning only
      // the HTF bars let a corrupt minute close become an S2 exit price: two
      // BTC trades in 2023-06..08 booked -489R each, which is a data artifact
      // and not a strategy outcome. This applies the identical rule — no new
      // rule, no new threshold — to the minutes before they are used.
      const winRaw = ms.filter((m) => { const x = Date.parse(m.datetime); return x >= start && x < end; });
      const win = c.instrument === "BTC/USD"
        ? (treatment === "DROP"
            ? winRaw.filter((m) => !isDecimalShift(m))
            : winRaw.map((m) => isDecimalShift(m) ? { ...m, low: Math.min(m.open, m.close) } : m))
        : winRaw;
      minutesCleaned += winRaw.length - win.length;
      if (win.length === 0) { out.push({ ...base, klass: "DATA_UNAVAILABLE", causalNetR: null }); continue; }

      // Part O: minutes must aggregate back to their own HTF bar.
      const hi = Math.max(...win.map((m) => m.high)), lo = Math.min(...win.map((m) => m.low));
      const bi = byTime.get(t.entryBarTime);
      const hb = bi === undefined ? null : bars[bi];
      const aggOk = hb ? Math.max(Math.abs(hi - hb.high), Math.abs(lo - hb.low)) / hb.close <= AGG_LIMIT : false;
      if (!aggOk) {
        out.push({ ...base, klass: "DATA_UNAVAILABLE", minutesSeen: win.length, aggOk, causalNetR: null });
        continue;
      }

      const spec: TradeSpec = {
        direction: t.direction === "demand" ? "long" : "short",
        entry: t.entry, target: t.target, s2: t.stop, risk: t.risk,
      };
      const r: Resolution = resolveEntryBar(spec, win, FEED);
      if (r.outcome === "UNRESOLVED_AT_1M" || r.outcome === "NO_ENTRY_AT_1M") {
        out.push({ ...base, klass: "TICK_REQUIRED", minutesSeen: win.length, aggOk,
                   entryMinute: r.entryMinuteTime, entryBarOutcome: r.outcome, causalNetR: null });
        continue;
      }

      let fwd: ForwardResult;
      if (r.outcome === "TARGET_AFTER_ENTRY") {
        fwd = { outcome: "TARGET", exitBarTime: r.targetMinuteTime, exitPrice: spec.target,
                barsHeld: 0, grossR: Math.abs(spec.target - spec.entry) / spec.risk,
                mfeR: r.postEntryMfeR, maeR: r.postEntryMaeR, ambiguousBarTime: null };
      } else if (r.outcome === "S2_CLOSE_AFTER_ENTRY") {
        const mb = win.find((m) => m.datetime === r.s2CloseMinuteTime)!;
        const long = spec.direction === "long";
        fwd = { outcome: "S2_CLOSE", exitBarTime: r.s2CloseMinuteTime, exitPrice: mb.close,
                barsHeld: 0, grossR: (long ? mb.close - spec.entry : spec.entry - mb.close) / spec.risk,
                mfeR: r.postEntryMfeR, maeR: r.postEntryMaeR, ambiguousBarTime: null };
      } else {
        const i = bi ?? -1;
        fwd = continueAfterEntryBar(spec, i >= 0 ? bars.slice(i + 1) : [], r.postEntryMfeR, r.postEntryMaeR);
      }

      const unresolvedFwd = fwd.outcome === "AMBIGUOUS_LATER_BAR"
        || fwd.outcome === "STILL_OPEN_AT_END_OF_DATA";
      out.push({
        ...base,
        klass: unresolvedFwd ? "TICK_REQUIRED" : "1M_RESOLVED",
        minutesSeen: win.length, aggOk,
        entryMinute: r.entryMinuteTime, entryBarOutcome: r.outcome,
        forwardOutcome: fwd.outcome, exitBarTime: fwd.exitBarTime,
        causalGrossR: fwd.grossR,
        causalNetR: fwd.grossR === null ? null : fwd.grossR - t.costR,
        mfeR: fwd.mfeR, maeR: fwd.maeR,
      });
    }
  }
  return out;
}

// ── metrics ──────────────────────────────────────────────────────────────────

function metrics(rs: Array<{ netR: number }>) {
  const n = rs.length;
  if (!n) return { n: 0, wins: 0, losses: 0, win: 0, totalR: 0, expR: 0, pf: 0, maxDD: 0,
                   avgWin: 0, avgLoss: 0, medWin: 0, medLoss: 0, winStreak: 0, lossStreak: 0 };
  const w = rs.filter((r) => r.netR > 0).map((r) => r.netR);
  const l = rs.filter((r) => r.netR < 0).map((r) => r.netR);
  const gp = w.reduce((a, x) => a + x, 0), gl = Math.abs(l.reduce((a, x) => a + x, 0));
  const totalR = rs.reduce((a, r) => a + r.netR, 0);
  let peak = 0, cum = 0, maxDD = 0, ws = 0, ls = 0, bw = 0, bl = 0;
  for (const r of rs) {
    cum += r.netR; if (cum > peak) peak = cum; if (peak - cum > maxDD) maxDD = peak - cum;
    if (r.netR > 0) { ws++; ls = 0; if (ws > bw) bw = ws; } else if (r.netR < 0) { ls++; ws = 0; if (ls > bl) bl = ls; }
  }
  const med = (a: number[]) => a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0;
  return { n, wins: w.length, losses: l.length, win: (w.length / n) * 100, totalR,
           expR: totalR / n, pf: gl === 0 ? Infinity : gp / gl, maxDD,
           avgWin: w.length ? gp / w.length : 0, avgLoss: l.length ? -gl / l.length : 0,
           medWin: med(w), medLoss: med(l), winStreak: bw, lossStreak: bl };
}

// ── go ───────────────────────────────────────────────────────────────────────

const t0 = Date.now();
console.log("TREATMENT A — BTC_CLEANING_62_RECONSTRUCTED (drop)\n");
const A = await run("DROP");
await Deno.writeTextFile("/tmp/stage3-causal-A.json", JSON.stringify(A, null, 1));

console.log("TREATMENT B — BTC_CLEANING_REPAIR_DOCUMENTED_ALTERNATIVE (§17 repair)\n");
const B = await run("REPAIR");
await Deno.writeTextFile("/tmp/stage3-causal-B.json", JSON.stringify(B, null, 1));

function report(rows: Row[], label: string) {
  console.log(`\n${"=".repeat(100)}\n${label}\n${"=".repeat(100)}`);
  const byK: Record<string, number> = {};
  for (const r of rows) byK[r.klass] = (byK[r.klass] ?? 0) + 1;
  console.log("classification:", JSON.stringify(byK));
  // Part R invariant.
  const sum = Object.values(byK).reduce((a, b) => a + b, 0);
  if (sum !== rows.length) { console.error(`INVARIANT FAIL: ${sum} != ${rows.length}`); Deno.exit(1); }

  for (const inst of ["EUR/USD", "USD/JPY", "BTC/USD"]) {
    const set = rows.filter((r) => r.instrument === inst);
    const res = set.filter((r) => r.causalNetR !== null) as Array<Row & { causalNetR: number }>;
    const unres = set.filter((r) => r.causalNetR === null);
    if (res.length + unres.length !== set.length) { console.error("INVARIANT FAIL: partition"); Deno.exit(1); }
    const m = metrics(res.map((r) => ({ netR: r.causalNetR })));
    const legacy = metrics(set.map((r) => ({ netR: r.legacyNetR })));
    console.log(`\n${inst}  population ${set.length}   resolved ${res.length}   unresolved ${unres.length}`);
    console.log(`  LEGACY  n=${legacy.n} win=${legacy.win.toFixed(1)}% expR=${legacy.expR.toFixed(3)} PF=${legacy.pf.toFixed(2)} totalR=${legacy.totalR.toFixed(1)} maxDD=${legacy.maxDD.toFixed(1)}`);
    console.log(`  CAUSAL  n=${m.n} win=${m.win.toFixed(1)}% expR=${m.expR.toFixed(3)} PF=${m.pf.toFixed(2)} totalR=${m.totalR.toFixed(1)} maxDD=${m.maxDD.toFixed(1)}`);
    console.log(`          W/L ${m.wins}/${m.losses}  avgW ${m.avgWin.toFixed(2)} avgL ${m.avgLoss.toFixed(2)}  medW ${m.medWin.toFixed(2)} medL ${m.medLoss.toFixed(2)}  streak +${m.winStreak}/-${m.lossStreak}`);
  }
  const allRes = rows.filter((r) => r.causalNetR !== null) as Array<Row & { causalNetR: number }>;
  const allUn = rows.filter((r) => r.causalNetR === null);
  const pm = metrics(allRes.map((r) => ({ netR: r.causalNetR })));
  const pl = metrics(rows.map((r) => ({ netR: r.legacyNetR })));
  console.log(`\nPORTFOLIO  population ${rows.length}  resolved ${allRes.length}  unresolved ${allUn.length}`);
  console.log(`  LEGACY  n=${pl.n} win=${pl.win.toFixed(1)}% expR=${pl.expR.toFixed(3)} PF=${pl.pf.toFixed(2)} totalR=${pl.totalR.toFixed(1)} maxDD=${pl.maxDD.toFixed(1)}`);
  console.log(`  CAUSAL  n=${pm.n} win=${pm.win.toFixed(1)}% expR=${pm.expR.toFixed(3)} PF=${pm.pf.toFixed(2)} totalR=${pm.totalR.toFixed(1)} maxDD=${pm.maxDD.toFixed(1)}`);

  // Bounds over the unresolved.
  const bestCase = allUn.reduce((a, r) => a + (2 - r.costR), 0);
  const worstCase = allUn.reduce((a, r) => a + (r.mfeR !== null ? -1 - r.costR : -1 - r.costR), 0);
  console.log(`  UNRESOLVED ${allUn.length}: optimistic +${bestCase.toFixed(1)}R -> portfolio ${(pm.totalR + bestCase).toFixed(1)}R`);
  console.log(`                 pessimistic ${worstCase.toFixed(1)}R -> portfolio ${(pm.totalR + worstCase).toFixed(1)}R`);

  // Bug inflation.
  const sens = rows.filter((r) => r.sameBar);
  const unaff = rows.filter((r) => !r.sameBar);
  const sensRes = sens.filter((r) => r.causalNetR !== null) as Array<Row & { causalNetR: number }>;
  console.log(`\n  unaffected (multi-bar) n=${unaff.length} legacyR=${unaff.reduce((a, r) => a + r.legacyNetR, 0).toFixed(1)}`);
  console.log(`  intrabar-sensitive     n=${sens.length} legacyR=${sens.reduce((a, r) => a + r.legacyNetR, 0).toFixed(1)}`);
  console.log(`  of those, resolved     n=${sensRes.length} legacyR=${sensRes.reduce((a, r) => a + r.legacyNetR, 0).toFixed(1)} -> causalR=${sensRes.reduce((a, r) => a + r.causalNetR, 0).toFixed(1)}`);
  const changed = sensRes.filter((r) => Math.abs(r.causalNetR - r.legacyNetR) > 1e-9).length;
  console.log(`  outcomes changed: ${changed}/${sensRes.length}`);
}

console.log(`\nBTC minutes cleaned during both passes: ${minutesCleaned}`);
report(A, "TREATMENT A — BTC_CLEANING_62_RECONSTRUCTED");
report(B, "TREATMENT B — BTC_CLEANING_REPAIR_DOCUMENTED_ALTERNATIVE");

console.log(`\nruntime ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min   ` +
  `API: ${requests} requests, ${mCacheHits} minute-cache hits, ${mCacheMisses} misses, ` +
  `${rateLimited} 429s, ${retries} retries, ${apiErrors} errors`);
