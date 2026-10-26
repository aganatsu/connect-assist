// Canonical 5m bars for the Impulse-on-V3 shadow (owner decision 2026-10-26, option A). PURE — no database, no clock.
//
// Same rules as the canonical 1H store (canonicalBars.ts, decision D9 as amended), on the 5m grid:
//   - the canonical bar is the FIRST valid observation made at least 15 minutes after the bar's close; earlier observations never
//     become canonical; later differing observations are revision telemetry only (append-only, first wins);
//   - all six pairs rounded to 5 decimal places; FX hours = the frozen V3.2c rule (fxOpenNY of the bar's hour).
// Why a separate store: smc_scan_bars records 5m bars only when a pair reaches the zone stage, so a third of bars are first recorded
// more than an hour after their close (measured 2026-10-26: p75 100–195 min, p90 ≈ 11 h). This store is written from the 5m candles
// bot-scanner already fetches every scan for every pair (zero provider calls), so bars are canonical about 20–30 minutes after close.
// Rows reuse canonicalBars' CanonicalRow / Evaluation / planWrites (source 'scanner_live').
import { fxOpenNY, roundToGrid, SETTLE_MS, STRUCTURE_PAIRS, valueHash, type Evaluation, type Observation } from "./canonicalBars.ts";

export const M5_MS = 300_000;

/** Classify one 5m observation (same order as the 1H rule: identity → geometry → timing → OHLC; no ownership spans). */
export function evaluateObservation5m(obs: Observation): Evaluation {
  const known = STRUCTURE_PAIRS.includes(obs.symbol as typeof STRUCTURE_PAIRS[number]);
  const [o, h, l, c] = known ? [obs.o, obs.h, obs.l, obs.c].map((v) => roundToGrid(obs.symbol, v)) : [obs.o, obs.h, obs.l, obs.c];
  const hash = valueHash(obs.symbol, o, h, l, c);
  const reject = (reason: Extract<Evaluation, { kind: "rejected" }>["reason"]): Evaluation => ({ kind: "rejected", reason, obs, hash });
  if (!known) return reject("unknown_symbol");
  if (![obs.o, obs.h, obs.l, obs.c, obs.barTime, obs.observedAt].every(Number.isFinite)) return reject("ohlc_inconsistent");
  if (obs.barTime % M5_MS !== 0) return reject("off_grid");
  if (!fxOpenNY(Math.floor(obs.barTime / 3_600_000) * 3_600_000)) return reject("outside_fx_hours");
  if (obs.observedAt < obs.barTime + M5_MS) return reject("not_closed");
  if (obs.observedAt < obs.barTime + M5_MS + SETTLE_MS) return reject("not_settled");
  if (!(h >= Math.max(o, c) && l <= Math.min(o, c) && h >= l)) return reject("ohlc_inconsistent");
  return {
    kind: "candidate", hash,
    row: { symbol: obs.symbol, bar_time: new Date(obs.barTime).toISOString(), open: o, high: h, low: l, close: c, provider: obs.provider, source: "scanner_live", source_ref: null, observed_at: new Date(obs.observedAt).toISOString() },
  };
}
