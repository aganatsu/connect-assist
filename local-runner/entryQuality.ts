/**
 * IPO_ENTRY_QUALITY_TELEMETRY_V1 — pure feature module.
 *
 * Two functions, one firewall:
 *
 *   preEntryFeatures()   reads ONLY bars that closed before the 1m fill minute
 *                        (it throws if handed anything later) and returns
 *                        exactly the PRE_ENTRY_FEATURES keys.
 *   postEntryOutcomes()  reads the path from the fill to the exit and returns
 *                        exactly the POST_ENTRY_OUTCOMES keys.
 *
 * Cohorts and trend tests are declared here as data (PRE_COHORTS,
 * TREND_FEATURES) and are evaluated on a projection that contains pre-entry
 * keys only, so a cohort cannot read an outcome even by accident.
 *
 * Production definitions are reused, not re-invented: swing points, market
 * structure (CHoCH) and displacement come from _shared/smcAnalysis.ts; the
 * engulfing and rejection-wick rules match _shared/zoneConfirmation.ts.
 *
 * Every definition, window and bucket below was FROZEN before the first run.
 */

import {
  analyzeMarketStructure, detectDisplacement, detectSwingPoints, type Candle,
} from "../supabase/functions/_shared/smcAnalysis.ts";
import { atrSeries } from "./marketContext.ts";

export type Bar = Candle;
const M = 60_000;

// ── frozen windows ─────────────────────────────────────────────────────────
export const APPROACH_WINDOWS = [3, 5, 10] as const;
export const SWEEP_LOOKBACK = 20;          // closed 1m bars (spec's single version)
export const SWING_LOOKBACK = 3;           // production detectSwingPoints default
export const STRUCTURE_BARS = 120;         // closed 1m bars handed to analyzeMarketStructure
export const DISPLACEMENT_BARS = 60;       // detectDisplacement needs >= 25
export const REJECTION_WICK_MIN = 0.3;     // zoneConfirmation.ts rule
export const DEPTH_BUCKETS = ["0-20%", "20-40%", "40-60%", "60-80%", "80-100%", ">100%"] as const;
export const TTF_BUCKETS = ["0 min", "1-15 min", "15-60 min", "60-240 min", ">240 min"] as const;
export const EARLY_HORIZONS = [5, 15, 30] as const;
export const R_LEVELS = [0.25, 0.5, 1, 1.5, 2] as const;

export const depthBucket = (pct: number): typeof DEPTH_BUCKETS[number] =>
  pct > 100 ? ">100%" : pct >= 80 ? "80-100%" : pct >= 60 ? "60-80%" : pct >= 40 ? "40-60%" : pct >= 20 ? "20-40%" : "0-20%";
export const ttfBucket = (min: number | null): typeof TTF_BUCKETS[number] =>
  min === null || min > 240 ? ">240 min" : min >= 60 ? "60-240 min" : min >= 15 ? "15-60 min" : min >= 1 ? "1-15 min" : "0 min";

// ── geometry ───────────────────────────────────────────────────────────────
export interface Geom {
  long: boolean;
  proximal: number;   // near edge: where a visit starts
  distal: number;     // far edge = IPO 50% = the frozen entry price
  extent: number;     // IPO extreme = the S2 invalidation level
  entry: number; stop: number; target: number; risk: number;
  pip: number;        // EUR/USD 0.0001, USD/JPY 0.01, BTC/USD 1 (one dollar)
}

/** Penetration from the near edge, in % of the zone (100% = far edge). */
export function depthPct(g: Geom, price: number): number {
  const w = Math.abs(g.distal - g.proximal);
  return (100 * (g.long ? g.proximal - price : price - g.proximal)) / w;
}
/** True when a bar's adverse extreme crossed the near edge. */
const inZone = (g: Geom, b: Bar) => (g.long ? b.low <= g.proximal : b.high >= g.proximal);
/** Trade-direction sign. */
const sgn = (g: Geom) => (g.long ? 1 : -1);
const T = (b: Bar) => Date.parse(b.datetime);

