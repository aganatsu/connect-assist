/**
 * IPO_BASELINE_1H_4H_CAUSAL_V1 — profitability study, research only.
 *
 * Nothing deployed. Production IPO strategy untouched. No rule changed, no
 * parameter tuned. BOS not required; failed-retest logic absent; no volatility
 * filter. The frozen engine decides; this file only chooses which bars it sees
 * and then resolves execution against 1m.
 *
 * ── THE ORDERING PROBLEM THIS EXISTS TO SOLVE ──────────────────────────────
 * The two IPO exits are not the same KIND of event:
 *
 *   TARGET is an INTRABAR level touch — it can happen at any moment in a bar.
 *   S2 is a CLOSE-CONFIRMED invalidation — it happens at the bar's close,
 *       which is by definition the bar's LAST event.
 *
 * So when one strategy bar both reaches the target and closes beyond the stop,
 * the target came first unless the touch happened in the closing minute. The
 * frozen `manageOpen` tests `closedBeyond` BEFORE `hitTarget`, so it resolves
 * those the other way — by code precedence, which §6 forbids as evidence.
 *
 * This study therefore resolves every exit against 1m and reports how often the
 * frozen precedence disagrees with the actual sequence. The frozen engine is
 * still what SELECTS the trades; only the exit ordering is re-derived.
 *
 * Ambiguity is admitted rather than assumed: if the target is touched inside
 * the very 1m bar that closes the strategy bar, 1m cannot say whether it
 * preceded the close, and the trade is EXECUTION_AMBIGUOUS.
 *
 * ── SCOPE ──────────────────────────────────────────────────────────────────
 * The decision span per instrument-window is the 1m-covered span. Bars before
 * it are warm-up: the engine runs through them so sequencing and the
 * one-position rule are continuous, but trades entered there are out of scope
 * and dropped, since their execution cannot be resolved.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env local-runner/ipo-tf-baseline.ts
 */

import { replayIncremental } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import type { EngineConfig, LiveTrade } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import { IncrementalEngine } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import { ipoGeometry } from "../supabase/functions/_shared/ipoZones.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

const TF_DIR = "/tmp/ipo-tf-data";
const M1_DIR = "/tmp/ipo-m1-data";
const OUT = "/tmp/ipo-tf-baseline";

/** Warm-up bars fed before the decision span. Above the 250-bar vol floor. */
const WARMUP = 400;
const BAR_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000 };

