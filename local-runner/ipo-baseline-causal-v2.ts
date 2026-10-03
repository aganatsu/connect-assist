/**
 * IPO_BASELINE_1H_4H_CAUSAL_V2 — per-window rebuild. RESEARCH ONLY.
 *
 * Runs ONE instrument-window (index 0-11 of SPECS) and writes its result to
 * local-runner/.cache/ipo-v2/out/<window>.json. ipo-baseline-causal-v2-report.ts
 * aggregates the twelve.
 *
 * Per window:
 *   1. V1 PARITY CONTROL. An exact copy of IPO_BASELINE_1H_4H_CAUSAL_V1's ARM C
 *      loop and 1m resolver (ipo-tf-baseline.ts @ 784aab32), run on the rebuilt
 *      inputs, compared row by row with the frozen export. This proves the inputs
 *      (strategy bars, decision span, 1m) are the ones V1 used.
 *   2. V2. The production lifecycle read one bar ahead (ipoCausalV2.ts), entries
 *      at the causal fill minute, production `resolveBar` from the fill on, one
 *      shared 1H/4H slot in fill order. Run under two zone-selection rules:
 *        PRODUCTION_BAR -> IPO_BASELINE_1H_4H_CAUSAL_V2 (as specified)
 *        TOUCH_ORDER    -> V2 strict (also removes the zone-selection look-ahead)
 *   3. DATA AUDIT. Every 1m and strategy bar the window reads.
 *
 *   deno run --allow-read --allow-write local-runner/ipo-baseline-causal-v2.ts <0-11>
 */

import { IncrementalEngine } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import type { EngineConfig, LiveTrade } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import { ipoGeometry } from "../supabase/functions/_shared/ipoZones.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";
import { minuteIndex, scanSeries, simulateSlot, type Selection, type SimTrade, type ScanPE, type Diagnosis } from "./ipoCausalV2.ts";
import { loadWindow } from "./ipo-v2-m1-fetch.ts";
import { sanitizeM1, gapOk, readCsv } from "./ipo-entry-m1-fetch.ts";

export const OUT_DIR = new URL("./.cache/ipo-v2/out/", import.meta.url);
const TF_CACHE = new URL("./.cache/ipo-ttm/", import.meta.url);
const FROZEN = new URL("../docs/exports/ipo_1h_4h_combined_clean.csv", import.meta.url);
const WARMUP = 400;
const BAR_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000 };

/** Identical to ipo-tf-baseline.ts SPECS. */
export const SPECS = [
  { inst: "EUR/USD", end: "2022-07-01", m1: "EURUSD_2022-04-01" },
  { inst: "EUR/USD", end: "2025-04-01", m1: "EURUSD_2025-01-01" },
  { inst: "EUR/USD", end: "2025-07-01", m1: "EURUSD_2025-04-01" },
  { inst: "EUR/USD", end: "2025-11-01", m1: "EURUSD_2025-08-01" },
  { inst: "BTC/USD", end: "2022-07-01", m1: "BTCUSD_2022-04-01" },
  { inst: "BTC/USD", end: "2025-04-01", m1: "BTCUSD_2025-01-01" },
  { inst: "BTC/USD", end: "2025-07-01", m1: "BTCUSD_2025-04-01" },
  { inst: "BTC/USD", end: "2025-11-01", m1: "BTCUSD_2025-08-01" },
  { inst: "USD/JPY", end: "2022-11-01", m1: "USDJPY_2022-08-01" },
  { inst: "USD/JPY", end: "2025-04-01", m1: "USDJPY_2025-01-01" },
  { inst: "USD/JPY", end: "2025-07-01", m1: "USDJPY_2025-04-01" },
  { inst: "USD/JPY", end: "2025-11-01", m1: "USDJPY_2025-08-01" },
];