// ── key lists: the firewall ────────────────────────────────────────────────
export const PRE_ENTRY_FEATURES = [
  // Part 1 geometry
  "zone_near_edge", "zone_far_edge", "zone_midpoint", "ipo_extent", "zone_width_price", "zone_width_pips",
  "zone_width_atr", "ipo_range_atr", "ipo_body_ratio", "zone_age_bars", "zone_age_hours",
  // Part 2 penetration
  "penetration_price", "penetration_pips", "penetration_pct_of_zone", "max_penetration_before_fill",
  "max_penetration_bucket", "prior_visit_max_depth_pct", "fill_depth_pct_of_zone",
  // Part 3 (pre side)
  "visit_start_time", "minutes_from_first_touch_to_fill", "ttf_bucket", "minutes_into_touch_bar",
  // Part 4 touches
  "touch_count_before_fill", "zone_reentry_count_before_fill", "bars_since_previous_touch",
  "first_touch_trade", "repeated_touch_trade", "prior_bars_in_zone",
  // Part 5 approach (per window)
  ...APPROACH_WINDOWS.flatMap((n) => [
    `approach${n}_return_atr`, `approach${n}_range_atr`, `approach${n}_directional_bar_ratio`,
    `approach${n}_body_dominance`, `approach${n}_overlap_ratio`, `approach${n}_path_efficiency`,
    `approach${n}_slope_atr`, `approach${n}_avg_body_range`, `approach${n}_avg_wick_range`,
  ]),
  "approach10_acceleration_atr", "approach_label",
  // Part 6 rejection (last closed bar)
  "last_bar_rejection_wick_ratio", "last_bar_rejection_wick", "last_bar_close_position",
  "last_bar_body_ratio_signed", "engulfing_before_fill", "favorable_close_from_zone",
  // Part 7 sweep
  "sweep_present", "sweep_level", "sweep_distance_pips", "sweep_distance_atr", "minutes_sweep_to_fill",
  // Part 8 micro CHoCH
  "micro_choch_before_fill", "last_choch_direction_aligned", "bars_from_choch_to_fill",
  "choch_close_based", "choch_significance",
  // Part 9 displacement
  "last_bar_body_range_ratio", "last_bar_range_atr", "last_bar_favorable", "displacement_favorable",
  "displacement_adverse", "displacement_score", "strongest_reaction_body_ratio",
  "strongest_reaction_range_atr", "reaction_path_efficiency",
  // Part 10 fill quality (all known at the fill)
  "intended_entry_price", "actual_fill_price", "intended_vs_actual_entry_difference_pips",
  "intended_vs_actual_entry_difference_r", "entry_difference_bucket", "distance_from_zone_midpoint_pips",
  "distance_from_far_edge_pips", "remaining_room_to_invalidation_r", "fill_bar_opened_through_entry",
  // Part 11 risk
  "initial_risk_pips", "initial_risk_atr", "risk_atr_1m", "reward_to_target_pips", "planned_r",
  "zone_width_to_risk_ratio", "entry_depth_to_risk_ratio", "cost_r",
  // data quality
  "m1_bars_before_fill",
] as const;
export type PreKey = typeof PRE_ENTRY_FEATURES[number];
export type PreFeatures = Record<PreKey, number | string | boolean | null>;

export const POST_ENTRY_OUTCOMES = [
  "net_r", "gross_r", "exit_reason", "win",
  "mae_r", "mfe_r", "minutes_to_mae", "minutes_to_mfe",
  ...R_LEVELS.flatMap((x) => [`reached_${x}r`, `minutes_to_${x}r`]),
  ...EARLY_HORIZONS.flatMap((h) => [`mae_first_${h}m`, `mfe_first_${h}m`]),
  "minutes_from_first_touch_to_first_favorable_move", "holding_minutes_1m", "post_fill_max_depth_pct",
  "m1_bars_in_trade",
] as const;
export type PostKey = typeof POST_ENTRY_OUTCOMES[number];
export type PostOutcomes = Record<PostKey, number | string | boolean | null>;

