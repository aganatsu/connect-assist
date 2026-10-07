/**
 * STEP 15 PR 3 — resolve a hypothetical (dry-run) fill forward on stored 5m bars.
 * PURE: no database, no clock (the caller passes `nowMs` and the last scan time).
 *
 * Rules (method "bar_replay_5m.v1"):
 *   - Replay starts at the first bar that OPENS at/after the fill (the fill bar's
 *     earlier range predates the entry).
 *   - Per bar, in order:
 *       open beyond the stop    → exit at the open      (hypothetical_gap_through_stop, R < −1)
 *       open beyond the target  → exit at the open      (hypothetical_target, at the open)
 *       range touches the stop  → exit at the stop      (hypothetical_stop)   ← wins a same-bar tie
 *       range touches the target→ exit at the target    (hypothetical_target)
 *   - Only FINAL bars are used: a bar counts once a scan ran ≥ 5 min after it
 *     closed (`lastObservationMs`). Bars first recorded within seconds of their
 *     close are revised by the next scan (670 of 686 revisions measured, ≤ 4.8
 *     pips); the latest revision of each bar is used.
 *   - A missing bar while the FX market is open → DEFERRED (nothing invented).
 *     Market closed (Fri 17:00 → Sun 17:00 New York) is not a gap.
 *   - No touch for HORIZON_DAYS of final bars → open_at_horizon, marked at the
 *     last final close.
 *   - R gross = ±(exit − fill) / |fill − stop|; R net = gross − costInPrice / |fill − stop|
 *     (spread + commission as estimated by the order R:R gate); P/L = R × the
 *     fill's recorded risk dollars.
 *   - `marginPips`: how far the decisive bar went past the level (or, for
 *     open_at_horizon, null). Small margins can flip under a later bar
 *     revision (late revisions measured ≤ 1.45 pips) — recorded, not hidden.
 */

export const OUTCOME_METHOD = "bar_replay_5m.v1";
export const HORIZON_DAYS = 14;
const BAR_MS = 5 * 60_000;
const FINAL_AFTER_CLOSE_MS = 5 * 60_000;

export interface Bar { t: number; o: number; h: number; l: number; c: number }

export interface HypotheticalInput {
  direction: "long" | "short";
  fillAtMs: number;
  fillPrice: number;
  stop: number;
  target: number;
  riskUsd: number | null;
  costInPrice: number | null;
  pipSize: number;
  bars: Bar[];               // latest revision per bar time, any order
  lastObservationMs: number; // newest first_seen_at for this symbol's bars
  nowMs: number;
  horizonDays?: number;
}

export type HypotheticalResult =
  | { status: "resolved"; exitReason: "hypothetical_stop" | "hypothetical_target" | "hypothetical_gap_through_stop" | "open_at_horizon";
      exitPrice: number; closedAtMs: number; barTimeMs: number; rGross: number; rNet: number | null; pnlUsd: number | null; pnlNetUsd: number | null;
      marginPips: number | null; barsReplayed: number }
  | { status: "pending"; reason: string; barsReplayed: number }
  | { status: "deferred"; gapStartMs: number; gapEndMs: number | null; reason: string; barsReplayed: number }
  | { status: "invalid"; reason: string };

const nyFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", hourCycle: "h23" });