/** Instrument-window ends, matching the cached IPO corpus, plus its 1m file. */
const SPECS = [
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

type Ordering = "HTF_UNAMBIGUOUS" | "1M_RESOLVED" | "TICK_RESOLVED" | "EXECUTION_AMBIGUOUS";

export interface Row {
  arm: string; instrument: string; ipo_timeframe: string; window: string;
  direction: string;
  ipo_origin_time: string; ipo_open: number; ipo_high: number; ipo_low: number; ipo_close: number;
  zone_high: number; zone_low: number; midpoint: number;
  touch_time: string; entry_time: string; entry_price: number;
  s2_price: number; target_price: number; risk_price: number;
  m1_entry_time: string; m1_target_time: string; s2_invalidation_time: string;
  exit_time: string; exit_price: number | ""; exit_reason: string;
  gross_r: number | ""; cost_r: number; net_r: number | "";
  ordering_resolution: Ordering; ambiguity_detail: string;
  frozen_engine_reason: string; precedence_disagreement: boolean;
  mae_r: number; mfe_r: number;
  bars_to_exit: number | ""; holding_minutes: number | "";
  blocked_by: string;
  excluded_from_stats: boolean;
}

const m1cache = new Map<string, Candle[]>();
async function m1(name: string): Promise<Candle[]> {
  if (!m1cache.has(name)) {
    try { m1cache.set(name, JSON.parse(await Deno.readTextFile(`${M1_DIR}/${name}_1min.json`))); }
    catch { m1cache.set(name, []); }
  }
  return m1cache.get(name)!;
}

/**
 * Resolve one frozen-engine trade against 1m.
 *
 * Returns the sequence actually supported by the data, or an ambiguity when it
 * is not supported. Never picks the favourable branch.
 */
function resolve(
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

  // 1m entry: first minute inside the touch bar that reaches the entry level.
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

  // S2: first strategy bar at or after entry whose CLOSE is beyond the stop.
  // That event occurs at the bar's close instant, its last moment.
  let s2Bar = -1;
  for (let k = t.entryIndex; k < bars.length; k++) {
    const c = bars[k];
    if (long ? c.close < t.stop : c.close > t.stop) { s2Bar = k; break; }
  }
  const s2Instant = s2Bar >= 0 ? Date.parse(bars[s2Bar].datetime) + barMs : Infinity;

  // TARGET: first minute at or after the 1m entry that reaches the target.
  let tgtIdx = -1;
  for (let i = ei; i < m1bars.length; i++) {
    const ts = Date.parse(m1bars[i].datetime);
    if (ts > s2Instant) break;                       // past the S2 close, stop looking
    const b = m1bars[i];
    if (long ? b.high >= t.target : b.low <= t.target) { tgtIdx = i; break; }
  }

  if (tgtIdx < 0) {
    if (s2Bar < 0) {
      return { ordering: "EXECUTION_AMBIGUOUS", detail: "NO_EXIT_WITHIN_COVERAGE", reason: "OPEN_AT_DATA_END",
        m1Entry, m1Target: "", s2Time: "", exitTime: "", exitPrice: "", grossR: "" };
    }
    // Only S2 ever occurred: nothing to order.
    const px = bars[s2Bar].close;
    const gross = (long ? px - t.entry : t.entry - px) / t.risk;
    return { ordering: "HTF_UNAMBIGUOUS", detail: "", reason: "S2_CLOSE_INVALIDATION",
      m1Entry, m1Target: "", s2Time: bars[s2Bar].datetime,
      exitTime: bars[s2Bar].datetime, exitPrice: px, grossR: gross };
  }

  const tgtMinuteEnd = Date.parse(m1bars[tgtIdx].datetime) + 60_000;
  if (s2Bar >= 0 && tgtMinuteEnd > s2Instant) {
    // The target was touched inside the very minute that closes the S2 bar.
    // 1m cannot say whether it preceded the close. No tick source exists, so
    // this stays unresolved rather than being guessed.
    return { ordering: "EXECUTION_AMBIGUOUS", detail: "TARGET_IN_S2_CLOSING_MINUTE", reason: "UNRESOLVED",
      m1Entry, m1Target: m1bars[tgtIdx].datetime, s2Time: bars[s2Bar].datetime,
      exitTime: "", exitPrice: "", grossR: "" };
  }

  // Target strictly precedes the S2 close (or there is no S2 at all).
  return {
    ordering: s2Bar >= 0 ? "1M_RESOLVED" : "HTF_UNAMBIGUOUS",
    detail: "", reason: "TARGET",
    m1Entry, m1Target: m1bars[tgtIdx].datetime,
    s2Time: s2Bar >= 0 ? bars[s2Bar].datetime : "",
    exitTime: m1bars[tgtIdx].datetime, exitPrice: t.target,
    grossR: Math.abs(t.target - t.entry) / t.risk,
  };
}

function toRow(
  arm: string, tf: string, spec: typeof SPECS[number], bars: Candle[], m1bars: Candle[],
  t: LiveTrade, costPerSide: (p: number) => number, blockedBy = "",
): Row {
  const g = ipoGeometry(bars[t.ipoIndex], t.direction);
  const r = resolve(t, bars, m1bars, BAR_MS[tf]);
  const costR = (2 * costPerSide(t.entry)) / t.risk;
  const net = r.grossR === "" ? "" : (r.grossR as number) - costR;
  // What the frozen engine itself concluded, for the disagreement count.
  let frozen = "OPEN";
  if (t.exitIndex !== null) {
    const c = bars[t.exitIndex];
    frozen = (t.direction === "demand" ? c.close < t.stop : c.close > t.stop)
      ? "S2_CLOSE_INVALIDATION" : "TARGET";
  }
  return {
    arm, instrument: t.instrument, ipo_timeframe: tf, window: `${spec.inst}_${spec.end}`,
    direction: t.direction,
    ipo_origin_time: bars[t.ipoIndex].datetime,
    ipo_open: bars[t.ipoIndex].open, ipo_high: bars[t.ipoIndex].high,
    ipo_low: bars[t.ipoIndex].low, ipo_close: bars[t.ipoIndex].close,
    zone_high: g.zoneHigh, zone_low: g.zoneLow, midpoint: g.distal,
    touch_time: bars[t.entryIndex].datetime, entry_time: bars[t.entryIndex].datetime,
    entry_price: t.entry, s2_price: t.stop, target_price: t.target, risk_price: t.risk,
    m1_entry_time: r.m1Entry, m1_target_time: r.m1Target, s2_invalidation_time: r.s2Time,
    exit_time: r.exitTime, exit_price: r.exitPrice, exit_reason: r.reason,
    gross_r: r.grossR, cost_r: costR, net_r: net,
    ordering_resolution: r.ordering, ambiguity_detail: r.detail,
    frozen_engine_reason: frozen,
    precedence_disagreement: frozen !== "OPEN" && r.reason !== "UNRESOLVED" && frozen !== r.reason,
    mae_r: t.mae, mfe_r: t.mfe,
    bars_to_exit: t.exitIndex !== null ? t.exitIndex - t.entryIndex : "",
    holding_minutes: r.exitTime && r.m1Entry
      ? (Date.parse(r.exitTime) - Date.parse(r.m1Entry)) / 60_000 : "",
    blocked_by: blockedBy,
    excluded_from_stats: r.ordering === "EXECUTION_AMBIGUOUS",
  };
}

// ── run ─────────────────────────────────────────────────────────────────────

const rowsA: Row[] = [], rowsB: Row[] = [], rowsC: Row[] = [];
const funnel: Record<string, Record<string, number>> = {};
const coverage: Record<string, unknown>[] = [];

for (const spec of SPECS) {
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === spec.inst)!;
  const mb = await m1(spec.m1);
  if (!mb.length) { console.error(`  no 1m for ${spec.m1}`); continue; }
  const decStart = Date.parse(mb[0].datetime), decEnd = Date.parse(mb[mb.length - 1].datetime);

  const series: Record<string, Candle[]> = {};
  for (const tf of ["1h", "4h"]) {
    const file = `${TF_DIR}/${spec.inst.replace("/", "")}_${spec.end}_${tf}.json`;
    const full = JSON.parse(await Deno.readTextFile(file)) as Candle[];
    const startIdx = Math.max(0, full.findIndex((c) => Date.parse(c.datetime) >= decStart) - WARMUP);
    series[tf] = full.slice(startIdx).filter((c) => Date.parse(c.datetime) <= decEnd);
  }
  coverage.push({
    instrument: spec.inst, window: spec.end,
    decision_start: mb[0].datetime, decision_end: mb[mb.length - 1].datetime,
    bars_1h: series["1h"].length, bars_4h: series["4h"].length, bars_1m: mb.length,
  });

  const inScope = (bars: Candle[], t: LiveTrade) => Date.parse(bars[t.entryIndex].datetime) >= decStart;

  // ARM A and ARM B — independent, each with its own instrument slot.
  for (const [arm, tf, sink] of [["IPO_1H_ONLY", "1h", rowsA], ["IPO_4H_ONLY", "4h", rowsB]] as const) {
    const cfg: EngineConfig = {
      instrument: inst.instrument, timeframe: tf,
      highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide,
    };
    const e = replayIncremental(series[tf], cfg);
    const f = funnel[`${arm}|${spec.inst}`] ??= { entries: 0, inScope: 0, blocked: 0 };
    f.entries += e.trades.length;
    f.blocked += e.refusals.filter((r) => r.reason === "POSITION_ALREADY_OPEN").length;
    for (const t of e.trades) {
      if (!inScope(series[tf], t)) continue;
      f.inScope++;
      sink.push(toRow(arm, tf, spec, series[tf], mb, t, inst.costPerSide));
    }
  }

  // ARM C — both populations competing for ONE instrument slot, interleaved in
  // causal close order. Not a post-hoc merge of two lists: each engine consults
  // the shared slot through the entryGate hook before it may open.
  const slot = { by: null as null | "1h" | "4h" };
  const eng: Record<string, IncrementalEngine> = {};
  for (const tf of ["1h", "4h"]) {
    eng[tf] = new IncrementalEngine({
      instrument: inst.instrument, timeframe: tf,
      highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide,
      entryGate: () => slot.by === null || slot.by === tf,
    });
  }
  // Merge the two streams by bar CLOSE instant. When a 1H and a 4H bar close at
  // the same moment both become known simultaneously and the order is
  // arbitrary; 1H is fed first, recorded here as a known tie-break rather than
  // hidden.
  type Ev = { tf: "1h" | "4h"; bar: Candle; close: number };
  const evs: Ev[] = [];
  for (const tf of ["1h", "4h"] as const) {
    for (const b of series[tf]) evs.push({ tf, bar: b, close: Date.parse(b.datetime) + BAR_MS[tf] });
  }
  evs.sort((a, b) => a.close - b.close || (a.tf === "1h" ? -1 : 1));
  const seen: Record<string, number> = { "1h": 0, "4h": 0 };
  const blockedC: Record<string, number> = { "1h": 0, "4h": 0 };
  for (const ev of evs) {
    const before = eng[ev.tf].openTrade;
    eng[ev.tf].feed(ev.bar);
    seen[ev.tf]++;
    const after = eng[ev.tf].openTrade;
    if (after && slot.by === null) slot.by = ev.tf;
    if (!after && before && slot.by === ev.tf) slot.by = null;
    if (!after && slot.by === ev.tf) slot.by = null;
  }
  for (const tf of ["1h", "4h"] as const) {
    blockedC[tf] = eng[tf].refusals.filter((r) => r.reason === "ENTRY_GATE_REFUSED").length;
    const f = funnel[`IPO_1H_PLUS_4H|${spec.inst}`] ??= { entries: 0, inScope: 0, blockedByOtherTf: 0 };
    f.entries += eng[tf].trades.length;
    f.blockedByOtherTf += blockedC[tf];
    for (const t of eng[tf].trades) {
      if (!inScope(series[tf], t)) continue;
      f.inScope++;
      rowsC.push(toRow("IPO_1H_PLUS_4H", tf, spec, series[tf], mb, t, inst.costPerSide,
        blockedC[tf] > 0 ? `other_tf_refusals=${blockedC[tf]}` : ""));
    }
  }
  console.error(`  ${spec.inst} ${spec.end}  1h=${series["1h"].length} 4h=${series["4h"].length} 1m=${mb.length}  A=${rowsA.length} B=${rowsB.length} C=${rowsC.length}`);
}

await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/raw.json`, JSON.stringify({ rowsA, rowsB, rowsC, funnel, coverage }, null, 2));
console.log(`\n  raw -> ${OUT}/raw.json`);
console.log(`  A=${rowsA.length}  B=${rowsB.length}  C=${rowsC.length}`);
