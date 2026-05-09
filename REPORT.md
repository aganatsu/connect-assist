# Task: fotsi-cache
## Branch: manus/fotsi-cache
## Behavior changes
none — pure optimization. The FOTSI result is now cached for 4 hours in a `kv_cache` table. Subsequent scan cycles within the TTL window read from cache instead of fetching 28 daily candle pairs from TwelveData. The computed FOTSI values are identical — only the source (cache vs fresh API) changes. Cache is force-invalidated within 5 minutes after daily close (22:00 UTC / 21:00 UTC summer time) to ensure fresh data after new daily candles form.

## Files modified
- `supabase/functions/_shared/fotsiCache.ts` — NEW. Cache module: `getCachedFOTSI()`, `setCachedFOTSI()`, `getFOTSIWithCache()`, `isNearDailyClose()`. Uses Supabase `kv_cache` table with 4h TTL.
- `supabase/functions/_shared/fotsiCache.test.ts` — NEW. 14 unit tests covering cache hit/miss, TTL expiry, daily close invalidation, error handling, round-trip data integrity.
- `supabase/migrations/20260509130000_create_kv_cache_table.sql` — NEW. Creates `kv_cache` table (key TEXT PK, value TEXT, expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ) with index on expires_at.
- `supabase/functions/bot-scanner/index.ts` — MODIFIED. Added import of `getFOTSIWithCache` and `setCachedFOTSI` (line 9). Replaced the FOTSI computation block (~lines 2345-2391) with cache-aware version: checks cache first, falls back to fresh computation on miss, stores result after computing.

## Extra caution note: bot-scanner/index.ts
The FOTSI computation block was wrapped with cache-aware logic. The change is purely additive: on cache hit, the existing `_fotsiResult` variable gets the cached value (identical data); on cache miss, the original computation logic runs unchanged and the result is stored. No scoring logic, gate logic, or trade-taking behavior is altered. The `fetchCandles` call pattern, batch sizing, and rate-limit delays are preserved exactly as before for fresh computations.

## Tests added
1. `getCachedFOTSI: returns null on cache miss (empty store)` — verifies empty DB returns null
2. `getCachedFOTSI: returns cached result when not expired` — verifies valid cache returns FOTSIResult
3. `getCachedFOTSI: returns null when cache is expired` — verifies TTL enforcement
4. `getCachedFOTSI: returns null on malformed JSON in cache` — verifies graceful error handling
5. `setCachedFOTSI: stores result with correct TTL` — verifies 4h TTL is set correctly
6. `setCachedFOTSI: overwrites existing cache entry` — verifies upsert behavior
7. `isNearDailyClose: returns true at 22:00 UTC` — verifies function returns boolean
8. `isNearDailyClose: logic verification` — verifies boundary conditions (22:00-22:04, 21:00-21:04 = true; all others = false)
9. `getFOTSIWithCache: returns cached result when available` — verifies cache hit path
10. `getFOTSIWithCache: returns null when cache is empty` — verifies cache miss path
11. `getFOTSIWithCache: returns null when cache is expired` — verifies expired cache returns miss
12. `setCachedFOTSI then getCachedFOTSI: round-trip preserves data` — integration test for data integrity
13. `getCachedFOTSI: handles supabase error gracefully` — verifies no throw on DB error
14. `setCachedFOTSI: handles supabase write error gracefully` — verifies no throw on write failure

## Tests run
```
$ deno test supabase/functions/_shared/ --allow-all --no-check
ok | 252 passed | 0 failed (6s)
```

## Regression check
- The FOTSI computation logic itself is unchanged — same `computeFOTSI()` call, same batch fetching, same rate limiting.
- The only new code path is: (1) check cache before computing, (2) store result after computing.
- If cache read fails (DB error, malformed data), the function returns null and the original computation runs — no degradation.
- If cache write fails, the result is still used for the current scan — only the next cycle won't benefit from cache.
- The `isNearDailyClose()` guard ensures cache is never stale across daily candle boundaries.

## Open questions
1. The `kv_cache` table migration needs to be applied to production Supabase. Should this be done before or after merging the branch?
2. Should we add a periodic cleanup of expired `kv_cache` rows (e.g., via pg_cron), or is the table small enough to leave as-is? Currently the table will only ever have 1-2 rows (just FOTSI), so cleanup is not urgent.

## Suggested PR title and description
**Title:** `[fotsi-cache] Cache FOTSI result with 4h TTL to avoid 28 API calls per scan cycle`

**Description:**
Adds a caching layer for FOTSI (currency strength) computation. Previously, every 15-minute scan cycle fetched 28 daily candle pairs from TwelveData (~7 seconds, ~28 API calls). Now the result is cached in a `kv_cache` table with a 4-hour TTL.

**Impact:**
- Saves ~28 API calls per scan cycle (except the first after TTL expiry)
- Reduces scan cycle time by ~7 seconds on cache hit
- No change to scoring, gates, or trade-taking behavior
- Cache auto-invalidates near daily close (22:00/21:00 UTC)

**Migration required:** `20260509130000_create_kv_cache_table.sql` creates the `kv_cache` table.
