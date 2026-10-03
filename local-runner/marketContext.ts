/**
 * Market-context features for IPO_MARKET_CONTEXT_TELEMETRY_V1.
 *
 * RESEARCH TELEMETRY ONLY. Not imported by any edge function.
 *
 * Every definition, threshold and bucket here was fixed BEFORE any result was
 * computed. They are not to be tuned against results.
 *
 * ── TIME ───────────────────────────────────────────────────────────────────
 * Wall clocks come from the IANA tz database via Intl (ICU ships with Deno),
 * so DST is the authoritative calendar, not a hand-written offset table.
 * Zones: Europe/London, America/New_York.
 *
 * ── CAUSALITY ──────────────────────────────────────────────────────────────
 * The decision instant D is the trade's 1m fill minute. Timestamp features
 * depend on D alone. Bar features use ONLY bars that had CLOSED at D:
 *   - own-timeframe bars: those strictly before the touch bar;
 *   - 1H bars (session/day context, for both 1H and 4H trades): those whose
 *     close <= D. The bar containing D is still forming and is excluded —
 *     except for an OPEN price, which is known from the bar's first tick.
 */

export const LONDON = "Europe/London";
export const NEW_YORK = "America/New_York";
const MIN = 60_000, HOUR = 3_600_000;

// ─── timezone primitives ────────────────────────────────────────────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    }));
  }
  return fmtCache.get(tz)!;
}

export interface LocalParts { y: number; m: number; d: number; h: number; mi: number; s: number; wd: number }
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of instant `ms` in zone `tz`. */
export function localParts(ms: number, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, wd: WD[p.weekday] };
}

/** UTC offset of `tz` at instant `ms`, in minutes (London summer = +60). */
export function offsetMin(ms: number, tz: string): number {
  const l = localParts(ms, tz);
  return Math.round((Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s) - Math.floor(ms / 1000) * 1000) / MIN);
}

