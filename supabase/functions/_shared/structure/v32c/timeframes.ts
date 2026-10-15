// Timeframe plumbing for the V3 research harness: NY-aligned bars from stored 1H data, plus read-only as-of snapshots.
// All alignment uses the IANA zone America/New_York (Intl), independent of the repo's calendar code.
//   Daily = NY trading day 17:00 → 17:00, labelled by its end date.
//   4H    = the trading day split at 17:00, 21:00, 01:00, 05:00, 09:00, 13:00 NY.
//   FX session: closed Fri 17:00 → Sun 17:00 NY.
// Only COMPLETE buckets (24 / 4 hourly bars) are emitted. A bucket is known at its close time (the end of its last hour).
import { freezeDeep, premiumDiscount, type Bar, type State } from "./engine.ts";
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short" });
export function nyParts(t: number) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, wd: p.weekday as string };
}
export const fxOpen = (t: number) => { const { h, wd } = nyParts(t); return !(wd === "Sat" || (wd === "Fri" && h >= 17) || (wd === "Sun" && h < 17)); };
export function tradingDay(t: number) { const { y, m, d, h } = nyParts(t); const dt = new Date(Date.UTC(y, m - 1, d + (h >= 17 ? 1 : 0))); return dt.toISOString().slice(0, 10); }
export function bucketKey(tf: "1H" | "4H" | "D", t: number) {
  if (tf === "1H") return String(t);
  if (tf === "D") return tradingDay(t);
  const { h } = nyParts(t); const k = Math.floor((((h - 17) % 24) + 24) % 24 / 4); return `${tradingDay(t)}#${k}`;
}
export const expectedHours = { "1H": 1, "4H": 4, D: 24 } as const;
export type H1 = { t: number; o: number; h: number; l: number; c: number };
// aggregate hourly bars into complete buckets; returns the bars and the number of incomplete buckets skipped
export function aggregate(tf: "1H" | "4H" | "D", hours: H1[]): { bars: Bar[]; skipped: { key: string; hours: number }[] } {
  const groups = new Map<string, H1[]>();
  for (const b of hours) { const k = bucketKey(tf, b.t); (groups.get(k) ?? groups.set(k, []).get(k)!).push(b); }
  const bars: Bar[] = [], skipped: { key: string; hours: number }[] = [];
  for (const [key, xs] of groups) {
    if (xs.length !== expectedHours[tf]) { skipped.push({ key, hours: xs.length }); continue; }
    xs.sort((a, b) => a.t - b.t);
    bars.push({ t: xs[0].t, closeTime: xs.at(-1)!.t + 3_600_000, o: xs[0].o, h: Math.max(...xs.map((x) => x.h)), l: Math.min(...xs.map((x) => x.l)), c: xs.at(-1)!.c });
  }
  bars.sort((a, b) => a.t - b.t);
  return { bars, skipped };
}
// read-only snapshot store: everything a lower timeframe may read about a higher one, deep-frozen, keyed by knownAt
export type Snapshot = Readonly<{ tf: string; knownAt: number; barIndex: number; trend: string | null; P: unknown; F: unknown; stack: unknown; pending: unknown; pd: unknown }>;
export class SnapshotStore {
  private xs: Snapshot[] = [];
  constructor(readonly tf: string) {}
  record(s: State) {
    const b = s.bars.at(-1)!;
    this.xs.push(freezeDeep(structuredClone({ tf: this.tf, knownAt: b.closeTime, barIndex: s.bars.length - 1, trend: s.trend, P: s.P, F: s.F, stack: s.stack, pending: s.pending, pd: premiumDiscount(s) })));
  }
  // the state after the last bar CLOSED at or before t (a forming bar is never visible)
  asOf(t: number): Snapshot | null { let lo = 0, hi = this.xs.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (this.xs[m].knownAt <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r < 0 ? null : this.xs[r]; }
  get length() { return this.xs.length; }
  at(i: number) { return this.xs[i]; }
}
