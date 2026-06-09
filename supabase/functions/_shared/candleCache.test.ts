/**
 * candleCache.test.ts — Tests for persistent candle cache (kv_cache backed).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getCachedCandles, setCachedCandles, batchGetCachedCandles, batchSetCachedCandles } from "./candleCache.ts";

// ── Mock Supabase client ──
function createMockSupabase() {
  const store = new Map<string, { value: string; expires_at: string }>();

  return {
    store,
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(col: string, val: string) {
              return {
                single() {
                  const entry = store.get(val);
                  if (!entry) return { data: null, error: { message: "not found" } };
                  return { data: { key: val, value: entry.value, expires_at: entry.expires_at }, error: null };
                },
              };
            },
            in(_col: string, keys: string[]) {
              const results = keys
                .filter(k => store.has(k))
                .map(k => ({ key: k, ...store.get(k)! }));
              return { data: results, error: null };
            },
          };
        },
        upsert(data: any | any[], _opts?: any) {
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            store.set(item.key, { value: item.value, expires_at: item.expires_at });
          }
          return { error: null };
        },
      };
    },
  };
}

const mockCandles = Array.from({ length: 50 }, (_, i) => ({
  time: `2026-01-${String(i + 1).padStart(2, "0")}`,
  open: 1.08 + i * 0.001,
  high: 1.085 + i * 0.001,
  low: 1.075 + i * 0.001,
  close: 1.082 + i * 0.001,
  volume: 1000 + i * 10,
}));

Deno.test("setCachedCandles stores candles in kv_cache", async () => {
  const supabase = createMockSupabase();
  await setCachedCandles(supabase, "EUR/USD", "1d", mockCandles as any);
  assertEquals(supabase.store.has("candles:EUR/USD:1d"), true);
});

Deno.test("getCachedCandles returns candles when not expired", async () => {
  const supabase = createMockSupabase();
  await setCachedCandles(supabase, "EUR/USD", "1d", mockCandles as any);
  const result = await getCachedCandles(supabase, "EUR/USD", "1d");
  assertEquals(result?.length, 50);
  assertEquals(result?.[0].open, mockCandles[0].open);
});

Deno.test("getCachedCandles returns null for expired entries", async () => {
  const supabase = createMockSupabase();
  // Manually insert an expired entry
  supabase.store.set("candles:GBP/USD:1d", {
    value: JSON.stringify(mockCandles),
    expires_at: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
  });
  const result = await getCachedCandles(supabase, "GBP/USD", "1d");
  assertEquals(result, null);
});

Deno.test("getCachedCandles returns null for missing entries", async () => {
  const supabase = createMockSupabase();
  const result = await getCachedCandles(supabase, "AUD/USD", "1d");
  assertEquals(result, null);
});

Deno.test("getCachedCandles returns null for insufficient candles", async () => {
  const supabase = createMockSupabase();
  const shortCandles = mockCandles.slice(0, 10); // Only 10 candles
  supabase.store.set("candles:NZD/USD:1d", {
    value: JSON.stringify(shortCandles),
    expires_at: new Date(Date.now() + 3600000).toISOString(),
  });
  const result = await getCachedCandles(supabase, "NZD/USD", "1d");
  assertEquals(result, null);
});

Deno.test("setCachedCandles does not store insufficient candles", async () => {
  const supabase = createMockSupabase();
  await setCachedCandles(supabase, "EUR/JPY", "1d", mockCandles.slice(0, 10) as any);
  assertEquals(supabase.store.has("candles:EUR/JPY:1d"), false);
});

Deno.test("batchGetCachedCandles returns multiple entries in one call", async () => {
  const supabase = createMockSupabase();
  await setCachedCandles(supabase, "EUR/USD", "1d", mockCandles as any);
  await setCachedCandles(supabase, "GBP/USD", "1w", mockCandles as any);

  const result = await batchGetCachedCandles(supabase, [
    { symbol: "EUR/USD", interval: "1d" },
    { symbol: "GBP/USD", interval: "1w" },
    { symbol: "AUD/USD", interval: "1d" }, // missing
  ]);

  assertEquals(result.size, 2);
  assertEquals(result.has("EUR/USD:1d"), true);
  assertEquals(result.has("GBP/USD:1w"), true);
  assertEquals(result.has("AUD/USD:1d"), false);
});

Deno.test("batchSetCachedCandles writes multiple entries", async () => {
  const supabase = createMockSupabase();
  await batchSetCachedCandles(supabase, [
    { symbol: "EUR/USD", interval: "1d", candles: mockCandles as any },
    { symbol: "GBP/USD", interval: "1d", candles: mockCandles as any },
    { symbol: "USD/JPY", interval: "1w", candles: mockCandles as any },
  ]);

  assertEquals(supabase.store.has("candles:EUR/USD:1d"), true);
  assertEquals(supabase.store.has("candles:GBP/USD:1d"), true);
  assertEquals(supabase.store.has("candles:USD/JPY:1w"), true);
});

Deno.test("weekly candles get longer TTL than daily", async () => {
  const supabase = createMockSupabase();
  await setCachedCandles(supabase, "EUR/USD", "1d", mockCandles as any);
  await setCachedCandles(supabase, "EUR/USD", "1w", mockCandles as any);

  const dailyExpiry = new Date(supabase.store.get("candles:EUR/USD:1d")!.expires_at).getTime();
  const weeklyExpiry = new Date(supabase.store.get("candles:EUR/USD:1w")!.expires_at).getTime();

  // Weekly TTL (6h) should be > daily TTL (1h)
  assertEquals(weeklyExpiry > dailyExpiry, true);
  // Difference should be ~5 hours (6h - 1h = 5h = 18_000_000ms)
  const diff = weeklyExpiry - dailyExpiry;
  assertEquals(diff > 17_000_000 && diff < 19_000_000, true);
});
