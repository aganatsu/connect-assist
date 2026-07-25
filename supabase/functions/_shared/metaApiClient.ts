/**
 * metaApiClient.ts — MetaAPI Region Failover (Single Source of Truth)
 * ═══════════════════════════════════════════════════════════════════
 *
 * All MetaAPI HTTP calls go through metaFetch(), which:
 *   1. Tries cached region first (from previous successful call for this account)
 *   2. Falls back through ["london", "new-york", "singapore"] on region mismatch
 *   3. Caches successful region for subsequent calls
 *   4. Logs warnings on failover for observability
 *
 * Previously duplicated in: bot-scanner, broker-execute, paper-trading,
 * zone-confirmation-scanner, reconcileBrokerState, candleSource (as metaFetchCandles).
 */

// ─── Constants ──────────────────────────────────────────────────────────
export const META_REGIONS = ["london", "new-york", "singapore"];

// Per-account region cache (module-level singleton per edge function invocation)
export const regionCache = new Map<string, string>();

// ─── Helpers ────────────────────────────────────────────────────────────
export function metaBaseUrl(region: string, accountId: string): string {
  return `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}`;
}

// ─── Core Fetch with Region Failover ────────────────────────────────────
/**
 * Fetch from MetaAPI with automatic region failover.
 *
 * @param accountId  - MetaAPI account UUID
 * @param authToken  - MetaAPI auth token (JWT)
 * @param pathBuilder - Function that takes the base URL and returns the full endpoint URL
 * @param init       - Optional RequestInit (method, body, extra headers)
 * @returns { res, body } — the Response object and its text body
 */
export async function metaFetch(
  accountId: string,
  authToken: string,
  pathBuilder: (base: string) => string,
  init?: RequestInit,
): Promise<{ res: Response; body: string }> {
  const cached = regionCache.get(accountId);
  const order = cached ? [cached, ...META_REGIONS.filter(r => r !== cached)] : META_REGIONS;
  let lastBody = ""; let lastStatus = 504;
  for (const region of order) {
    const url = pathBuilder(metaBaseUrl(region, accountId));
    const headers = { ...(init?.headers || {}), "auth-token": authToken } as Record<string, string>;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, { ...init, headers, signal: ctrl.signal });
      const body = await res.text();
      if (res.ok) { regionCache.set(accountId, region); return { res, body }; }
      lastBody = body; lastStatus = res.status;
      if (!/region|not connected to broker/i.test(body)) {
        return { res: new Response(body, { status: res.status }), body };
      }
      console.warn(`MetaAPI ${region} returned ${res.status} (region/connection mismatch), trying next...`);
    } catch (err) {
      lastBody = `network error: ${(err as Error).message}`;
      lastStatus = 504;
      console.warn(`MetaAPI ${region} network error, trying next: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { res: new Response(lastBody, { status: lastStatus }), body: lastBody };
}
