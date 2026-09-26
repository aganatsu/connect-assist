/**
 * IPO_PREENTRY_IMPULSE_V1 — causal profitability experiment. Research only.
 *
 * HYPOTHESIS: IPOs that already produced a direction-aligned, validated impulse
 * BEFORE the return/entry are better trades than the baseline population.
 *
 * Nothing deployed. IPO detection, geometry, entry, candle-edge S2,
 * close-confirmed invalidation, 2R target, one-position rule, costs and the 1m
 * resolver are all unchanged. The only thing added is an entry gate.
 *
 * ── §7 PRODUCTION IMPULSE LOGIC, REPORTED BEFORE USE ───────────────────────
 * `findImpulseLeg(candles, direction, timeframe)` runs `analyzeMarketStructure`
 * on whatever array it is handed, filters breaks to the trade's direction,
 * walks them newest-first and returns the most recent leg that
 * `validateImpulseFromBOS` accepts — i.e. whose ORIGIN HAS NOT BEEN BROKEN.
 * There is no fixed cross-timeframe relationship inside it: bot-scanner simply
 * passes whichever zone-slot array it wants analysed. Detecting on the IPO's
 * own timeframe is therefore faithful to production rather than a change.
 *
 * ── THE LOOKAHEAD THIS ENGINE IS KNOWN FOR ─────────────────────────────────
 * `isValid` is evaluated against the WHOLE array it is given, so on a full
 * series it asks "was this origin ever broken, including after the moment we
 * care about". SMC Stage 2 measured the damage: 54.9% of causal impulses had
 * their origin broken by a later close, invisible to a whole-series replay.
 *
 * This study therefore calls it ONLY on `bars.slice(0, entryIndex)` — the
 * closed bars strictly before the entry bar. Structure confirmation, break
 * detection and the origin check are then all evaluated on information that
 * existed at entry, and §5's `impulse_confirmed_time <= entry_time` holds by
 * construction rather than by assertion. It is still asserted and audited.
 *
 * ── §3 INDEPENDENT DETECTION ───────────────────────────────────────────────
 * IPO detection is untouched; the impulse is found separately and the two are
 * associated afterwards. No IPO is created or moved to make an impulse fit.
 */

import { replayIncremental } from "../supabase/functions/_shared/ipoIncrementalEngine.ts";
import type { EngineConfig, LiveTrade } from "../supabase/functions/_shared/ipoLiveEngine.ts";
import { findImpulseLeg, type ImpulseLeg } from "../supabase/functions/_shared/impulseZoneEngine.ts";
import { ipoGeometry } from "../supabase/functions/_shared/ipoZones.ts";
import { IPO_INSTRUMENTS } from "../supabase/functions/_shared/ipoInstruments.ts";
import type { Candle } from "../supabase/functions/_shared/smcAnalysis.ts";

const TF_DIR = "/tmp/ipo-tf-data";
const M1_DIR = "/tmp/ipo-m1-data";
const OUT = "/tmp/ipo-preentry-impulse";
const WARMUP = 400;
const BAR_MS: Record<string, number> = { "1h": 3_600_000, "4h": 14_400_000 };

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

export type Assoc =
  | "IMPULSE_ORIGIN_INSIDE_IPO" | "IMPULSE_OVERLAPS_IPO"
  | "IMPULSE_IMMEDIATELY_AFTER_IPO" | "NO_ASSOCIATED_IMPULSE";

export interface Found { leg: ImpulseLeg; assoc: Assoc }

/**
 * A direction-aligned validated impulse associated with this IPO, knowable from
 * `barsBefore`. Null when none qualifies.
 *
 * §4: direction must match, the leg must end after the IPO origin, and it must
 * begin at, overlap, or emerge from the origin region. Distances are not tuned
 * — association is by index relationship only.
 */
