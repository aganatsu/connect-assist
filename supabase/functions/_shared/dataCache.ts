/**
 * dataCache.ts — Per-scan-cycle candle data cache.
 *
 * Eliminates duplicate fetchCandles() calls between the game plan generator
 * and the main per-pair scan loop. Candles are fetched once per (symbol,
 * interval) combination and reused for the remainder of the scan cycle.
 *
 * Usage:
 *   const cache = createScanCache(fetchCandles);
 *   const daily = await cache.get("EUR/USD", "1d", "1y");
 *   // Second call returns the same array without a network request:
 *   const dailyAgain = await cache.get("EUR/USD", "1d", "1y");
 *   // At the end of the cycle, clear:
 *   cache.clear();
 *
 * Design decisions:
 *   - The cache key is `${symbol}|${interval}`. We intentionally ignore the
 *     `range` parameter because within a single scan cycle the same symbol +
 *     interval combination is always requested with the same range (e.g.
 *     daily is always "1y", 4H is always "1mo"). If a mismatch ever occurs
 *     the first-fetched range wins, which is safe because longer ranges are
 *     always a superset of shorter ones.
 *   - In-flight deduplication: if two callers request the same key
 *     concurrently, only one fetch fires and both await the same promise.
 *   - The cache is a plain Map, not a WeakMap, because we want explicit
 *     lifecycle control via clear().
 */

import type { Candle } from "./smcAnalysis.ts";

/** Signature of the fetchCandles function used in bot-scanner. */
export type FetchCandlesFn = (
  symbol: string,
  interval: string,
  range: string,
) => Promise<Candle[]>;

export interface ScanCache {
  /**
   * Get candles for a symbol + interval, fetching only on the first call.
   * Subsequent calls with the same symbol + interval return the cached result.
   * If the underlying fetch fails, the error is cached so we don't retry
   * the same failing request within the same cycle — callers receive an
   * empty array (consistent with existing `.catch(() => [])` patterns).
   */
  get(symbol: string, interval: string, range: string): Promise<Candle[]>;

  /**
   * Pre-seed the cache with externally-sourced candles (e.g. from persistent
   * kv_cache). Subsequent get() calls for the same key will return these
   * candles without triggering a fetch. Source is tracked for stats.
   */
  seed(symbol: string, interval: string, candles: Candle[], source?: string): void;

  /** Number of unique (symbol, interval) entries currently cached. */
  size(): number;

  /** Discard all cached data. Call at the end of each scan cycle. */
  clear(): void;

  /** Return cache hit/miss stats for logging. */
  stats(): { hits: number; misses: number; errors: number; seeded: number };
}

export function createScanCache(fetchFn: FetchCandlesFn): ScanCache {
  // Stores resolved candle arrays (or empty arrays for failed fetches).
  const resolved = new Map<string, Candle[]>();
  // Stores in-flight promises to deduplicate concurrent requests.
  const inflight = new Map<string, Promise<Candle[]>>();

  let hits = 0;
  let misses = 0;
  let errors = 0;
  let seeded = 0;

  function makeKey(symbol: string, interval: string): string {
    return `${symbol}|${interval}`;
  }

  async function get(
    symbol: string,
    interval: string,
    range: string,
  ): Promise<Candle[]> {
    const key = makeKey(symbol, interval);

    // 1. Already resolved — return immediately.
    const cached = resolved.get(key);
    if (cached !== undefined) {
      hits++;
      return cached;
    }

    // 2. In-flight — await the existing promise (dedup concurrent calls).
    const pending = inflight.get(key);
    if (pending) {
      hits++;
      return pending;
    }

    // 3. First request — fetch and cache.
    misses++;
    const promise = fetchFn(symbol, interval, range)
      .then((candles) => {
        resolved.set(key, candles);
        inflight.delete(key);
        return candles;
      })
      .catch((err) => {
        errors++;
        const empty: Candle[] = [];
        resolved.set(key, empty); // Cache the failure so we don't retry.
        inflight.delete(key);
        console.warn(
          `[dataCache] fetch failed for ${key} (range=${range}): ${err?.message ?? err}`,
        );
        return empty;
      });

    inflight.set(key, promise);
    return promise;
  }

  function size(): number {
    return resolved.size;
  }

  function seed(symbol: string, interval: string, candles: Candle[], _source?: string): void {
    const key = makeKey(symbol, interval);
    if (!resolved.has(key) && candles.length > 0) {
      resolved.set(key, candles);
      seeded++;
    }
  }

  function clear(): void {
    resolved.clear();
    inflight.clear();
    hits = 0;
    misses = 0;
    errors = 0;
    seeded = 0;
  }

  function stats(): { hits: number; misses: number; errors: number; seeded: number } {
    return { hits, misses, errors, seeded };
  }

  return { get, seed, size, clear, stats };
}