/** Throws if any key is not a pre-entry feature (or is an outcome). */
export function assertPreEntryOnly(keys: readonly string[]): void {
  const pre = new Set<string>(PRE_ENTRY_FEATURES), post = new Set<string>(POST_ENTRY_OUTCOMES);
  for (const k of keys) {
    if (post.has(k)) throw new Error(`LEAKAGE: post-entry outcome "${k}" used in a pre-entry analysis`);
    if (!pre.has(k)) throw new Error(`LEAKAGE: "${k}" is not a declared pre-entry feature`);
  }
}
/** The only view a cohort or trend test ever sees. */
export function pickPre(row: Record<string, unknown>): Readonly<PreFeatures> {
  const o = {} as PreFeatures;
  for (const k of PRE_ENTRY_FEATURES) o[k] = (row[k] ?? null) as PreFeatures[PreKey];
  return Object.freeze(o);
}

// ── frozen pre-entry cohorts (Part 14, families A-G) ───────────────────────
export interface CohortSpec {
  family: "A" | "B" | "C" | "D" | "E" | "F" | "G"; group: string; name: string;
  feature: PreKey; test: (v: PreFeatures[PreKey]) => boolean;
}
export const PRE_COHORTS: CohortSpec[] = [
  ...DEPTH_BUCKETS.map((b) => ({ family: "A" as const, group: "A. penetration depth (deepest closed 1m bar of the visit before fill)",
    name: `DEPTH ${b}`, feature: "max_penetration_bucket" as PreKey, test: (v: unknown) => v === b })),
  { family: "B", group: "B. first vs repeated touch", name: "FIRST TOUCH", feature: "first_touch_trade", test: (v) => v === true },
  { family: "C", group: "C. local sweep", name: "SWEEP PRESENT", feature: "sweep_present", test: (v) => v === true },
  { family: "D", group: "D. micro CHoCH", name: "ALIGNED CHoCH SINCE FIRST TOUCH", feature: "micro_choch_before_fill", test: (v) => v === true },
  { family: "E", group: "E. displacement", name: "FAVORABLE DISPLACEMENT", feature: "displacement_favorable", test: (v) => v === true },
  { family: "E", group: "E. displacement", name: "ADVERSE DISPLACEMENT (impulsive approach)", feature: "displacement_adverse", test: (v) => v === true },
  ...TTF_BUCKETS.map((b) => ({ family: "F" as const, group: "F. first touch to fill",
    name: `TTF ${b}`, feature: "ttf_bucket" as PreKey, test: (v: unknown) => v === b })),
  { family: "G", group: "G. intended-vs-actual entry difference", name: "DIFF 0 (limit fill at intended price)",
    feature: "entry_difference_bucket", test: (v) => v === "0" },
];

/** Continuous pre-entry features given a Spearman trend test (frozen list). */
export const TREND_FEATURES: PreKey[] = [
  "max_penetration_before_fill", "minutes_from_first_touch_to_fill", "touch_count_before_fill",
  "zone_reentry_count_before_fill", "zone_width_atr", "zone_age_bars", "ipo_range_atr",
  "approach10_return_atr", "approach10_path_efficiency", "approach10_directional_bar_ratio",
  "approach10_body_dominance", "approach10_overlap_ratio", "approach10_range_atr",
  "last_bar_rejection_wick_ratio", "last_bar_close_position", "last_bar_range_atr",
  "strongest_reaction_body_ratio", "cost_r", "risk_atr_1m",
];

