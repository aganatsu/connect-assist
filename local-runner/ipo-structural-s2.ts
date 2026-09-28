/**
 * IPO_STRUCTURAL_S2_V1 — causal profitability experiment. Research only.
 *
 * ONE HYPOTHESIS: does placing S2 at the structural swing that supports the
 * IPO beat the IPO candle's own far edge?
 *
 * Nothing deployed. Entry logic untouched. Close-confirmed invalidation kept —
 * this moves the LEVEL, it does not turn S2 into a wick stop. Per §6 the 2R
 * target is recomputed from the new entry-to-S2 distance, so the whole risk
 * geometry moves together rather than the old target being pinned.
 *
 * ── STRUCTURE, NOT A LOOKBACK EXTREME (§3) ─────────────────────────────────
 * Uses the repository's own dual-lookback swing engine, not "lowest low in N
 * bars". `analyzeMarketStructure` detects INTERNAL pivots at lookback 3 with a
 * 0.2 ATR filter and EXTERNAL pivots at lookback 7 with 0.5, tagging each
 * swing's significance. The support is the NEAREST confirmed swing of the
 * correct type at or before the IPO origin — bullish IPOs take the swing LOW
 * beneath the origin, bearish the swing HIGH above it.
 *
 * ── CAUSALITY (§4) ─────────────────────────────────────────────────────────
 * A pivot at index i needs `lookback` bars on BOTH sides, so it is not
 * knowable until bar i + lookback. That confirmation index is computed
 * explicitly and compared against the bar on which the IPO became tradable.
 * A swing confirmed later is unusable no matter how obvious it looks in
 * hindsight, and those IPOs are reported as STRUCTURAL_S2_UNAVAILABLE_AT_ENTRY
 * rather than quietly falling back to the frozen level.
 *
 * Structure is recomputed on the prefix strictly before the touch bar, so
 * confirmation cannot borrow from the future in any other way either.
 */

import { replayIncremental } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import type { EngineConfig, LiveTrade } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import { analyzeMarketStructure, type Candle, type SwingPoint } from "../supabase/functions/_shared/smcAnalysis.ts";
import { ipoGeometry } from "../supabase/functions/_shared/ipoZones.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";

const TF_DIR = "/tmp/ipo-tf-data";
const M1_DIR = "/tmp/ipo-m1-data";
const OUT = "/tmp/ipo-structural-s2";
const WARMUP = 400;
const BAR_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000 };
const INTERNAL_LB = 3, EXTERNAL_LB = 7;

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

export interface Support {
  price: number; swingIndex: number; confirmedIndex: number;
  significance: "internal" | "external"; type: "high" | "low";
}

/**
 * The structural swing supporting an IPO, as knowable from `barsBefore`.
 *
 * Nearest qualifying swing at or before the origin. Null when none is
 * causally confirmed in time — never a silent fallback to the frozen level.
 */
export function structuralSupport(
  barsBefore: Candle[], ipoIndex: number, direction: "demand" | "supply", knownByIndex: number,
): Support | null {
  if (barsBefore.length < EXTERNAL_LB * 2 + 2) return null;
  const st = analyzeMarketStructure(barsBefore);
  const want: "high" | "low" = direction === "demand" ? "low" : "high";
  let best: Support | null = null;
  for (const s of (st.swingPoints ?? []) as SwingPoint[]) {
    if (s.type !== want) continue;
    if (s.index > ipoIndex) continue;                     // must precede the origin
    const lb = s.significance === "external" ? EXTERNAL_LB : INTERNAL_LB;
    const confirmed = s.index + lb;
    if (confirmed > knownByIndex) continue;               // not yet confirmed — §4
    // Nearest to the origin wins.
    if (!best || s.index > best.swingIndex) {
      best = { price: s.price, swingIndex: s.index, confirmedIndex: confirmed,
        significance: (s.significance ?? "internal"), type: s.type };
    }
  }
  return best;
}

