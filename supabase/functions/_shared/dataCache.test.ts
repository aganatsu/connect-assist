/**
 * Tests for _shared/dataCache.ts — per-scan-cycle candle cache.
 *
 * Verifies:
 *   1. Cache hit: second call returns same data without re-fetching
 *   2. In-flight dedup: concurrent calls produce only one fetch
 *   3. Error caching: failed fetch returns empty array and doesn't retry
 *   4. clear() resets everything
 *   5. stats() reports correct hit/miss/error counts
 */

import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createScanCache } from "./dataCache.ts";
import type { Candle } from "./smcAnalysis.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeCandle(close: number): Candle {
  return { datetime: "2025-01-01T00:00:00Z", open: close, high: close + 1, low: close - 1, close, volume: 100 };
}

/** Creates a mock fetchCandles that tracks call count per key. */
function mockFetch() {
  const calls: string[] = [];
  const fn = async (symbol: string, interval: string, _range: string): Promise<Candle[]> => {
    calls.push(`${symbol}|${interval}`);
    // Simulate small network delay
    await new Promise((r) => setTimeout(r, 5));
    return [makeCandle(1.1000), makeCandle(1.1010)];
  };
  return { fn, calls };
}

/** Creates a mock that fails on the first call. */
function failingFetch() {
  const calls: string[] = [];
  const fn = async (symbol: string, interval: string, _range: string): Promise<Candle[]> => {
    calls.push(`${symbol}|${interval}`);
    throw new Error("API timeout");
  };
  return { fn, calls };
}

// ── Tests ────────────────────────────────────────────────────────────────

Deno.test("dataCache: cache hit returns same data without re-fetching", async () => {
  const { fn, calls } = mockFetch();
  const cache = createScanCache(fn);

  const first = await cache.get("EUR/USD", "1d", "1y");
  const second = await cache.get("EUR/USD", "1d", "1y");

  // Same reference — no copy, no re-fetch
  assertStrictEquals(first, second);
  // Only one fetch call
  assertEquals(calls.length, 1);
  assertEquals(calls[0], "EUR/USD|1d");
  // Stats
  assertEquals(cache.stats().misses, 1);
  assertEquals(cache.stats().hits, 1);
});

Deno.test("dataCache: different symbols are fetched independently", async () => {
  const { fn, calls } = mockFetch();
  const cache = createScanCache(fn);

  const eur = await cache.get("EUR/USD", "1d", "1y");
  const gbp = await cache.get("GBP/USD", "1d", "1y");

  assertEquals(calls.length, 2);
  assertEquals(eur.length, 2);
  assertEquals(gbp.length, 2);
});

Deno.test("dataCache: different intervals for same symbol are cached separately", async () => {
  const { fn, calls } = mockFetch();
  const cache = createScanCache(fn);

  await cache.get("EUR/USD", "1d", "1y");
  await cache.get("EUR/USD", "4h", "1mo");
  await cache.get("EUR/USD", "1d", "1y"); // cache hit

  assertEquals(calls.length, 2); // only 1d and 4h fetched
  assertEquals(cache.stats().hits, 1);
  assertEquals(cache.stats().misses, 2);
});

Deno.test("dataCache: concurrent calls deduplicate to one fetch", async () => {
  const { fn, calls } = mockFetch();
  const cache = createScanCache(fn);

  // Fire two requests concurrently for the same key
  const [a, b] = await Promise.all([
    cache.get("EUR/USD", "1d", "1y"),
    cache.get("EUR/USD", "1d", "1y"),
  ]);

  // Both get the same result
  assertStrictEquals(a, b);
  // Only one actual fetch
  assertEquals(calls.length, 1);
});

Deno.test("dataCache: failed fetch returns empty array and caches the failure", async () => {
  const { fn, calls } = failingFetch();
  const cache = createScanCache(fn);

  const result = await cache.get("EUR/USD", "1d", "1y");
  assertEquals(result, []); // empty array, not an exception

  // Second call should NOT retry — returns cached empty array
  const result2 = await cache.get("EUR/USD", "1d", "1y");
  assertEquals(result2, []);
  assertEquals(calls.length, 1); // only one fetch attempt

  assertEquals(cache.stats().errors, 1);
  assertEquals(cache.stats().hits, 1);
});

Deno.test("dataCache: clear() resets cache and stats", async () => {
  const { fn, calls } = mockFetch();
  const cache = createScanCache(fn);

  await cache.get("EUR/USD", "1d", "1y");
  assertEquals(cache.size(), 1);

  cache.clear();
  assertEquals(cache.size(), 0);
  assertEquals(cache.stats().hits, 0);
  assertEquals(cache.stats().misses, 0);

  // After clear, same key triggers a new fetch
  await cache.get("EUR/USD", "1d", "1y");
  assertEquals(calls.length, 2); // fetched again
});

Deno.test("dataCache: range parameter is ignored for cache key (same symbol+interval)", async () => {
  const { fn, calls } = mockFetch();
  const cache = createScanCache(fn);

  const a = await cache.get("EUR/USD", "1d", "1y");
  const b = await cache.get("EUR/USD", "1d", "6mo"); // different range, same key

  assertStrictEquals(a, b); // same cached result
  assertEquals(calls.length, 1); // only one fetch
});
