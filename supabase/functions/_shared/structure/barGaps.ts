// Gap classification for canonical 1H structure bars — DATA-QUALITY MONITORING ONLY (D21 / D27).
// It labels missing FX-open hours; it never synthesizes, forward-fills or changes bucket completeness. If the frozen
// V3.2c aggregation skips an incomplete Daily / 4H bucket, it stays skipped.
//
// CALENDAR STATUS: PROVISIONAL. The 2025/26 rows are the provider absences observed in the approved history
// (docs/V3_2C_HISTORY_AUDIT_V1.md); the 2026/27 rows are the V2.1.1 calendar's explicit closures. Holiday rows must be
// cross-checked against an external published FX holiday schedule before the calendar is frozen (PR2 merge gate).
import { EPOCH_MS, fxOpenNY, H1_MS } from "./canonicalBars.ts";

export const CALENDAR_STATUS = "provisional: holiday rows pending external cross-check (D27)";
export type GapClass = "holiday_closure" | "provider_absence" | "data_gap";

const u = (s: string) => Date.parse(s);
/** Whole-market closures [from, to) in UTC. */
export const HOLIDAY_CLOSURES: ReadonlyArray<{ name: string; fromMs: number; toMs: number; basis: string }> = [
  { name: "Christmas 2025", fromMs: u("2025-12-24T13:00:00Z"), toMs: u("2025-12-25T13:00:00Z"), basis: "observed provider absence (history audit)" },
  { name: "New Year 2026", fromMs: u("2025-12-31T13:00:00Z"), toMs: u("2026-01-01T13:00:00Z"), basis: "observed provider absence (history audit)" },
  // V2.1.1 calendar (EXPLICIT_CLOSURES, America/New_York 17:00 → 17:00); unverified against the provider until observed
  { name: "Christmas 2026", fromMs: u("2026-12-24T22:00:00Z"), toMs: u("2026-12-27T22:00:00Z"), basis: "V2.1.1 calendar" },
  { name: "New Year 2027", fromMs: u("2026-12-31T22:00:00Z"), toMs: u("2027-01-03T22:00:00Z"), basis: "V2.1.1 calendar" },
];
/** Recurring provider absence: Sunday 17:00–19:00 New York in these DST spans (21:00 and 22:00 UTC bars missing). */
export const PROVIDER_ABSENT_SUNDAYS: ReadonlyArray<{ fromMs: number; toMs: number; utcHours: readonly number[] }> = [
  { fromMs: u("2025-04-06T00:00:00Z"), toMs: u("2025-09-29T00:00:00Z"), utcHours: [21, 22] },
];

export function classifyMissingHour(t: number): GapClass {
  if (HOLIDAY_CLOSURES.some((c) => t >= c.fromMs && t < c.toMs)) return "holiday_closure";
  const d = new Date(t);
  if (d.getUTCDay() === 0 && PROVIDER_ABSENT_SUNDAYS.some((w) => t >= w.fromMs && t < w.toMs && w.utcHours.includes(d.getUTCHours()))) return "provider_absence";
  return "data_gap";
}

/** Every expected FX-open hour in [fromMs, toMs) with no canonical bar, classified. Hours before the epoch are ignored. */
export function classifyGaps(barTimesMs: Iterable<number>, fromMs: number, toMs: number): { t: number; class: GapClass }[] {
  const have = new Set(barTimesMs), out: { t: number; class: GapClass }[] = [];
  for (let t = Math.ceil(Math.max(fromMs, EPOCH_MS) / H1_MS) * H1_MS; t < toMs; t += H1_MS) {
    if (fxOpenNY(t) && !have.has(t)) out.push({ t, class: classifyMissingHour(t) });
  }
  return out;
}