// ── 1m resolver, identical to the accepted baseline ────────────────────────
type Ordering = "HTF_UNAMBIGUOUS" | "1M_RESOLVED" | "TICK_RESOLVED" | "EXECUTION_AMBIGUOUS";
function resolve(t: LiveTrade, bars: Candle[], m1: Candle[], barMs: number) {
  const long = t.direction === "demand";
  const nil = { m1Entry: "", m1Target: "", s2Time: "", exitTime: "", exitPrice: "" as const, grossR: "" as const };
  if (!m1.length) return { ordering: "EXECUTION_AMBIGUOUS" as Ordering, detail: "NO_1M_COVERAGE", reason: "UNRESOLVED", ...nil };
  const es = Date.parse(bars[t.entryIndex].datetime);
  if (es < Date.parse(m1[0].datetime) || es > Date.parse(m1[m1.length-1].datetime))
    return { ordering: "EXECUTION_AMBIGUOUS" as Ordering, detail: "1M_GAP_AT_ENTRY_BAR", reason: "UNRESOLVED", ...nil };
  let ei = -1;
  for (let i = 0; i < m1.length; i++) {
    const ts = Date.parse(m1[i].datetime);
    if (ts < es) continue; if (ts >= es + barMs) break;
    if (long ? m1[i].low <= t.entry : m1[i].high >= t.entry) { ei = i; break; }
  }
  if (ei < 0) return { ordering: "EXECUTION_AMBIGUOUS" as Ordering, detail: "ENTRY_NOT_CONFIRMED_IN_1M", reason: "UNRESOLVED", ...nil };
  const m1Entry = m1[ei].datetime;
  let s2Bar = -1;
  for (let k = t.entryIndex; k < bars.length; k++) {
    const c = bars[k];
    if (long ? c.close < t.stop : c.close > t.stop) { s2Bar = k; break; }
  }
  const s2Instant = s2Bar >= 0 ? Date.parse(bars[s2Bar].datetime) + barMs : Infinity;
  let tg = -1;
  for (let i = ei; i < m1.length; i++) {
    if (Date.parse(m1[i].datetime) > s2Instant) break;
    if (long ? m1[i].high >= t.target : m1[i].low <= t.target) { tg = i; break; }
  }
  if (tg < 0) {
    if (s2Bar < 0) return { ordering: "EXECUTION_AMBIGUOUS" as Ordering, detail: "NO_EXIT_WITHIN_COVERAGE", reason: "OPEN_AT_DATA_END", m1Entry, m1Target: "", s2Time: "", exitTime: "", exitPrice: "" as const, grossR: "" as const };
    const px = bars[s2Bar].close;
    return { ordering: "HTF_UNAMBIGUOUS" as Ordering, detail: "", reason: "S2_CLOSE_INVALIDATION",
      m1Entry, m1Target: "", s2Time: bars[s2Bar].datetime, exitTime: bars[s2Bar].datetime,
      exitPrice: px, grossR: (long ? px - t.entry : t.entry - px) / t.risk };
  }
  if (s2Bar >= 0 && Date.parse(m1[tg].datetime) + 60_000 > s2Instant) {
    return { ordering: "EXECUTION_AMBIGUOUS" as Ordering, detail: "TARGET_IN_S2_CLOSING_MINUTE", reason: "UNRESOLVED",
      m1Entry, m1Target: m1[tg].datetime, s2Time: bars[s2Bar].datetime, exitTime: "", exitPrice: "" as const, grossR: "" as const };
  }
  return { ordering: (s2Bar >= 0 ? "1M_RESOLVED" : "HTF_UNAMBIGUOUS") as Ordering, detail: "", reason: "TARGET",
    m1Entry, m1Target: m1[tg].datetime, s2Time: s2Bar >= 0 ? bars[s2Bar].datetime : "",
    exitTime: m1[tg].datetime, exitPrice: t.target, grossR: Math.abs(t.target - t.entry) / t.risk };
}

export interface Row {
  arm: string; key: string; instrument: string; timeframe: string; window: string;
  direction: string; ipo_origin_time: string;
  entry_time: string; entry_price: number;
  candle_s2: number; structural_s2: number | "";
  structural_swing_time: string; structural_confirmed_time: string;
  structural_significance: string; distance_ratio: number | "";
  s2_used: number; target_price: number; risk_price: number;
  exit_time: string; exit_price: number | ""; exit_reason: string;
  gross_r: number | ""; cost_r: number; net_r: number | "";
  ordering_resolution: Ordering; ambiguity_detail: string;
  excluded_from_stats: boolean;
}

const A: Row[] = [], B: Row[] = [];
const unavailable: Record<string, unknown>[] = [];
const m1cache = new Map<string, Candle[]>();

