// The canonical 5m presence rule, shared by the V3 shadow and the breaker shadow. Kept apart from shadowRun.ts so a runner can use it
// without reaching the V3.2c engine (structureArchitecture.test.ts).
import { fxOpenNY } from "../structure/canonicalBars.ts";
import type { Bar } from "./shadowEngine.ts";

/** A 5m bar counts only if its canonical value was observed within this long after its close; otherwise it is a data gap. */
export const M5_MISSING_AFTER_MS = 60 * 60_000;
/** Extra wait before declaring a bar missing, so a scan that observed it in time but is still writing is not raced. */
export const M5_WRITE_GRACE_MS = 5 * 60_000;
const H = 3_600_000, M5 = 300_000;

/**
 * The shadow's 5m bars from the canonical 5m store (structure_bars_5m: first settled observation wins, values never change).
 * Deterministic: a bar is PRESENT iff its canonical value was observed within M5_MISSING_AFTER_MS of its close, so a later replay
 * (the audit) sees exactly what the hourly run saw. `processUntil` stops processing before the first FX-open slot (from `fromMs`)
 * that is not final yet: absent but still inside the window (+ write grace). Older absent slots are data gaps.
 */
export function canonical5m(rows: { bar_time: string; open: number; high: number; low: number; close: number; observed_at: string }[], nowMs: number, fromMs: number): { bars: Bar[]; processUntil: number } {
  const bars: Bar[] = [];
  for (const r of rows) {
    const t = Date.parse(r.bar_time);
    if (Date.parse(r.observed_at) > t + M5 + M5_MISSING_AFTER_MS) continue;
    bars.push({ t, o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close) });
  }
  bars.sort((a, b) => a.t - b.t);
  const have = new Set(bars.map((b) => b.t));
  let processUntil = nowMs - 60_000;
  for (let t = Math.floor(fromMs / M5) * M5; t + M5 <= processUntil; t += M5) {
    if (!fxOpenNY(Math.floor(t / H) * H) || have.has(t)) continue;
    if (nowMs < t + M5 + M5_MISSING_AFTER_MS + M5_WRITE_GRACE_MS) { processUntil = t + M5 - 1; break; } // may still arrive: wait
  }
  return { bars, processUntil };
}