// ═══ V1 resolver and row builder — copied verbatim from ipo-tf-baseline.ts ═══
type Ordering = "HTF_UNAMBIGUOUS" | "1M_RESOLVED" | "TICK_RESOLVED" | "EXECUTION_AMBIGUOUS";
function resolveV1(
  t: LiveTrade, bars: Candle[], m1bars: Candle[], barMs: number,
): {
  ordering: Ordering; detail: string; reason: string;
  m1Entry: string; m1Target: string; s2Time: string;
  exitTime: string; exitPrice: number | ""; grossR: number | "";
} {
  const long = t.direction === "demand";
  const nil = { m1Entry: "", m1Target: "", s2Time: "", exitTime: "", exitPrice: "" as const, grossR: "" as const };
  if (!m1bars.length) return { ordering: "EXECUTION_AMBIGUOUS", detail: "NO_1M_COVERAGE", reason: "UNRESOLVED", ...nil };
  const entryBarStart = Date.parse(bars[t.entryIndex].datetime);
  const m1First = Date.parse(m1bars[0].datetime), m1Last = Date.parse(m1bars[m1bars.length - 1].datetime);
  if (entryBarStart < m1First || entryBarStart > m1Last) {
    return { ordering: "EXECUTION_AMBIGUOUS", detail: "1M_GAP_AT_ENTRY_BAR", reason: "UNRESOLVED", ...nil };
  }
  let ei = -1;
  for (let i = 0; i < m1bars.length; i++) {
    const ts = Date.parse(m1bars[i].datetime);
    if (ts < entryBarStart) continue;
    if (ts >= entryBarStart + barMs) break;
    const b = m1bars[i];
    if (long ? b.low <= t.entry : b.high >= t.entry) { ei = i; break; }
  }
  if (ei < 0) return { ordering: "EXECUTION_AMBIGUOUS", detail: "ENTRY_NOT_CONFIRMED_IN_1M", reason: "UNRESOLVED", ...nil };
  const m1Entry = m1bars[ei].datetime;
  let s2Bar = -1;
  for (let k = t.entryIndex; k < bars.length; k++) {
    const c = bars[k];
    if (long ? c.close < t.stop : c.close > t.stop) { s2Bar = k; break; }
  }
  const s2Instant = s2Bar >= 0 ? Date.parse(bars[s2Bar].datetime) + barMs : Infinity;
  let tgtIdx = -1;
  for (let i = ei; i < m1bars.length; i++) {
    const ts = Date.parse(m1bars[i].datetime);
    if (ts > s2Instant) break;
    const b = m1bars[i];
    if (long ? b.high >= t.target : b.low <= t.target) { tgtIdx = i; break; }
  }
  if (tgtIdx < 0) {
    if (s2Bar < 0) {
      return { ordering: "EXECUTION_AMBIGUOUS", detail: "NO_EXIT_WITHIN_COVERAGE", reason: "OPEN_AT_DATA_END",
        m1Entry, m1Target: "", s2Time: "", exitTime: "", exitPrice: "", grossR: "" };
    }
    const px = bars[s2Bar].close;
    const gross = (long ? px - t.entry : t.entry - px) / t.risk;
    return { ordering: "HTF_UNAMBIGUOUS", detail: "", reason: "S2_CLOSE_INVALIDATION",
      m1Entry, m1Target: "", s2Time: bars[s2Bar].datetime,
      exitTime: bars[s2Bar].datetime, exitPrice: px, grossR: gross };
  }
  const tgtMinuteEnd = Date.parse(m1bars[tgtIdx].datetime) + 60_000;
  if (s2Bar >= 0 && tgtMinuteEnd > s2Instant) {
    return { ordering: "EXECUTION_AMBIGUOUS", detail: "TARGET_IN_S2_CLOSING_MINUTE", reason: "UNRESOLVED",
      m1Entry, m1Target: m1bars[tgtIdx].datetime, s2Time: bars[s2Bar].datetime,
      exitTime: "", exitPrice: "", grossR: "" };
  }
  return {
    ordering: s2Bar >= 0 ? "1M_RESOLVED" : "HTF_UNAMBIGUOUS",
    detail: "", reason: "TARGET",
    m1Entry, m1Target: m1bars[tgtIdx].datetime,
    s2Time: s2Bar >= 0 ? bars[s2Bar].datetime : "",
    exitTime: m1bars[tgtIdx].datetime, exitPrice: t.target,
    grossR: Math.abs(t.target - t.entry) / t.risk,
  };
}
// ═══ end of verbatim copy ═══

export interface V1Row { tf: string; ipo_origin_time: string; entry_time: string; direction: string; exit_reason: string; net_r: number | ""; excluded: boolean; K: number; k: number }
export interface V2Trade {
  selection: Selection; window: string; instrument: string; tf: string; direction: string; inScope: boolean;
  ipo_origin_time: string; ipo_open: number; ipo_high: number; ipo_low: number; ipo_close: number;
  zone_low: number; zone_high: number; entry: number; s2: number; target: number; risk: number;
  touch_bar_time: string; K: number; k: number; fill_minute: string | null; fill_note: string;
  outcome: string; alt_branch: string | null; open_branch: string | null; method: string;
  target_minute: string | null; s2_bar_time: string | null; exit_bar_time: string | null; exit_price: number | null;
  gross_r: number | null; cost_r: number; net_r: number | null; same_bar_s2: boolean; n_eligible: number;
  production_view: string[]; data_flags: string[]; fill_ms: number; exit_ms: number | null;
}