// ── pre-entry ──────────────────────────────────────────────────────────────
export interface PreInput {
  g: Geom;
  decisionMs: number;        // open of the 1m fill minute
  touchBarOpenMs: number;
  tfMs: number;
  fillBarOpen: number;       // the fill minute's OPEN — the only part of it known at its start
  m1Before: Bar[];           // closed 1m bars strictly before decisionMs, oldest first
  ownBetween: Bar[];         // own-TF bars after the IPO candle and before the touch bar
  ownPrefix: Bar[];          // own-TF bars before the touch bar (ATR)
  ipo: Bar;
  costR: number;
}

const num = (x: number) => (Number.isFinite(x) ? x : null);

function approach(g: Geom, bars: Bar[], atr: number) {
  const n = bars.length, s = sgn(g);
  if (!n || !(atr > 0)) return null;
  const o0 = bars[0].open, cN = bars[n - 1].close;
  const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low));
  let toward = 0, sb = 0, sr = 0, ovl = 0, ovn = 0, path = 0, bodyR = 0, wickR = 0, rn = 0, prevC = o0;
  bars.forEach((b, i) => {
    const body = b.close - b.open, rng = b.high - b.low;
    if (s * body < 0) toward++;                      // moving toward the zone = against the trade
    sb += Math.abs(body); sr += rng;
    if (rng > 0) { bodyR += Math.abs(body) / rng; wickR += (rng - Math.abs(body)) / rng; rn++; }
    if (i > 0 && rng > 0) {
      const p = bars[i - 1];
      ovl += Math.max(0, Math.min(b.high, p.high) - Math.max(b.low, p.low)) / rng; ovn++;
    }
    path += Math.abs(b.close - prevC); prevC = b.close;
  });
  // OLS slope of closes on bar index, trade-direction signed, ATR per bar.
  const slope = (xs: Bar[]) => {
    const k = xs.length; if (k < 2) return null;
    const mx = (k - 1) / 2, my = xs.reduce((a, b) => a + b.close, 0) / k;
    let nu = 0, de = 0;
    xs.forEach((b, i) => { nu += (i - mx) * (b.close - my); de += (i - mx) ** 2; });
    return (s * nu) / de / atr;
  };
  return {
    return_atr: (s * (cN - o0)) / atr, range_atr: (hi - lo) / atr, directional_bar_ratio: toward / n,
    body_dominance: sr > 0 ? sb / sr : null, overlap_ratio: ovn ? ovl / ovn : null,
    path_efficiency: path > 0 ? Math.abs(cN - o0) / path : null, slope_atr: slope(bars),
    avg_body_range: rn ? bodyR / rn : null, avg_wick_range: rn ? wickR / rn : null,
    acceleration: n >= 10 ? (() => { const a = slope(bars.slice(0, 5)), b = slope(bars.slice(-5)); return a === null || b === null ? null : b - a; })() : null,
  };
}