/** The UTC instant at which `tz` shows the given wall time. Two-pass fix-point. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let utc = guess - offsetMin(guess, tz) * MIN;
  utc = guess - offsetMin(utc, tz) * MIN;
  return utc;
}

/** Calendar date shifted by `days`, wall-clock arithmetic on the date only. */
function shiftDate(y: number, m: number, d: number, days: number) {
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// ─── fixed descriptive time buckets ─────────────────────────────────────────

export const UTC_WINDOWS: Array<[string, number, number]> = [
  ["00:00-05:59", 0, 6], ["06:00-07:59", 6, 8], ["08:00-11:59", 8, 12],
  ["12:00-15:59", 12, 16], ["16:00-19:59", 16, 20], ["20:00-23:59", 20, 24],
];
export function utcWindow(ms: number): string {
  const h = new Date(ms).getUTCHours();
  return UTC_WINDOWS.find(([, a, b]) => h >= a && h < b)![0];
}

// ─── FX sessions (DST-aware, by local clocks) ───────────────────────────────
//
// London session  08:00-17:00 Europe/London
// New York session 08:00-17:00 America/New_York
// Mutually exclusive labels, first match wins:
//   LONDON_NY_OVERLAP  inside both
//   LATE_NY_ROLLOVER   New York 16:00-19:00 (last NY hour, rollover, thin hours after)
//   LONDON             inside London only
//   NEW_YORK           inside New York only
//   ASIA               everything else (Sydney/Tokyo hours)
// All boundaries fall on whole UTC hours in every DST combination, including
// the 2-3 week windows where the US and UK clocks change on different dates.

export type Session = "ASIA" | "LONDON" | "LONDON_NY_OVERLAP" | "NEW_YORK" | "LATE_NY_ROLLOVER";

export function session(ms: number): Session {
  const L = localParts(ms, LONDON), N = localParts(ms, NEW_YORK);
  const lm = L.h * 60 + L.mi, nm = N.h * 60 + N.mi;
  const inL = lm >= 8 * 60 && lm < 17 * 60, inN = nm >= 8 * 60 && nm < 17 * 60;
  if (inL && inN) return "LONDON_NY_OVERLAP";
  if (nm >= 16 * 60 && nm < 19 * 60) return "LATE_NY_ROLLOVER";
  if (inL) return "LONDON";
  if (inN) return "NEW_YORK";
  return "ASIA";
}

/** Signed minutes from a local wall-clock anchor on the SAME local date (positive = after). */
function minutesFromLocal(ms: number, tz: string, h: number, mi: number): number {
  const l = localParts(ms, tz);
  return Math.round((ms - zonedToUtc(l.y, l.m, l.d, h, mi, tz)) / MIN);
}

export interface SessionTiming {
  minutes_from_london_open: number;
  minutes_from_new_york_open: number;
  minutes_from_london_close: number;
  minutes_from_new_york_close: number;
}
export function sessionTiming(ms: number): SessionTiming {
  return {
    minutes_from_london_open: minutesFromLocal(ms, LONDON, 8, 0),
    minutes_from_new_york_open: minutesFromLocal(ms, NEW_YORK, 8, 0),
    minutes_from_london_close: minutesFromLocal(ms, LONDON, 17, 0),
    minutes_from_new_york_close: minutesFromLocal(ms, NEW_YORK, 17, 0),
  };
}

// ─── WM/Reuters London 4pm fix ──────────────────────────────────────────────
//
// 16:00 Europe/London. Since the 2015 FSB reforms the fix is computed over a
// five-minute window centred on 16:00 (15:57:30-16:02:30). Timing only — no
// assumption that the fix moves price in any direction.

export const FIX_HALF_WINDOW_MIN = 2.5;
export const FIX_BUCKETS = [">120 before", "60-120 before", "30-60 before", "0-30 before", "fix window",
  "0-30 after", "30-60 after", "60-120 after", ">120 after"] as const;
export type FixBucket = typeof FIX_BUCKETS[number];

export interface FixContext {
  minutes_to_london_fix: number | null;      // positive when the fix is still ahead today
  minutes_since_london_fix: number | null;   // positive when today's fix has passed
  in_fix_window: boolean;
  fix_bucket: FixBucket;
}
export function fixContext(ms: number): FixContext {
  const l = localParts(ms, LONDON);
  const fix = zonedToUtc(l.y, l.m, l.d, 16, 0, LONDON);
  const dMin = (ms - fix) / MIN;                // signed, positive after the fix
  const inWin = Math.abs(dMin) <= FIX_HALF_WINDOW_MIN;
  let b: FixBucket;
  if (inWin) b = "fix window";
  else if (dMin < 0) { const x = -dMin; b = x > 120 ? ">120 before" : x > 60 ? "60-120 before" : x > 30 ? "30-60 before" : "0-30 before"; }
  else { b = dMin > 120 ? ">120 after" : dMin > 60 ? "60-120 after" : dMin > 30 ? "30-60 after" : "0-30 after"; }
  return {
    minutes_to_london_fix: dMin < 0 ? Math.round(-dMin) : null,
    minutes_since_london_fix: dMin >= 0 ? Math.round(dMin) : null,
    in_fix_window: inWin, fix_bucket: b,
  };
}

// ─── New York 5pm rollover ──────────────────────────────────────────────────

export interface RolloverContext {
  minutes_to_ny_rollover: number;
  minutes_since_ny_rollover: number;
  rollover_pre_15: boolean;
  rollover_post_15: boolean;
  rollover_within_30: boolean;
  rollover_within_60: boolean;
  rollover_outside_60: boolean;
}
export function rolloverContext(ms: number): RolloverContext {
  const l = localParts(ms, NEW_YORK);
  const today = zonedToUtc(l.y, l.m, l.d, 17, 0, NEW_YORK);
  let next: number, prev: number;
  if (ms < today) {
    next = today;
    const p = shiftDate(l.y, l.m, l.d, -1);
    prev = zonedToUtc(p.y, p.m, p.d, 17, 0, NEW_YORK);
  } else {
    prev = today;
    const n = shiftDate(l.y, l.m, l.d, 1);
    next = zonedToUtc(n.y, n.m, n.d, 17, 0, NEW_YORK);
  }
  const to = Math.round((next - ms) / MIN), since = Math.round((ms - prev) / MIN);
  const near = Math.min(to, since);
  return {
    minutes_to_ny_rollover: to, minutes_since_ny_rollover: since,
    rollover_pre_15: to <= 15, rollover_post_15: since <= 15,
    rollover_within_30: near <= 30, rollover_within_60: near <= 60, rollover_outside_60: near > 60,
  };
}

// ─── trading day ────────────────────────────────────────────────────────────
//
// FX: a trading day runs 17:00 New York to 17:00 New York (the rollover), the
// standard FX convention, DST-aware. BTC: the UTC calendar day.

export function tradingDayStart(ms: number, fx: boolean): number {
  if (!fx) { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  const l = localParts(ms, NEW_YORK);
  const today = zonedToUtc(l.y, l.m, l.d, 17, 0, NEW_YORK);
  if (ms >= today) return today;
  const p = shiftDate(l.y, l.m, l.d, -1);
  return zonedToUtc(p.y, p.m, p.d, 17, 0, NEW_YORK);
}
/** Start of the trading day before the one beginning at `dayStart`. */
export function previousDayStart(dayStart: number, fx: boolean): number {
  return tradingDayStart(dayStart - MIN, fx);
}

// ─── bar helpers ────────────────────────────────────────────────────────────

export interface Bar { datetime: string; open: number; high: number; low: number; close: number }

/** Wilder ATR(14) series; value at i uses bars[0..i]. */
export function atrSeries(bars: Bar[], n = 14): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length < n + 1) return out;
  const tr = (i: number) => Math.max(bars[i].high - bars[i].low,
    Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  let s = 0;
  for (let i = 1; i <= n; i++) s += tr(i);
  out[n] = s / n;
  for (let i = n + 1; i < bars.length; i++) out[i] = ((out[i - 1] as number) * (n - 1) + tr(i)) / n;
  return out;
}

/** Population stdev of log returns over the `n` returns ending at i. */
export function realizedVolSeries(bars: Bar[], n = 20): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  for (let i = n; i < bars.length; i++) {
    const r: number[] = [];
    for (let k = i - n + 1; k <= i; k++) r.push(Math.log(bars[k].close / bars[k - 1].close));
    const m = r.reduce((a, b) => a + b, 0) / n;
    out[i] = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  }
  return out;
}