/** FX market open at this instant (closed Fri 17:00 → Sun 17:00 New York). */
export function fxOpen(ms: number): boolean {
  const p = Object.fromEntries(nyFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const d = p.weekday, h = Number(p.hour);
  if (d === "Sat") return false;
  if (d === "Fri" && h >= 17) return false;
  if (d === "Sun" && h < 17) return false;
  return true;
}

export function resolveHypothetical(i: HypotheticalInput): HypotheticalResult {
  const risk = Math.abs(i.fillPrice - i.stop);
  const long = i.direction === "long";
  if (!(i.fillPrice > 0 && i.stop > 0 && i.target > 0 && risk > 0 && i.pipSize > 0) || !Number.isFinite(i.fillAtMs)) {
    return { status: "invalid", reason: "fill price, stop, target or fill time missing" };
  }
  if (long ? !(i.stop < i.fillPrice && i.target > i.fillPrice) : !(i.stop > i.fillPrice && i.target < i.fillPrice)) {
    return { status: "invalid", reason: "stop / target on the wrong side of the fill" };
  }
  const horizonMs = (i.horizonDays ?? HORIZON_DAYS) * 86_400_000;
  const finalCutoff = i.lastObservationMs - FINAL_AFTER_CLOSE_MS; // a bar is final if its close ≤ this
  const start = Math.ceil(i.fillAtMs / BAR_MS) * BAR_MS;
  const bars = [...i.bars].filter((b) => b.t >= start && b.t + BAR_MS <= finalCutoff).sort((a, b) => a.t - b.t);

  const r = (exit: number) => (long ? exit - i.fillPrice : i.fillPrice - exit) / risk;
  const done = (exitReason: "hypothetical_stop" | "hypothetical_target" | "hypothetical_gap_through_stop" | "open_at_horizon",
    exitPrice: number, b: Bar, closedAtMs: number, marginPips: number | null, n: number): HypotheticalResult => {
    const rGross = r(exitPrice);
    const rNet = i.costInPrice != null && Number.isFinite(i.costInPrice) ? rGross - i.costInPrice / risk : null;
    return {
      status: "resolved", exitReason, exitPrice, closedAtMs, barTimeMs: b.t, rGross, rNet,
      pnlUsd: i.riskUsd != null ? rGross * i.riskUsd : null,
      pnlNetUsd: i.riskUsd != null && rNet != null ? rNet * i.riskUsd : null,
      marginPips, barsReplayed: n,
    };
  };

  let expected = start;
  let n = 0;
  let last: Bar | null = null;
  for (const b of bars) {
    // every open-market slot between `expected` and this bar must be present
    for (let t = expected; t < b.t; t += BAR_MS) {
      if (fxOpen(t)) return { status: "deferred", gapStartMs: t, gapEndMs: b.t, reason: "missing 5m bar while the FX market was open", barsReplayed: n };
    }
    n++;
    last = b;
    const pip = i.pipSize;
    if (long) {
      if (b.o <= i.stop) return done("hypothetical_gap_through_stop", b.o, b, b.t, (i.stop - b.o) / pip, n);
      if (b.o >= i.target) return done("hypothetical_target", b.o, b, b.t, (b.o - i.target) / pip, n);
      if (b.l <= i.stop) return done("hypothetical_stop", i.stop, b, b.t + BAR_MS, (i.stop - b.l) / pip, n);
      if (b.h >= i.target) return done("hypothetical_target", i.target, b, b.t + BAR_MS, (b.h - i.target) / pip, n);
    } else {
      if (b.o >= i.stop) return done("hypothetical_gap_through_stop", b.o, b, b.t, (b.o - i.stop) / pip, n);
      if (b.o <= i.target) return done("hypothetical_target", b.o, b, b.t, (i.target - b.o) / pip, n);
      if (b.h >= i.stop) return done("hypothetical_stop", i.stop, b, b.t + BAR_MS, (b.h - i.stop) / pip, n);
      if (b.l <= i.target) return done("hypothetical_target", i.target, b, b.t + BAR_MS, (i.target - b.l) / pip, n);
    }
    if (b.t + BAR_MS - i.fillAtMs >= horizonMs) return done("open_at_horizon", b.c, b, b.t + BAR_MS, null, n);
    expected = b.t + BAR_MS;
  }
  // nothing decisive yet: is the data simply not final yet, or is a final slot missing?
  for (let t = expected; t + BAR_MS <= finalCutoff; t += BAR_MS) {
    if (fxOpen(t)) return { status: "deferred", gapStartMs: t, gapEndMs: null, reason: "missing 5m bar while the FX market was open", barsReplayed: n };
  }
  return { status: "pending", reason: last ? "no stop / target touch yet" : "no final bar after the fill yet", barsReplayed: n };
}