export function preEntryFeatures(x: PreInput): PreFeatures {
  const { g, decisionMs: D, m1Before: m1 } = x;
  // FIREWALL: nothing at or after the fill minute may enter.
  if (m1.some((b) => T(b) >= D)) throw new Error("preEntryFeatures: 1m bar at/after the fill minute");
  // Own-TF bars are causal by series order, as in the engine (barsBefore =
  // slice(0, K)): every bar that opened before the touch bar had closed by its
  // open. The provider's early 4H history has irregular spacing (04:00, 06:00,
  // 08:00, 11:00), so "open + 4h" is not a bar's close.
  if (x.ownBetween.some((b) => T(b) >= x.touchBarOpenMs) || x.ownPrefix.some((b) => T(b) >= x.touchBarOpenMs)) {
    throw new Error("preEntryFeatures: own-TF bar not closed before the touch bar");
  }
  const s = sgn(g), pip = g.pip;
  const w = Math.abs(g.distal - g.proximal);
  const ownAtr = atrSeries(x.ownPrefix).at(-1) ?? NaN;
  const m1Atr = atrSeries(m1).at(-1) ?? NaN;
  const ipoRange = x.ipo.high - x.ipo.low;

  // ── current 1m visit: starts after the last closed bar entirely outside ──
  let lastOut = -1;
  for (let i = m1.length - 1; i >= 0; i--) if (!inZone(g, m1[i])) { lastOut = i; break; }
  const visit = lastOut >= 0 ? m1.slice(lastOut + 1) : null;     // null: began before coverage
  const visitStartMs = visit === null ? null : visit.length ? T(visit[0]) : D;
  const ttf = visitStartMs === null ? null : (D - visitStartMs) / M;
  const visitBars = visit ?? m1;
  const maxPen = visitBars.length ? Math.max(0, ...visitBars.map((b) => depthPct(g, g.long ? b.low : b.high))) : 0;

  // ── strategy-TF visits between the IPO candle and the touch bar ──
  // A visit is a run of consecutive bars whose adverse extreme crosses the
  // near edge; a bar that does not cross ends it. The touch bar always crosses.
  let episodes = 0, prevIn = false, inBars = 0, lastInIdx = -1, priorMax = 0;
  x.ownBetween.forEach((b, i) => {
    const z = inZone(g, b);
    if (z) { inBars++; lastInIdx = i; priorMax = Math.max(priorMax, depthPct(g, g.long ? b.low : b.high)); }
    if (z && !prevIn) episodes++;
    prevIn = z;
  });
  const touchCount = prevIn ? episodes : episodes + 1;
  const barsSincePrev = (() => {
    if (lastInIdx < 0) return null;
    if (prevIn) {                     // the touch bar continues a visit: find that visit's predecessor
      let i = x.ownBetween.length - 1;
      while (i >= 0 && inZone(g, x.ownBetween[i])) i--;
      while (i >= 0 && !inZone(g, x.ownBetween[i])) i--;
      return i < 0 ? null : x.ownBetween.length - i;
    }
    return x.ownBetween.length - lastInIdx;
  })();

  // ── 1m re-entries inside the touch bar, before the fill ──
  const inBar = m1.filter((b) => T(b) >= x.touchBarOpenMs);
  const before = m1.filter((b) => T(b) < x.touchBarOpenMs).at(-1);
  const seq = [before ? inZone(g, before) : false, ...inBar.map((b) => inZone(g, b)), true];
  let runs = 0;
  seq.forEach((z, i) => { if (z && (i === 0 || !seq[i - 1])) runs++; });

  // ── approach windows ──
  const ap: Record<string, number | null> = {};
  for (const n of APPROACH_WINDOWS) {
    const a = m1.length >= n ? approach(g, m1.slice(-n), m1Atr) : null;
    for (const k of ["return_atr", "range_atr", "directional_bar_ratio", "body_dominance", "overlap_ratio",
      "path_efficiency", "slope_atr", "avg_body_range", "avg_wick_range"] as const) {
      ap[`approach${n}_${k}`] = a ? num(a[k] as number) : null;
    }
    if (n === 10) ap.approach10_acceleration_atr = a ? a.acceleration : null;
  }

  // ── last closed bar: rejection, engulfing, displacement ──
  const lb = m1.at(-1), pb = m1.at(-2);
  const lbRange = lb ? lb.high - lb.low : 0;
  const rejWick = lb && lbRange > 0
    ? (g.long ? Math.min(lb.open, lb.close) - lb.low : lb.high - Math.max(lb.open, lb.close)) / lbRange : null;
  const engulf = lb && pb
    ? (g.long ? lb.open <= pb.close && lb.close >= pb.open : lb.open >= pb.close && lb.close <= pb.open) : null;
  const disp = detectDisplacement(m1.slice(-DISPLACEMENT_BARS));
  const favDir = g.long ? "bullish" : "bearish";
  const favDisp = disp.displacementCandles.filter((d) => d.direction === favDir);
  const advDisp = disp.displacementCandles.filter((d) => d.direction !== favDir);

  // strongest favorable reaction bar since the visit began
  let strongBody: number | null = null, strongRange: number | null = null;
  for (const b of visitBars) {
    const r = b.high - b.low;
    if (r <= 0 || s * (b.close - b.open) <= 0) continue;
    const br = Math.abs(b.close - b.open) / r;
    if (strongBody === null || br > strongBody) strongBody = br;
    const ra = m1Atr > 0 ? r / m1Atr : null;
    if (ra !== null && (strongRange === null || ra > strongRange)) strongRange = ra;
  }
  // reaction efficiency: favorable net move from the visit's deepest bar to the last close, over its path
  let reactEff: number | null = null;
  if (visitBars.length >= 2 && visit !== null) {
    let di = 0;
    visitBars.forEach((b, i) => { if (depthPct(g, g.long ? b.low : b.high) > depthPct(g, g.long ? visitBars[di].low : visitBars[di].high)) di = i; });
    const seg = visitBars.slice(di);
    const ext = g.long ? visitBars[di].low : visitBars[di].high;
    let path = 0, pc = ext;
    for (const b of seg) { path += Math.abs(b.close - pc); pc = b.close; }
    reactEff = path > 0 ? (s * (seg.at(-1)!.close - ext)) / path : null;
  }

  // ── sweep: within the last 20 closed bars, a bar trades through the most
  // recent swing CONFIRMED BEFORE IT (production lookback 3) and closes back
  // (production sweep rule). The most recent such bar is reported.
  let sweep = false, sweepLevel: number | null = null, sweepDist: number | null = null, sweepMin: number | null = null;
  {
    const win = m1.slice(-(SWEEP_LOOKBACK + SWING_LOOKBACK));
    const first = win.length - Math.min(SWEEP_LOOKBACK, win.length);
    const swings = detectSwingPoints(win, SWING_LOOKBACK).filter((p) => p.type === (g.long ? "low" : "high"));
    for (let i = first; i < win.length; i++) {
      const sw = swings.filter((p) => p.index >= first && p.index + SWING_LOOKBACK < i).at(-1);
      if (!sw) continue;
      const c = win[i];
      const hit = g.long ? c.low < sw.price && c.close >= sw.price : c.high > sw.price && c.close <= sw.price;
      if (hit) {
        sweep = true; sweepLevel = sw.price;
        sweepDist = g.long ? sw.price - c.low : c.high - sw.price;
        sweepMin = (D - T(c)) / M;
      }
    }
  }

  // ── micro CHoCH: production structure on the last 120 closed bars ──
  const sWin = m1.slice(-STRUCTURE_BARS), sOff = m1.length - sWin.length;
  const ms = sWin.length >= 20 ? analyzeMarketStructure(sWin) : null;
  const visitIdx = visitStartMs === null ? 0 : (() => { const i = m1.findIndex((b) => T(b) >= visitStartMs); return i < 0 ? m1.length : i; })();
  const chochs = ms ? [...ms.choch].sort((a, b) => a.index - b.index) : [];
  const lastChoch = chochs.at(-1) ?? null;
  const alignedSinceTouch = chochs.some((c) => c.type === favDir && c.index + sOff >= visitIdx);

  const penPrice = (maxPen / 100) * w;
  return {
    zone_near_edge: g.proximal, zone_far_edge: g.distal, zone_midpoint: (g.proximal + g.distal) / 2, ipo_extent: g.extent,
    zone_width_price: w, zone_width_pips: w / pip, zone_width_atr: num(w / ownAtr),
    ipo_range_atr: num(ipoRange / ownAtr), ipo_body_ratio: ipoRange > 0 ? Math.abs(x.ipo.close - x.ipo.open) / ipoRange : null,
    zone_age_bars: x.ownBetween.length + 1, zone_age_hours: (x.touchBarOpenMs - T(x.ipo)) / 3_600_000,
    penetration_price: penPrice, penetration_pips: penPrice / pip, penetration_pct_of_zone: maxPen,
    max_penetration_before_fill: maxPen, max_penetration_bucket: depthBucket(maxPen),
    prior_visit_max_depth_pct: inBars ? priorMax : null, fill_depth_pct_of_zone: depthPct(g, g.entry),
    visit_start_time: visitStartMs === null ? null : new Date(visitStartMs).toISOString(),
    minutes_from_first_touch_to_fill: ttf, ttf_bucket: ttfBucket(ttf),
    minutes_into_touch_bar: (D - x.touchBarOpenMs) / M,
    touch_count_before_fill: touchCount, zone_reentry_count_before_fill: Math.max(0, runs - 1),
    bars_since_previous_touch: barsSincePrev, first_touch_trade: touchCount === 1, repeated_touch_trade: touchCount > 1,
    prior_bars_in_zone: inBars,
    ...ap,
    approach_label: advDisp.length ? "IMPULSIVE (production displacement toward zone)" : "NOT_IMPULSIVE",
    last_bar_rejection_wick_ratio: rejWick, last_bar_rejection_wick: rejWick === null ? null : rejWick > REJECTION_WICK_MIN,
    last_bar_close_position: lb && lbRange > 0 ? (g.long ? lb.close - lb.low : lb.high - lb.close) / lbRange : null,
    last_bar_body_ratio_signed: lb && lbRange > 0 ? (s * (lb.close - lb.open)) / lbRange : null,
    engulfing_before_fill: engulf, favorable_close_from_zone: lb ? (g.long ? lb.close > g.proximal : lb.close < g.proximal) : null,
    sweep_present: sweep, sweep_level: sweepLevel, sweep_distance_pips: sweepDist === null ? null : sweepDist / pip,
    sweep_distance_atr: sweepDist === null ? null : num(sweepDist / m1Atr), minutes_sweep_to_fill: sweepMin,
    micro_choch_before_fill: alignedSinceTouch,
    last_choch_direction_aligned: lastChoch ? lastChoch.type === favDir : null,
    bars_from_choch_to_fill: lastChoch ? m1.length - (lastChoch.index + sOff) : null,
    choch_close_based: lastChoch ? lastChoch.closeBased : null, choch_significance: lastChoch?.significance ?? null,
    last_bar_body_range_ratio: lb && lbRange > 0 ? Math.abs(lb.close - lb.open) / lbRange : null,
    last_bar_range_atr: lb ? num(lbRange / m1Atr) : null, last_bar_favorable: lb ? s * (lb.close - lb.open) > 0 : null,
    displacement_favorable: favDisp.length > 0, displacement_adverse: advDisp.length > 0,
    displacement_score: favDisp.length ? Math.max(...favDisp.map((d) => d.rangeMultiple)) : 0,
    strongest_reaction_body_ratio: strongBody, strongest_reaction_range_atr: strongRange, reaction_path_efficiency: reactEff,
    // The frozen engine fills a limit at the entry price, so actual == intended.
    intended_entry_price: g.entry, actual_fill_price: g.entry,
    intended_vs_actual_entry_difference_pips: 0, intended_vs_actual_entry_difference_r: 0, entry_difference_bucket: "0",
    distance_from_zone_midpoint_pips: Math.abs(g.entry - (g.proximal + g.distal) / 2) / pip,
    distance_from_far_edge_pips: Math.abs(g.entry - g.distal) / pip,
    remaining_room_to_invalidation_r: Math.abs(g.entry - g.stop) / g.risk,
    fill_bar_opened_through_entry: g.long ? x.fillBarOpen < g.entry : x.fillBarOpen > g.entry,
    initial_risk_pips: g.risk / pip, initial_risk_atr: num(g.risk / ownAtr), risk_atr_1m: num(g.risk / m1Atr),
    reward_to_target_pips: Math.abs(g.target - g.entry) / pip, planned_r: Math.abs(g.target - g.entry) / g.risk,
    zone_width_to_risk_ratio: w / g.risk, entry_depth_to_risk_ratio: Math.abs(g.entry - g.proximal) / g.risk,
    cost_r: x.costR,
    m1_bars_before_fill: m1.length,
  } as PreFeatures;
}