/** Fraction of the trailing `window` values (ending at i, inclusive) that are <= the value at i. */
export function trailingPercentile(series: (number | null)[], i: number, window: number): number | null {
  const v = series[i];
  if (v === null || i - window + 1 < 0) return null;
  let le = 0, cnt = 0;
  for (let k = i - window + 1; k <= i; k++) {
    const x = series[k];
    if (x === null) return null;
    cnt++; if (x <= v) le++;
  }
  return le / cnt;
}

export type VolRegime = "LOW" | "NORMAL" | "HIGH" | null;
/** Frozen: from the 100-bar trailing ATR percentile. */
export function volRegime(atrPct100: number | null): VolRegime {
  if (atrPct100 === null) return null;
  return atrPct100 <= 0.25 ? "LOW" : atrPct100 >= 0.75 ? "HIGH" : "NORMAL";
}

// ─── the feature set for one trade ──────────────────────────────────────────

export const NEAR_ATR = 0.25;   // frozen

export interface ContextFeatures extends SessionTiming, FixContext, RolloverContext {
  entry_timestamp_utc: string;
  utc_hour: number; weekday: number; month: number; year: number;
  utc_window: string;
  session: Session;
  // volatility (own timeframe, closed bars before the touch bar)
  atr14: number | null;
  atr_pct_100: number | null;
  atr_pct_252: number | null;
  last_bar_range_atr: number | null;
  rv20: number | null;
  rv_pct_100: number | null;
  prior_session_range_atr: number | null;
  prior_day_range_atr: number | null;
  vol_regime: VolRegime;
  // price location (entry price vs levels known at D), in own-TF ATR
  day_open: number | null;
  prev_day_high: number | null; prev_day_low: number | null; prev_day_close: number | null;
  session_open: number | null; session_high_so_far: number | null; session_low_so_far: number | null;
  distance_day_open_atr: number | null;
  distance_prev_day_high_atr: number | null;
  distance_prev_day_low_atr: number | null;
  distance_prev_day_close_atr: number | null;
  distance_session_open_atr: number | null;
  distance_session_high_atr: number | null;
  distance_session_low_atr: number | null;
  prior_day_position: "INSIDE" | "ABOVE_PDH" | "BELOW_PDL" | null;
  near_pdh: boolean | null; near_pdl: boolean | null; near_day_open: boolean | null;
}

export interface FeatureInput {
  /** Decision instant: the 1m fill minute. */
  decisionMs: number;
  entryPrice: number;
  fx: boolean;
  /** Own-timeframe bars strictly before the touch bar. */
  ownPrefix: Bar[];
  /** 1H bars covering at least the prior two trading days; any later bars are ignored here. */
  hourly: Bar[];
}