if (import.meta.main) {
  const idx = Number(Deno.args[0]);
  const spec = SPECS[idx];
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === spec.inst)!;
  const wf = loadWindow(spec.m1);
  if (!wf || !wf.complete) throw new Error(`1m for ${spec.m1} missing or incomplete`);
  const mb = wf.bars;
  const decStart = Date.parse(mb[0].datetime), decEnd = Date.parse(mb[mb.length - 1].datetime);
  const window = `${spec.inst}_${spec.end}`;
  const t0 = performance.now();

  // strategy series exactly as V1 cut them
  const series: Record<string, Candle[]> = {};
  for (const tf of ["1h", "4h"]) {
    const full = JSON.parse(Deno.readTextFileSync(new URL(`${spec.inst.replace("/", "")}_${spec.end}_${tf}.json`, TF_CACHE))) as Candle[];
    const startIdx = Math.max(0, full.findIndex((c) => Date.parse(c.datetime) >= decStart) - WARMUP);
    series[tf] = full.slice(startIdx).filter((c) => Date.parse(c.datetime) <= decEnd);
  }

  // ── 1. V1 parity control (ARM C, verbatim logic) ─────────────────────────
  const slot = { by: null as null | "1h" | "4h" };
  const eng: Record<string, IncrementalEngine> = {};
  for (const tf of ["1h", "4h"]) {
    eng[tf] = new IncrementalEngine({ instrument: inst.instrument, timeframe: tf, highVolOnly: inst.highVolOnly,
      costPerSide: inst.costPerSide, entryGate: () => slot.by === null || slot.by === tf } as EngineConfig);
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
  const v1: V1Row[] = [];
  for (const tf of ["1h", "4h"] as const) {
    for (const t of eng[tf].trades) {
      if (Date.parse(series[tf][t.entryIndex].datetime) < decStart) continue;
      const r = resolveV1(t, series[tf], mb, BAR_MS[tf]);
      const costR = (2 * inst.costPerSide(t.entry)) / t.risk;   // V1's toRow prices cost at the entry
      const net = r.grossR === "" ? "" : (r.grossR as number) - costR;
      v1.push({ tf, ipo_origin_time: series[tf][t.ipoIndex].datetime, entry_time: series[tf][t.entryIndex].datetime,
        direction: t.direction, exit_reason: r.reason, net_r: net, excluded: r.ordering === "EXECUTION_AMBIGUOUS",
        K: t.entryIndex, k: t.ipoIndex });
    }
  }
  const frozen = readCsv(FROZEN).filter((r) => r.window === window);
  const key = (tf: string, ipo: string, entry: string) => `${tf}|${ipo}|${entry}`;
  const v1Clean = new Map(v1.filter((r) => !r.excluded).map((r) => [key(r.tf, r.ipo_origin_time, r.entry_time), r]));
  let parityMatch = 0, parityOutcome = 0; const parityMissing: string[] = [];
  for (const f of frozen) {
    const r = v1Clean.get(key(f.ipo_timeframe, f.ipo_origin_time, f.entry_time));
    if (!r) { parityMissing.push(key(f.ipo_timeframe, f.ipo_origin_time, f.entry_time)); continue; }
    parityMatch++;
    if (r.exit_reason === f.exit_reason && Math.abs((r.net_r as number) - +f.net_r) < 1e-9) parityOutcome++;
  }
  const parityExtra = [...v1Clean.keys()].filter((k) => !frozen.some((f) => key(f.ipo_timeframe, f.ipo_origin_time, f.entry_time) === k));

  // ── 2. V2 ────────────────────────────────────────────────────────────────
  const cfg = (tf: string): EngineConfig => ({ instrument: inst.instrument, timeframe: tf, highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide });
  // diagnose every frozen V1 entry on the pre-bar state
  const v1Frozen = frozen.map((f) => {
    const bars = series[f.ipo_timeframe];
    return { f, K: bars.findIndex((b) => b.datetime === f.entry_time), k: bars.findIndex((b) => b.datetime === f.ipo_origin_time),
      direction: f.direction };
  });
  const scans: Record<string, ReturnType<typeof scanSeries>> = {};
  const minutesFor: Record<string, (j: number) => Candle[]> = {};
  for (const tf of ["1h", "4h"]) {
    minutesFor[tf] = minuteIndex(mb, series[tf], BAR_MS[tf]);
    scans[tf] = scanSeries(tf, series[tf], BAR_MS[tf], cfg(tf), minutesFor[tf],
      v1Frozen.filter((x) => x.f.ipo_timeframe === tf).map((x) => ({ K: x.K, k: x.k, direction: x.direction })));
  }
  const diagnoses: Record<string, Diagnosis> = {};
  for (const x of v1Frozen) {
    const d = scans[x.f.ipo_timeframe].diagnoses.get(`${x.K}|${x.k}|${x.direction}`);
    if (d) diagnoses[key(x.f.ipo_timeframe, x.f.ipo_origin_time, x.f.entry_time)] = d;
  }

  // ── 3. data audit ────────────────────────────────────────────────────────
  const san = sanitizeM1(mb);
  const fx = spec.inst !== "BTC/USD";
  const corruptM1 = mb.map((b, i) => ({ b, i })).filter(({ i }) => san.clamped[i] === 1).map(({ b, i }) => ({
    datetime: b.datetime, open: b.open, high: b.high, low: b.low, close: b.close,
    repaired_open: san.bars[i].open, repaired_close: san.bars[i].close }));
  const spikeM1 = mb.filter((_, i) => san.glitch[i] === 1).map((b) => ({ ...b }));
  const t1m = mb.map((b) => Date.parse(b.datetime));
  const gaps: Array<{ from: string; to: string; minutes: number }> = [];
  for (let i = 1; i < t1m.length; i++) if (!gapOk(t1m[i - 1], t1m[i], fx, [])) gaps.push({ from: mb[i - 1].datetime, to: mb[i].datetime, minutes: (t1m[i] - t1m[i - 1]) / 60_000 });
  const corruptHtf: Record<string, Array<Candle & { idx: number }>> = {};
  for (const tf of ["1h", "4h"]) {
    corruptHtf[tf] = series[tf].map((b, idx) => ({ ...b, idx })).filter((b) => b.low > Math.min(b.open, b.close) + 1e-12 || b.high < Math.max(b.open, b.close) - 1e-12);
  }
  const spikeSet = new Set(spikeM1.map((b) => b.datetime));
  const corruptSet = new Set(corruptM1.map((b) => b.datetime));
  const flagsFor = (tf: string, k: number, K: number, exitIdx: number, fillMs: number, endMs: number): string[] => {
    const fl: string[] = [];
    const hb = corruptHtf[tf].filter((b) => b.idx >= k && b.idx <= Math.min(exitIdx, series[tf].length - 1));
    if (hb.length) fl.push(`HTF_OHLC_VIOLATION_IN_LIFE:${hb.map((b) => b.datetime).join("+")}`);
    let sp = 0, cr = 0;
    for (let i = 0; i < mb.length; i++) {
      const t = t1m[i];
      if (t < fillMs) continue;
      if (t > endMs) break;
      if (spikeSet.has(mb[i].datetime)) sp++;
      if (corruptSet.has(mb[i].datetime)) cr++;
    }
    // the fill bar's minutes before the fill matter for the fill itself
    for (const m of minutesFor[tf](K)) { if (spikeSet.has(m.datetime)) sp++; if (corruptSet.has(m.datetime)) cr++; }
    if (sp) fl.push(`M1_SPIKE_IN_WINDOW:${sp}`);
    if (cr) fl.push(`M1_OPEN_CLOSE_CORRUPT_IN_WINDOW:${cr}`);
    return fl;
  };

  // ── V2 slot simulations ──────────────────────────────────────────────────
  const result: Record<string, unknown> = {};
  for (const sel of ["PRODUCTION_BAR", "TOUCH_ORDER"] as Selection[]) {
    const streams = (["1h", "4h"] as const).map((tf) => ({ tf, bars: series[tf], barMs: BAR_MS[tf], pes: scans[tf].pes[sel], minutesFor: minutesFor[tf] }));
    const { trades, blocked } = simulateSlot(streams, inst.costPerSide);
    const rows: V2Trade[] = trades.map((t: SimTrade) => {
      const pe = t.pe as ScanPE, bars = series[pe.tf], ipo = bars[pe.cand.k];
      const g = ipoGeometry(ipo, pe.cand.direction);
      const exitIdx = Math.min(t.res.exitIdx, bars.length - 1);
      const endMs = Number.isFinite(t.res.exitMs) ? t.res.exitMs : decEnd;
      return {
        selection: sel, window, instrument: spec.inst, tf: pe.tf, direction: pe.cand.direction,
        inScope: Date.parse(pe.barTime) >= decStart,
        ipo_origin_time: ipo.datetime, ipo_open: ipo.open, ipo_high: ipo.high, ipo_low: ipo.low, ipo_close: ipo.close,
        zone_low: g.zoneLow, zone_high: g.zoneHigh, entry: pe.lv.entry, s2: pe.lv.stop, target: pe.lv.target, risk: pe.lv.risk,
        touch_bar_time: pe.barTime, K: pe.K, k: pe.cand.k, fill_minute: pe.fillMinute, fill_note: pe.fillNote,
        outcome: t.res.outcome, alt_branch: t.res.altBranch, open_branch: t.res.openBranch, method: t.res.method,
        target_minute: t.res.targetMinute, s2_bar_time: t.res.s2BarTime,
        exit_bar_time: t.res.exitIdx < bars.length ? bars[t.res.exitIdx].datetime : null, exit_price: t.res.exitPrice,
        gross_r: t.res.grossR, cost_r: t.costR, net_r: t.netR, same_bar_s2: t.res.sameBarS2, n_eligible: pe.nEligible,
        production_view: pe.productionView, data_flags: flagsFor(pe.tf, pe.cand.k, pe.K, exitIdx, pe.fillMs, endMs),
        fill_ms: pe.fillMs, exit_ms: Number.isFinite(t.res.exitMs) ? t.res.exitMs : null,
        // geometry parity: the candidate's levels must be production ipoGeometry's
        ...(Math.abs(g.zoneLow - pe.cand.zoneLow) > 1e-12 || Math.abs(g.zoneHigh - pe.cand.zoneHigh) > 1e-12 ? { geometry_mismatch: true } : {}),
      };
    });
    result[sel] = {
      trades: rows,
      blocked: blocked.map((b) => ({ tf: b.pe.tf, K: b.pe.K, k: b.pe.cand.k, direction: b.pe.cand.direction,
        bar: b.pe.barTime, ipo: series[b.pe.tf][b.pe.cand.k].datetime, reason: b.reason, fillMs: b.pe.fillMs })),
      peCount: { "1h": scans["1h"].pes[sel].length, "4h": scans["4h"].pes[sel].length },
    };
  }

  // V1 trades: data flags too (for "does any result depend on repaired data")
  const v1Flags: Record<string, string[]> = {};
  for (const x of v1Frozen) {
    const f = x.f;
    const exitIdx = series[f.ipo_timeframe].findIndex((b) => b.datetime === (f.s2_invalidation_time || f.exit_time)) ;
    v1Flags[key(f.ipo_timeframe, f.ipo_origin_time, f.entry_time)] = flagsFor(f.ipo_timeframe, x.k, x.K,
      exitIdx >= 0 ? exitIdx : x.K, Date.parse(f.m1_entry_time), Date.parse(f.exit_time) + BAR_MS[f.ipo_timeframe]);
  }

  await Deno.mkdir(OUT_DIR, { recursive: true });
  await Deno.writeTextFile(new URL(`${spec.m1}.json`, OUT_DIR), JSON.stringify({
    window, m1: spec.m1, instrument: spec.inst,
    decision_start: mb[0].datetime, decision_end: mb[mb.length - 1].datetime, m1_bars: mb.length, m1_pages: wf.pages.length,
    bars: { "1h": series["1h"].length, "4h": series["4h"].length },
    parity: { frozen: frozen.length, replica_clean: v1Clean.size, matched: parityMatch, outcome_identical: parityOutcome,
      missing: parityMissing, extra: parityExtra },
    diagnoses, v1Flags,
    data: { corruptM1, spikeM1, gaps, corruptHtf: Object.fromEntries(Object.entries(corruptHtf).map(([tf, v]) => [tf, v.map(({ idx: _i, ...b }) => b)])) },
    ...result,
  }));
  console.log(`${window}: span ${mb[0].datetime} -> ${mb[mb.length - 1].datetime} | V1 parity ${parityMatch}/${frozen.length} matched, ${parityOutcome} identical, ${parityExtra.length} extra | ` +
    `V2 ${(result.PRODUCTION_BAR as any).trades.length} / strict ${(result.TOUCH_ORDER as any).trades.length} trades | ${((performance.now() - t0) / 1000).toFixed(0)}s`);
}