export function preEntryImpulse(
  barsBefore: Candle[], ipoIndex: number, direction: "demand" | "supply",
): Found | null {
  if (barsBefore.length < 25) return null;
  const want = direction === "demand" ? "bullish" : "bearish";
  const leg = findImpulseLeg(barsBefore, want);
  if (!leg || !leg.isValid) return null;
  // The leg must have completed AFTER the IPO origin — an impulse that ended
  // before the IPO candle existed did not come out of it.
  if (leg.endIndex <= ipoIndex) return null;
  const assoc: Assoc =
    leg.startIndex === ipoIndex ? "IMPULSE_ORIGIN_INSIDE_IPO"
    : leg.startIndex < ipoIndex && leg.endIndex >= ipoIndex ? "IMPULSE_OVERLAPS_IPO"
    : leg.startIndex > ipoIndex ? "IMPULSE_IMMEDIATELY_AFTER_IPO"
    : "NO_ASSOCIATED_IMPULSE";
  if (assoc === "NO_ASSOCIATED_IMPULSE") return null;
  return { leg, assoc };
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
    if (s2Bar < 0) return { ordering: "EXECUTION_AMBIGUOUS" as Ordering, detail: "NO_EXIT_WITHIN_COVERAGE", reason: "OPEN_AT_DATA_END", m1Entry: m1[ei].datetime, m1Target: "", s2Time: "", exitTime: "", exitPrice: "" as const, grossR: "" as const };
    const px = bars[s2Bar].close;
    return { ordering: "HTF_UNAMBIGUOUS" as Ordering, detail: "", reason: "S2_CLOSE_INVALIDATION",
      m1Entry: m1[ei].datetime, m1Target: "", s2Time: bars[s2Bar].datetime, exitTime: bars[s2Bar].datetime,
      exitPrice: px, grossR: (long ? px - t.entry : t.entry - px) / t.risk };
  }
  if (s2Bar >= 0 && Date.parse(m1[tg].datetime) + 60_000 > s2Instant)
    return { ordering: "EXECUTION_AMBIGUOUS" as Ordering, detail: "TARGET_IN_S2_CLOSING_MINUTE", reason: "UNRESOLVED",
      m1Entry: m1[ei].datetime, m1Target: m1[tg].datetime, s2Time: bars[s2Bar].datetime, exitTime: "", exitPrice: "" as const, grossR: "" as const };
  return { ordering: (s2Bar >= 0 ? "1M_RESOLVED" : "HTF_UNAMBIGUOUS") as Ordering, detail: "", reason: "TARGET",
    m1Entry: m1[ei].datetime, m1Target: m1[tg].datetime, s2Time: s2Bar >= 0 ? bars[s2Bar].datetime : "",
    exitTime: m1[tg].datetime, exitPrice: t.target, grossR: Math.abs(t.target - t.entry) / t.risk };
}

export interface Row {
  arm: string; key: string; instrument: string; timeframe: string; window: string;
  direction: string; ipo_origin_time: string; zone_high: number; zone_low: number;
  entry_time: string; entry_price: number; s2_price: number; target_price: number;
  has_preentry_impulse: boolean; association: string;
  impulse_direction: string; impulse_start_time: string; impulse_end_time: string;
  impulse_confirmed_time: string; impulse_span_bars: number | "";
  impulse_bos_price: number | ""; impulse_origin_broken: boolean | "";
  impulse_displacement_atr: number | ""; impulse_body_dominance: number | "";
  impulse_efficiency: number | "";
  bars_origin_to_impulse: number | ""; bars_impulse_to_entry: number | "";
  confirmed_before_entry: boolean;
  exit_time: string; exit_price: number | ""; exit_reason: string;
  gross_r: number | ""; cost_r: number; net_r: number | "";
  ordering_resolution: Ordering; ambiguity_detail: string; excluded_from_stats: boolean;
}

