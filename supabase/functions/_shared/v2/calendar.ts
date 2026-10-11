// §0.8, §0.9, §0.11, §1.1, §1.2 — V2 calendar on the IANA America/New_York zone.
// Deliberately does NOT use sessions.ts toNYTime/isFxClosedAt (spec 0.11: wrong March DST switch).

const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
});
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface NYParts { y: number; mo: number; d: number; h: number; mi: number; dow: number; minOfDay: number }

const cache = new Map<number, NYParts>();
export function nyParts(ms: number): NYParts {
  const hit = cache.get(ms);
  if (hit) return hit;
  const p: Record<string, string> = {};
  for (const x of NY.formatToParts(new Date(ms))) p[x.type] = x.value;
  const r: NYParts = {
    y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, dow: DOW[p.weekday],
    minOfDay: +p.hour * 60 + +p.minute,
  };
  if (cache.size > 500_000) cache.clear();
  cache.set(ms, r);
  return r;
}

/** UTC instant of a New York wall-clock time (exists and is unambiguous for every time V2 uses). */
export function nyLocalToUtc(y: number, mo: number, d: number, h: number, mi: number): number {
  for (const off of [5, 4]) {
    const t = Date.UTC(y, mo - 1, d, h + off, mi);
    const p = nyParts(t);
    if (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi) return t;
  }
  throw new Error(`no unique UTC instant for NY ${y}-${mo}-${d} ${h}:${mi}`);
}

/** §1.1 weekly FX closure: Friday 17:00 → Sunday 17:00 America/New_York. */
export function inWeeklyClosure(ms: number): boolean {
  const p = nyParts(ms);
  if (p.dow === 6) return true;
  if (p.dow === 0 && p.h < 17) return true;
  if (p.dow === 5 && p.h >= 17) return true;
  return false;
}

/** §1.1 explicit closures (America/New_York wall clock). */
export const EXPLICIT_CLOSURES: ReadonlyArray<{ name: string; from: number; to: number }> = [
  { name: "Christmas 2026", from: nyLocalToUtc(2026, 12, 24, 17, 0), to: nyLocalToUtc(2026, 12, 27, 17, 0) },
  { name: "New Year 2027", from: nyLocalToUtc(2026, 12, 31, 17, 0), to: nyLocalToUtc(2027, 1, 3, 17, 0) },
];

/** §1.1 an interval with open time `openMs` is EXPECTED. */
export function isExpected(openMs: number): boolean {
  if (inWeeklyClosure(openMs)) return false;
  for (const c of EXPLICIT_CLOSURES) if (openMs >= c.from && openMs < c.to) return false;
  return true;
}

/** §0.8 decision time inside [02:00, 12:00) NY on a Monday–Friday (NY date of the bar close). */
export function inTradingWindow(decisionMs: number): boolean {
  const p = nyParts(decisionMs);
  return p.dow >= 1 && p.dow <= 5 && p.minOfDay >= 120 && p.minOfDay < 720;
}

/** §0.9 NY trading day 17:00:00 → 16:59:59, labelled by its end date (YYYY-MM-DD). */
export function tradingDayOf(ms: number): string {
  const p = nyParts(ms);
  const base = Date.UTC(p.y, p.mo - 1, p.d + (p.h >= 17 ? 1 : 0));
  return new Date(base).toISOString().slice(0, 10);
}

/** Start instant (17:00 NY of the previous calendar day) of a trading day label. */
export function tradingDayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return nyLocalToUtc(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 17, 0);
}

/** §7.1c the 5m interval opening at `openMs` lies in [20:00, 02:00) NY. */
export function inAsianRange(openMs: number): boolean {
  const m = nyParts(openMs).minOfDay;
  return m >= 20 * 60 || m < 2 * 60;
}

/** 02:00 NY on the end date of a trading day. */
export function asianEnd(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return nyLocalToUtc(y, m, d, 2, 0);
}

/** §8.2 news week: Sunday 00:00 → next Sunday 00:00 NY containing `ms`; identified by that Sunday's date. */
export function newsWeekOf(ms: number): { id: string; from: number; to: number } {
  const p = nyParts(ms);
  const sun = new Date(Date.UTC(p.y, p.mo - 1, p.d - p.dow));
  const next = new Date(Date.UTC(p.y, p.mo - 1, p.d - p.dow + 7));
  return {
    id: sun.toISOString().slice(0, 10),
    from: nyLocalToUtc(sun.getUTCFullYear(), sun.getUTCMonth() + 1, sun.getUTCDate(), 0, 0),
    to: nyLocalToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0),
  };
}
