/**
 * candleCache.ts — Persistent candle cache for slow-changing timeframes.
 *
 * Daily candles only change at market close (~22:00 UTC). Weekly candles
 * change once per week. Caching these in the `kv_cache` table between
 * scan invocations saves ~34 TwelveData API calls per cycle (17 daily +
 * 17 weekly), keeping total requests well within the 50/min rate limit.
 *
 * Storage: Supabase `kv_cache` table (same as FOTSI cache).
 * Fallback: If cache read fails, returns null → caller fetches fresh.
 *
 * Key format: `candles:{symbol}:{interval}` (e.g. `candles:EUR/USD:1d`)
 * TTL: 1 hour for daily, 6 hours for weekly (conservative — both change
 *      far less frequently, but shorter TTL ensures freshness after close).
 */

import type { Candle } from "./smcAnalysis.ts";

const DAILY_CACHE_TTL_MS = 60 * 60 * 1000;    // 1 hour
const WEEKLY_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function cacheKey(symbol: string, interval: string): string {
  return `candles:${symbol}:${interval}`;
}

/**
 * Read cached candles from kv_cache. Returns null on miss/expired/error.
 */
export async function getCachedCandles(
  supabase: any,
  symbol: string,
  interval: string,
): Promise<Candle[] | null> {
  try {
    const key = cacheKey(symbol, interval);
    const { data, error } = await supabase
      .from("kv_cache")
      .select("value, expires_at")
      .eq("key", key)
      .single();

    if (error || !data) return null;

    const now = Date.now();
    const expiresAt = new Date(data.expires_at).getTime();
    if (now >= expiresAt) return null;

    const parsed = JSON.parse(data.value);
    if (!Array.isArray(parsed) || parsed.length < 30) return null;

    return parsed as Candle[];
  } catch {
    return null;
  }
}

/**
 * Store candles in kv_cache with appropriate TTL.
 */
export async function setCachedCandles(
  supabase: any,
  symbol: string,
  interval: string,
  candles: Candle[],
): Promise<void> {
  try {
    if (!candles || candles.length < 30) return; // Don't cache empty/insufficient data

    const key = cacheKey(symbol, interval);
    const now = Date.now();
    const ttl = interval.includes("w") ? WEEKLY_CACHE_TTL_MS : DAILY_CACHE_TTL_MS;
    const expiresAt = now + ttl;

    await supabase
      .from("kv_cache")
      .upsert({
        key,
        value: JSON.stringify(candles),
        expires_at: new Date(expiresAt).toISOString(),
        updated_at: new Date(now).toISOString(),
      }, { onConflict: "key" });
  } catch {
    // Cache write failure is non-critical
  }
}

/**
 * Batch-read multiple candle cache entries in a single DB query.
 * Returns a Map of `symbol:interval` → Candle[].
 * Missing/expired entries are simply omitted from the result.
 */
export async function batchGetCachedCandles(
  supabase: any,
  requests: Array<{ symbol: string; interval: string }>,
): Promise<Map<string, Candle[]>> {
  const result = new Map<string, Candle[]>();
  if (requests.length === 0) return result;

  try {
    const keys = requests.map(r => cacheKey(r.symbol, r.interval));
    const { data, error } = await supabase
      .from("kv_cache")
      .select("key, value, expires_at")
      .in("key", keys);

    if (error || !data) return result;

    const now = Date.now();
    for (const row of data) {
      const expiresAt = new Date(row.expires_at).getTime();
      if (now >= expiresAt) continue;

      try {
        const candles = JSON.parse(row.value);
        if (Array.isArray(candles) && candles.length >= 30) {
          // Strip the "candles:" prefix to get "symbol:interval"
          const mapKey = row.key.replace("candles:", "");
          result.set(mapKey, candles);
        }
      } catch {
        // Skip malformed entries
      }
    }
  } catch {
    // Batch read failure — return empty, caller will fetch fresh
  }

  return result;
}

/**
 * Batch-write multiple candle cache entries.
 * Uses individual upserts (kv_cache doesn't support bulk upsert well
 * with the onConflict pattern). Fires and forgets — non-blocking.
 */
export async function batchSetCachedCandles(
  supabase: any,
  entries: Array<{ symbol: string; interval: string; candles: Candle[] }>,
): Promise<void> {
  const now = Date.now();
  const upserts = entries
    .filter(e => e.candles && e.candles.length >= 30)
    .map(e => {
      const ttl = e.interval.includes("w") ? WEEKLY_CACHE_TTL_MS : DAILY_CACHE_TTL_MS;
      return {
        key: cacheKey(e.symbol, e.interval),
        value: JSON.stringify(e.candles),
        expires_at: new Date(now + ttl).toISOString(),
        updated_at: new Date(now).toISOString(),
      };
    });

  if (upserts.length === 0) return;

  try {
    // Batch upsert in chunks of 10 to avoid payload limits
    for (let i = 0; i < upserts.length; i += 10) {
      const chunk = upserts.slice(i, i + 10);
      await supabase
        .from("kv_cache")
        .upsert(chunk, { onConflict: "key" });
    }
  } catch {
    // Non-critical — next cycle will re-fetch
  }
}