const A: Row[] = [], B: Row[] = [], afterEntry: Row[] = [];
const funnel: Record<string, Record<string, number>> = {};
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
    const f = funnel[`${spec.inst}|${tf}`] ??= {
      controlEntries: 0, withImpulse: 0, withoutImpulse: 0, afterEntryOnly: 0,
      impulseArmEntries: 0, gateRefusals: 0,
    };

    const cache = new Map<string, Found | null>();
    const imp = (upTo: number, ipoIndex: number, dir: "demand" | "supply") => {
      const k = `${upTo}|${ipoIndex}|${dir}`;
      if (!cache.has(k)) cache.set(k, preEntryImpulse(bars.slice(0, upTo), ipoIndex, dir));
      return cache.get(k)!;
    };

    const mk = (arm: string, t: LiveTrade, fo: Found | null, confirmedBefore: boolean): Row => {
      const r = resolve(t, bars, mb, BAR_MS[tf]);
      const cost = (2 * inst.costPerSide(t.entry)) / t.risk;
      const g = ipoGeometry(bars[t.ipoIndex], t.direction);
      const L = fo?.leg;
      return {
        arm, key: `${spec.inst}|${spec.end}|${tf}|${t.ipoIndex}@${t.entryIndex}`,
        instrument: t.instrument, timeframe: tf, window: `${spec.inst}_${spec.end}`,
        direction: t.direction, ipo_origin_time: bars[t.ipoIndex].datetime,
        zone_high: g.zoneHigh, zone_low: g.zoneLow,
        entry_time: bars[t.entryIndex].datetime, entry_price: t.entry,
        s2_price: t.stop, target_price: t.target,
        has_preentry_impulse: !!fo, association: fo ? fo.assoc : "NO_ASSOCIATED_IMPULSE",
        impulse_direction: L?.direction ?? "",
        impulse_start_time: L ? bars[L.startIndex]?.datetime ?? "" : "",
        impulse_end_time: L ? bars[L.endIndex]?.datetime ?? "" : "",
        // The BOS candle's close is what confirms the leg, and the prefix that
        // produced it ended before the entry bar — so this is <= entry by
        // construction. Asserted in the audit, not merely assumed.
        impulse_confirmed_time: L ? bars[L.endIndex]?.datetime ?? "" : "",
        impulse_span_bars: L?.spanBars ?? "",
        impulse_bos_price: L?.bosPrice ?? "",
        impulse_origin_broken: L ? !!L.originBroken : "",
        impulse_displacement_atr: (L?.displacement as any)?.atrMultiple ?? "",
        impulse_body_dominance: (L?.displacement as any)?.bodyRatio ?? "",
        impulse_efficiency: (L?.displacement as any)?.efficiency ?? "",
        bars_origin_to_impulse: L ? L.endIndex - t.ipoIndex : "",
        bars_impulse_to_entry: L ? t.entryIndex - L.endIndex : "",
        confirmed_before_entry: confirmedBefore,
        exit_time: r.exitTime, exit_price: r.exitPrice, exit_reason: r.reason,
        gross_r: r.grossR, cost_r: cost, net_r: r.grossR === "" ? "" : (r.grossR as number) - cost,
        ordering_resolution: r.ordering, ambiguity_detail: r.detail,
        excluded_from_stats: r.ordering === "EXECUTION_AMBIGUOUS",
      };
    };
    const inScope = (t: LiveTrade) => Date.parse(bars[t.entryIndex].datetime) >= decStart;

    // ── ARM A, control. Annotate each trade with its causal impulse state. ──
    for (const t of replayIncremental(bars, cfg).trades) {
      if (!inScope(t)) continue;
      f.controlEntries++;
      const before = imp(t.entryIndex, t.ipoIndex, t.direction);
      A.push(mk("CONTROL", t, before, !!before));
      if (before) { f.withImpulse++; continue; }
      f.withoutImpulse++;
      // Did an impulse appear LATER? Those are the §18 exclusion proof cases:
      // real impulses that a lookahead study would have wrongly credited.
      const later = imp(Math.min(bars.length, t.entryIndex + 24), t.ipoIndex, t.direction);
      if (later) { f.afterEntryOnly++; afterEntry.push(mk("IMPULSE_AFTER_ENTRY", t, later, false)); }
    }

    // ── ARM B, a real replay with the gate. Not a filter of ARM A: refusing an
    // entry frees the one-position slot, so later impulse entries can appear. ──
    const eb = replayIncremental(bars, {
      ...cfg,
      entryGate: ({ barsBefore, ipoIndex, direction }) =>
        preEntryImpulse(barsBefore, ipoIndex, direction) !== null,
    });
    f.gateRefusals += eb.refusals.filter((r) => r.reason === "ENTRY_GATE_REFUSED").length;
    for (const t of eb.trades) {
      if (!inScope(t)) continue;
      f.impulseArmEntries++;
      B.push(mk("IMPULSE_ONLY", t, imp(t.entryIndex, t.ipoIndex, t.direction), true));
    }
    console.error(`  ${spec.inst} ${spec.end} ${tf}  A=${A.length} B=${B.length} after=${afterEntry.length}`);
  }
}

await Deno.mkdir(OUT, { recursive: true });
await Deno.writeTextFile(`${OUT}/raw.json`, JSON.stringify({ A, B, afterEntry, funnel }, null, 2));
console.log(`\n  A=${A.length}  B=${B.length}  afterEntryOnly=${afterEntry.length}`);
