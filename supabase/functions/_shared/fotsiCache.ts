/**
 * FOTSI Cache — avoids re-fetching 28 daily candle pairs every scan cycle.
 *
 * Daily candles only change once per day (at daily close). FOTSI computed from
 * daily candles is stable for hours. We cache the result with a 4-hour TTL
 * and only re-compute when the cache is stale.
 *
 * Storage: Supabase `kv_cache` table (key-value with expiry).
 * Fallback: If cache read fails, compute fresh (no degradation).
 */

import type { FOTSIResult } from "./fotsi.ts";

const FOTSI_CACHE_KEY = "fotsi_result";
const FOTSI_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface CachedFOTSI {
  result: FOTSIResult;
  computedAt: number; // Unix ms
  expiresAt: number;  // Unix ms
}

/**
 * Try to read cached FOTSI result from Supabase kv_cache table.
 * Returns null if cache miss, expired, or read error.
 */
export async function getCachedFOTSI(
  supabase: any
): Promise<FOTSIResult | null> {
  try {
    const { data, error } = await supabase
      .from("kv_cache")
      .select("value, expires_at")
      .eq("key", FOTSI_CACHE_KEY)
      .single();

    if (error || !data) return null;

    const now = Date.now();
    const expiresAt = new Date(data.expires_at).getTime();

    if (now >= expiresAt) {
      // Cache expired
      return null;
    }

    const cached: CachedFOTSI = JSON.parse(data.value);
    return cached.result;
  } catch {
    // Any parse/read error — treat as cache miss
    return null;
  }
}

/**
 * Store FOTSI result in cache with 4-hour TTL.
 */
export async function setCachedFOTSI(
  supabase: any,
  result: FOTSIResult
): Promise<void> {
  try {
    const now = Date.now();
    const expiresAt = now + FOTSI_CACHE_TTL_MS;

    const cached: CachedFOTSI = {
      result,
      computedAt: now,
      expiresAt,
    };

    await supabase
      .from("kv_cache")
      .upsert({
        key: FOTSI_CACHE_KEY,
        value: JSON.stringify(cached),
        expires_at: new Date(expiresAt).toISOString(),
        updated_at: new Date(now).toISOString(),
      }, { onConflict: "key" });
  } catch {
    // Cache write failure is non-critical — next cycle will re-compute
  }
}

/**
 * Check if FOTSI cache should be invalidated based on daily candle close.
 * Returns true if we're within 5 minutes after a daily close (17:00 EST / 22:00 UTC).
 */
export function isNearDailyClose(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();

  // Daily close is at 22:00 UTC (17:00 EST) for most forex brokers
  // Invalidate cache if within 5 minutes after daily close
  if (utcHour === 22 && utcMin < 5) return true;
  // Also handle summer time (21:00 UTC)
  if (utcHour === 21 && utcMin < 5) return true;

  return false;
}

/**
 * Main entry: get FOTSI from cache or signal that fresh computation is needed.
 * Returns { result, fromCache } or { result: null, fromCache: false } if cache miss.
 */
export async function getFOTSIWithCache(
  supabase: any
): Promise<{ result: FOTSIResult | null; fromCache: boolean }> {
  // Force re-compute near daily close
  if (isNearDailyClose()) {
    return { result: null, fromCache: false };
  }

  const cached = await getCachedFOTSI(supabase);
  if (cached) {
    return { result: cached, fromCache: true };
  }

  return { result: null, fromCache: false };
}
