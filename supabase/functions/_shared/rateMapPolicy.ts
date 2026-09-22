/**
 * FX conversion-rate policy: which pairs are needed, and what to use when a
 * fetch fails. PURE — no database, no network, no clock of its own.
 *
 * THE PROBLEM THIS FIXES. `getQuoteToUSDRate` falls back to `FALLBACK_RATES`
 * whenever the live rate is missing. Those constants are hardcoded and badly
 * stale — measured 2026-09-22: USD/JPY 142.0 against a live 157.59 (−9.89%),
 * USD/CHF 0.88 against 0.82211 (+7.04%), USD/CAD 1.36 against 1.40727 (−3.36%).
 * Lot size scales linearly with that error, so a refused fetch silently sizes a
 * $1,000-risk trade ~$99 wrong. The scanner currently refuses around 44 fetches
 * per full scan, so this is a live exposure, not a hypothetical.
 *
 * By contrast an hour-old *observed* rate is wrong by at most 0.149% — measured
 * over the same session. So the fix is a last-known-good cache: a stale
 * observation beats a constant from a previous currency regime by roughly 66×.
 *
 * ORDER OF PREFERENCE, and nothing else is allowed to jump the queue:
 *
 *   LIVE            a valid rate fetched this cycle
 *   CACHED_STALE    the most recent rate previously observed, with its age
 *   STATIC_FALLBACK no rate has EVER been observed for this pair
 *
 * HOW STATIC_FALLBACK IS REACHED IS DELIBERATE. This module does not know the
 * constants and never substitutes them. When it has nothing, it OMITS the pair
 * from the rate map, and `getQuoteToUSDRate`'s own existing fallback branch
 * fires unchanged. That keeps the sizing formula and its fallback path exactly
 * as they were — this module only decides what goes into the map.
 *
 * WHAT IT DOES NOT DO. It does not change lot sizing, portfolio heat,
 * effectiveRR, commission conversion or P&L. It does not skip a fetch: the
 * cache is a fallback, not a TTL. And it has nothing to do with
 * `open_position_price_refresh`, which drives SL/TP detection and must stay
 * live.
 *
 * NO AGE CAP, DELIBERATELY. A month-old observation is still closer to spot
 * than a three-year-old constant, so refusing it would make things worse. The
 * age is recorded and surfaced instead, so a human can see a rate going stale
 * rather than having the decision made silently for them.
 */

import { QUOTE_CONVERSION } from "./smcAnalysis.ts";

export type RateSource = "LIVE" | "CACHED_STALE" | "STATIC_FALLBACK";

export interface CachedRate {
  rate: number;
  /** ISO timestamp of the observation this rate came from. */
  at: string;
}

export type RateCache = Record<string, CachedRate>;

export interface RateProvenance {
  pair: string;
  source: RateSource;
  /** Milliseconds since the observation. 0 for LIVE, null when never observed. */
  ageMs: number | null;
  rate: number | null;
}

export interface ResolvedRates {
  /** Fed to `getQuoteToUSDRate` unchanged. A pair is ABSENT when it has no rate. */
  rateMap: Record<string, number>;
  provenance: RateProvenance[];
  /** The cache to persist: previous entries plus anything observed live. */
  nextCache: RateCache;
  /** True when any pair fell back. Worth logging loudly. */
  degraded: boolean;
}

const valid = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Which conversion pairs the enabled instruments can actually consult.
 *
 * Derived, never hardcoded. `getQuoteToUSDRate` returns 1.0 without reading the
 * map whenever the QUOTE currency is USD, so a book of USD-quoted pairs needs no
 * rates at all. Measured on the live config: of six pairs fetched every minute,
 * only three were reachable — GBP/USD, AUD/USD and NZD/USD are consultable only
 * via crosses like EUR/GBP, none of which were enabled. That was 4,320
 * requests/day whose value nothing read.
 *
 * Deriving it means enabling such a cross automatically starts fetching its
 * rate, and disabling it automatically stops.
 */
export function requiredRatePairs(instruments: readonly string[]): string[] {
  const needed = new Set<string>();
  for (const symbol of instruments) {
    const parts = String(symbol).split("/");
    if (parts.length !== 2) continue;
    const quote = parts[1];
    if (quote === "USD") continue;          // getQuoteToUSDRate short-circuits to 1.0
    const conv = QUOTE_CONVERSION[quote];
    if (conv) needed.add(conv.pair);
  }
  return [...needed].sort();
}

export function parseRateCache(value: string | null | undefined): RateCache {
  if (!value) return {};
  try {
    const c = JSON.parse(value) as RateCache;
    if (!c || typeof c !== "object") return {};
    const out: RateCache = {};
    for (const [pair, e] of Object.entries(c)) {
      if (e && valid(e.rate) && typeof e.at === "string") out[pair] = { rate: e.rate, at: e.at };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Applies the preference order to one cycle's fetch results.
 *
 * `live` holds whatever this cycle actually got — a pair may be absent because
 * the fetch was refused, timed out, or returned no candles. Those are the same
 * case here: no usable rate.
 */
export function resolveRates(
  required: readonly string[],
  live: Record<string, number>,
  cache: RateCache,
  nowMs: number,
): ResolvedRates {
  const rateMap: Record<string, number> = {};
  const provenance: RateProvenance[] = [];
  const nextCache: RateCache = { ...cache };
  let degraded = false;

  for (const pair of required) {
    const l = live[pair];
    if (valid(l)) {
      rateMap[pair] = l;
      nextCache[pair] = { rate: l, at: new Date(nowMs).toISOString() };
      provenance.push({ pair, source: "LIVE", ageMs: 0, rate: l });
      continue;
    }

    const c = cache[pair];
    if (c && valid(c.rate)) {
      rateMap[pair] = c.rate;
      degraded = true;
      provenance.push({
        pair, source: "CACHED_STALE",
        ageMs: Math.max(0, nowMs - new Date(c.at).getTime()),
        rate: c.rate,
      });
      continue;
    }

    // Nothing observed, ever. Leave the pair OUT of the map so the existing
    // FALLBACK_RATES branch inside getQuoteToUSDRate handles it — this module
    // must not carry a second copy of those constants.
    degraded = true;
    provenance.push({ pair, source: "STATIC_FALLBACK", ageMs: null, rate: null });
  }

  return { rateMap, provenance, nextCache, degraded };
}

/** Compact one-line summary for a scan log. */
export function describeProvenance(p: readonly RateProvenance[]): string {
  return p.map((x) =>
    x.source === "LIVE" ? `${x.pair}=LIVE`
    : x.source === "CACHED_STALE" ? `${x.pair}=CACHED(${Math.round((x.ageMs ?? 0) / 60000)}m)`
    : `${x.pair}=STATIC`
  ).join(" ");
}

export const rateCacheKey = (userId: string, botId: string) =>
  `smc_rate_cache:${botId}:${userId}`;