// ── post-entry outcomes ────────────────────────────────────────────────────
export interface PostInput {
  g: Geom;
  decisionMs: number;
  exitMs: number;            // TARGET: the target minute's open; S2: the S2 bar's CLOSE instant
  exitReason: "TARGET" | "S2_CLOSE_INVALIDATION";
  m1From: Bar[];             // 1m bars from the fill minute on (inclusive)
  netR: number; grossR: number;
  minutesTouchToFill: number | null;
}

/**
 * The fill minute contributes its adverse extreme (which can only come at or
 * after the fill) and its close, never its favorable extreme (which may have
 * come first). A TARGET exit's MFE is the 2R target by definition; the target
 * minute's adverse extreme is excluded because its order is unknown.
 */
export function postEntryOutcomes(x: PostInput): PostOutcomes {
  const { g, decisionMs: D } = x, s = sgn(g);
  const tgt = x.exitReason === "TARGET";
  const bars = x.m1From.filter((b) => T(b) >= D && (tgt ? T(b) <= x.exitMs : T(b) < x.exitMs));
  const adv = (b: Bar) => (s * (g.entry - (g.long ? b.low : b.high))) / g.risk;   // >0 = against
  const fav = (b: Bar, i: number) => (s * ((i === 0 ? b.close : g.long ? b.high : b.low) - g.entry)) / g.risk;
  let mae = 0, mfe = 0, tMae = 0, tMfe = 0, maxDepth = 100;
  const first: Record<number, number | null> = {};
  for (const lv of R_LEVELS) first[lv] = null;
  bars.forEach((b, i) => {
    const t = (T(b) - D) / M;
    const isTgtMin = tgt && T(b) === x.exitMs;
    if (!isTgtMin) {
      const a = adv(b);
      if (a > mae) { mae = a; tMae = t; }
      maxDepth = Math.max(maxDepth, depthPct(g, g.long ? b.low : b.high));
    }
    const f = isTgtMin ? 2 : Math.min(fav(b, i), tgt ? 2 : Infinity);
    if (f > mfe) { mfe = f; tMfe = t; }
    for (const lv of R_LEVELS) if (first[lv] === null && f >= lv - 1e-9) first[lv] = t;
  });
  if (tgt) { mfe = 2; tMfe = (x.exitMs - D) / M; for (const lv of R_LEVELS) first[lv] ??= tMfe; }
  const early: Record<string, number> = {};
  for (const h of EARLY_HORIZONS) {
    let a = 0, f = 0;
    bars.forEach((b, i) => {
      if (T(b) >= D + h * M) return;
      const isTgtMin = tgt && T(b) === x.exitMs;
      if (!isTgtMin) a = Math.max(a, adv(b));
      f = Math.max(f, isTgtMin ? 2 : Math.min(fav(b, i), tgt ? 2 : Infinity));
    });
    early[`mae_first_${h}m`] = a; early[`mfe_first_${h}m`] = f;
  }
  return {
    net_r: x.netR, gross_r: x.grossR, exit_reason: x.exitReason, win: x.netR > 0,
    mae_r: mae, mfe_r: mfe, minutes_to_mae: tMae, minutes_to_mfe: tMfe,
    ...Object.fromEntries(R_LEVELS.flatMap((lv) => [[`reached_${lv}r`, first[lv] !== null], [`minutes_to_${lv}r`, first[lv]]])),
    ...early,
    minutes_from_first_touch_to_first_favorable_move:
      x.minutesTouchToFill === null || first[0.25] === null ? null : x.minutesTouchToFill + first[0.25]!,
    holding_minutes_1m: (x.exitMs - D) / M, post_fill_max_depth_pct: maxDepth,
    m1_bars_in_trade: bars.length,
  } as PostOutcomes;
}