export function contextFeatures(i: FeatureInput): ContextFeatures {
  const D = i.decisionMs;
  const dt = new Date(D);

  // ── own-timeframe volatility, closed bars only ──
  const own = i.ownPrefix;
  const atr = atrSeries(own), rv = realizedVolSeries(own);
  const last = own.length - 1;
  const atr14 = last >= 0 ? atr[last] : null;
  const atrPct100 = last >= 0 ? trailingPercentile(atr, last, 100) : null;
  const nz = (x: number | null) => (x === null || !(x > 0) ? null : x);
  const A = nz(atr14);
  const norm = (x: number | null) => (x === null || A === null ? null : x / A);

  // ── 1H bars knowable at D ──
  // Closed: close (= open + 1h) <= D. An OPEN price is known from the bar's
  // first tick, so a bar that has merely STARTED by D may supply its open.
  const started = i.hourly.filter((b) => Date.parse(b.datetime) <= D);
  const closed = started.filter((b) => Date.parse(b.datetime) + HOUR <= D);

  // trading days
  const dayStart = tradingDayStart(D, i.fx);
  const dayOpenBar = started.find((b) => { const t = Date.parse(b.datetime); return t >= dayStart && t < dayStart + 24 * HOUR; });
  // previous COMPLETED trading day with data (skips weekend/holiday gaps)
  let pd: Bar[] = [], ps = dayStart;
  for (let k = 0; k < 5 && pd.length === 0; k++) {
    const pe = ps; ps = previousDayStart(ps, i.fx);
    pd = closed.filter((b) => { const t = Date.parse(b.datetime); return t >= ps && t < pe; });
  }
  const pdh = pd.length ? Math.max(...pd.map((b) => b.high)) : null;
  const pdl = pd.length ? Math.min(...pd.map((b) => b.low)) : null;
  const pdc = pd.length ? pd[pd.length - 1].close : null;

  // sessions on 1H bars, by each bar's open instant
  const cur = session(D);
  let sIdx = started.length - 1;
  while (sIdx >= 0 && session(Date.parse(started[sIdx].datetime)) === cur &&
         D - Date.parse(started[sIdx].datetime) < 24 * HOUR) sIdx--;
  const runStart = sIdx + 1;                                   // first bar of the current session run
  const curRun = started.slice(runStart);
  const curClosed = curRun.filter((b) => Date.parse(b.datetime) + HOUR <= D);
  const sessionOpen = curRun.length ? curRun[0].open : null;
  const sHi = curClosed.length ? Math.max(...curClosed.map((b) => b.high)) : null;
  const sLo = curClosed.length ? Math.min(...curClosed.map((b) => b.low)) : null;
  // prior session = the contiguous run immediately before the current one
  let priorRange: number | null = null;
  if (sIdx >= 0) {
    const lab = session(Date.parse(started[sIdx].datetime));
    let j = sIdx;
    while (j >= 0 && session(Date.parse(started[j].datetime)) === lab) j--;
    const run = started.slice(j + 1, sIdx + 1).filter((b) => Date.parse(b.datetime) + HOUR <= D);
    if (run.length) priorRange = Math.max(...run.map((b) => b.high)) - Math.min(...run.map((b) => b.low));
  }

  const e = i.entryPrice;
  const dist = (lvl: number | null) => (lvl === null ? null : norm(e - lvl));
  const dDO = dist(dayOpenBar ? dayOpenBar.open : null);
  const dPDH = dist(pdh), dPDL = dist(pdl);
  const near = (x: number | null) => (x === null ? null : Math.abs(x) <= NEAR_ATR);

  return {
    entry_timestamp_utc: dt.toISOString(),
    utc_hour: dt.getUTCHours(), weekday: dt.getUTCDay(), month: dt.getUTCMonth() + 1, year: dt.getUTCFullYear(),
    utc_window: utcWindow(D),
    session: cur,
    ...sessionTiming(D),
    ...fixContext(D),
    ...rolloverContext(D),
    atr14,
    atr_pct_100: atrPct100,
    atr_pct_252: last >= 0 ? trailingPercentile(atr, last, 252) : null,
    last_bar_range_atr: last >= 0 ? norm(own[last].high - own[last].low) : null,
    rv20: last >= 0 ? rv[last] : null,
    rv_pct_100: last >= 0 ? trailingPercentile(rv, last, 100) : null,
    prior_session_range_atr: norm(priorRange),
    prior_day_range_atr: pdh !== null && pdl !== null ? norm(pdh - pdl) : null,
    vol_regime: volRegime(atrPct100),
    day_open: dayOpenBar ? dayOpenBar.open : null,
    prev_day_high: pdh, prev_day_low: pdl, prev_day_close: pdc,
    session_open: sessionOpen, session_high_so_far: sHi, session_low_so_far: sLo,
    distance_day_open_atr: dDO,
    distance_prev_day_high_atr: dPDH,
    distance_prev_day_low_atr: dPDL,
    distance_prev_day_close_atr: dist(pdc),
    distance_session_open_atr: dist(sessionOpen),
    distance_session_high_atr: dist(sHi),
    distance_session_low_atr: dist(sLo),
    prior_day_position: pdh === null || pdl === null ? null : e > pdh ? "ABOVE_PDH" : e < pdl ? "BELOW_PDL" : "INSIDE",
    near_pdh: near(dPDH), near_pdl: near(dPDL), near_day_open: near(dDO),
  };
}