for (const spec of SPECS) {
  const inst = IPO_INSTRUMENTS.find((i) => i.instrument === spec.inst)!;
  if (!m1cache.has(spec.m1)) {
    try { m1cache.set(spec.m1, JSON.parse(await Deno.readTextFile(`${M1_DIR}/${spec.m1}_1min.json`))); }
    catch { m1cache.set(spec.m1, []); }
  }
  const mb = m1cache.get(spec.m1)!;
  if (!mb.length) continue;
  const decStart = Date.parse(mb[0].datetime), decEnd = Date.parse(mb[mb.length-1].datetime);

  for (const tf of ["1h", "4h"] as const) {
    const full = JSON.parse(await Deno.readTextFile(`${TF_DIR}/${spec.inst.replace("/","")}_${spec.end}_${tf}.json`)) as Candle[];
    const si = Math.max(0, full.findIndex((c) => Date.parse(c.datetime) >= decStart) - WARMUP);
    const bars = full.slice(si).filter((c) => Date.parse(c.datetime) <= decEnd);
    const cfg: EngineConfig = { instrument: inst.instrument, timeframe: tf,
      highVolOnly: inst.highVolOnly, costPerSide: inst.costPerSide };

    // Support lookup is memoised per (ipoIndex, touchIndex): the engine may ask
    // repeatedly and analyzeMarketStructure is the expensive call here.
    const supCache = new Map<string, Support | null>();
    const sup = (barsBefore: Candle[], ipoIndex: number, dir: "demand" | "supply", known: number) => {
      const k = `${ipoIndex}|${known}|${dir}`;
      if (!supCache.has(k)) supCache.set(k, structuralSupport(barsBefore, ipoIndex, dir, known));
      return supCache.get(k)!;
    };

    const mk = (arm: string, t: LiveTrade, s: Support | null): Row => {
      const r = resolve(t, bars, mb, BAR_MS[tf]);
      const cost = (2 * inst.costPerSide(t.entry)) / t.risk;
      const g = ipoGeometry(bars[t.ipoIndex], t.direction);
      const candleS2 = t.direction === "demand" ? g.extent : g.extent;
      return {
        arm, key: `${spec.inst}|${spec.end}|${tf}|${t.ipoIndex}@${t.entryIndex}`,
        instrument: t.instrument, timeframe: tf, window: `${spec.inst}_${spec.end}`,
        direction: t.direction, ipo_origin_time: bars[t.ipoIndex].datetime,
        entry_time: bars[t.entryIndex].datetime, entry_price: t.entry,
        candle_s2: candleS2, structural_s2: s ? s.price : "",
        structural_swing_time: s ? bars[s.swingIndex].datetime : "",
        structural_confirmed_time: s && bars[s.confirmedIndex] ? bars[s.confirmedIndex].datetime : "",
        structural_significance: s ? s.significance : "",
        distance_ratio: s ? Math.abs(t.entry - s.price) / Math.abs(t.entry - candleS2) : "",
        s2_used: t.stop, target_price: t.target, risk_price: t.risk,
        exit_time: r.exitTime, exit_price: r.exitPrice, exit_reason: r.reason,
        gross_r: r.grossR, cost_r: cost, net_r: r.grossR === "" ? "" : (r.grossR as number) - cost,
        ordering_resolution: r.ordering, ambiguity_detail: r.detail,
        excluded_from_stats: r.ordering === "EXECUTION_AMBIGUOUS",
      };
    };
    const inScope = (t: LiveTrade) => Date.parse(bars[t.entryIndex].datetime) >= decStart;

    // ARM A — frozen.
    for (const t of replayIncremental(bars, cfg).trades) {
      if (!inScope(t)) continue;
      const s = sup(bars.slice(0, t.entryIndex), t.ipoIndex, t.direction, t.entryIndex - 1);
      A.push(mk("CONTROL", t, s));
      if (!s) unavailable.push({ window: `${spec.inst}_${spec.end}`, tf, instrument: spec.inst,
        ipo_origin_time: bars[t.ipoIndex].datetime, reason: "STRUCTURAL_S2_UNAVAILABLE_AT_ENTRY" });
    }

    // ARM B — structural S2. Falls back to the frozen level ONLY when no
    // structural support is causally confirmed; those rows are tracked so the
    // comparison can be restricted to genuinely structural trades.
    const eb = replayIncremental(bars, {
      ...cfg,
      stopOverride: ({ barsBefore, ipoIndex, direction, touchIndex }) => {
        const s = sup(barsBefore, ipoIndex, direction, touchIndex - 1);
        return s ? s.price : null;
      },
    });
    for (const t of eb.trades) {
      if (!inScope(t)) continue;
      const s = sup(bars.slice(0, t.entryIndex), t.ipoIndex, t.direction, t.entryIndex - 1);
      B.push(mk("STRUCTURAL", t, s));
    }
    console.error(`  ${spec.inst} ${spec.end} ${tf}  A=${A.length} B=${B.length}`);
  }
}

await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/raw.json`, JSON.stringify({ A, B, unavailable }, null, 2));
console.log(`\n  A=${A.length}  B=${B.length}  unavailable=${unavailable.length}`);
console.log(`  raw -> ${OUT}/raw.json`);
