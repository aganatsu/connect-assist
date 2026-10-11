// §8 — ForexFactory snapshot validation, feed availability and news blocks.
import { newsWeekOf } from "./calendar.ts";
import { baseQuote, FEED_MAX_AGE_MS, NEWS_BLOCK_MS, type Pair } from "./spec.ts";

export interface NewsFetch {
  fetchTime: number;     // ms UTC
  httpStatus: number;
  body: unknown;         // parsed JSON body (or undefined when not parseable)
}
export interface NewsEvent { title: string; country: string; date: number; impact: string }
export interface Snapshot { ok: boolean; weekId: string; events: NewsEvent[]; reason?: string }

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2}|Z)$/;

/** §8.2–8.3 schema + week validation of one fetch. */
export function validate(f: NewsFetch): Snapshot {
  const week = newsWeekOf(f.fetchTime);
  const fail = (reason: string): Snapshot => ({ ok: false, weekId: week.id, events: [], reason });
  if (f.httpStatus !== 200) return fail("http");
  if (!Array.isArray(f.body)) return fail("schema");
  const events: NewsEvent[] = [];
  for (const e of f.body as unknown[]) {
    if (!e || typeof e !== "object") return fail("schema");
    const r = e as Record<string, unknown>;
    if (typeof r.title !== "string" || typeof r.country !== "string" || typeof r.impact !== "string" || typeof r.date !== "string") {
      return fail("schema");
    }
    if (!ISO_WITH_OFFSET.test(r.date)) return fail("schema");
    const date = Date.parse(r.date);
    if (!Number.isFinite(date) || date < week.from || date >= week.to) return fail("schema");
    events.push({ title: r.title, country: r.country, impact: r.impact, date });
  }
  return { ok: true, weekId: week.id, events };
}

export type Feed = { available: true; events: NewsEvent[] } | { available: false };

/** §8.2 feed state at decision time t for an evaluation run at wall-clock `runTime`. */
export function feedAt(fetches: NewsFetch[], t: number, runTime: number): Feed {
  let latest: NewsFetch | null = null;
  for (const f of fetches) if (f.fetchTime <= runTime && (!latest || f.fetchTime > latest.fetchTime)) latest = f;
  if (!latest || runTime - latest.fetchTime > FEED_MAX_AGE_MS) return { available: false };
  const snap = validate(latest);
  if (!snap.ok) return { available: false };
  const week = newsWeekOf(latest.fetchTime);
  if (t < week.from || t >= week.to) return { available: false };
  return { available: true, events: snap.events };
}

/** §8.1 a high-impact event for the pair's base or quote currency within ±30 minutes of t. */
export function newsBlock(pair: Pair, events: NewsEvent[], t: number): boolean {
  const [b, q] = baseQuote(pair);
  return events.some((e) => e.impact === "High" && (e.country === b || e.country === q) && Math.abs(t - e.date) <= NEWS_BLOCK_MS);
}
