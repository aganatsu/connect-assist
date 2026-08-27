/**
 * metaApiClient.ts — MetaAPI Region Failover (Single Source of Truth)
 * ═══════════════════════════════════════════════════════════════════
 *
 * MetaAPI HTTP calls go through metaFetch(), which by default:
 *   1. Tries cached region first (from previous successful call for this account)
 *   2. Falls back through ["london", "new-york", "singapore"] on region mismatch
 *   3. Caches successful region for subsequent calls
 *   4. Logs warnings on failover for observability
 *
 * Mutating HTTP methods never fail over, even if a caller requests it. On a
 * cold cache, a read-only account-information request discovers the region
 * before the mutation is dispatched exactly once. A lost mutation response can
 * mean the broker accepted it, so silently resending could duplicate a trade.
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

/**
 * Ask MetaAPI provisioning which region actually hosts this account instead of
 * guessing. Blind region cycling produces 504 "not connected to broker yet or
 * request URL does not match the account region" on every region, and one of
 * the guessed hosts may not even resolve in DNS.
 */
export async function resolveAccountRegion(
  accountId: string,
  authToken: string,
): Promise<string | null> {
  const cached = regionCache.get(accountId);
  if (cached) return cached;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(
      `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${accountId}`,
      { headers: { "auth-token": authToken }, signal: ctrl.signal },
    );
    if (!res.ok) return null;
    const account = await res.json().catch(() => null) as
      | { region?: string }
      | null;
    const region = typeof account?.region === "string" && account.region.trim()
      ? account.region.trim()
      : null;
    if (region) regionCache.set(accountId, region);
    return region;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
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
  options?: { allowFailover?: boolean },
): Promise<{ res: Response; body: string }> {
  const method = String(init?.method || "GET").toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD";
  const failoverAllowed = !isMutation && options?.allowFailover !== false;

  // Mutations may be dispatched only once. A cold edge-function isolate has
  // no cached region, so locate the account with a read-only request first.
  if (!failoverAllowed && !regionCache.has(accountId)) {


    const discovery = await metaFetch(
      accountId,
      authToken,
      (base) => `${base}/account-information`,
    );
    if (!discovery.res.ok || !regionCache.has(accountId)) {
      return {
        res: new Response(
          "MetaAPI account region could not be established; mutation was not sent",
          { status: 503 },
        ),
        body:
          "MetaAPI account region could not be established; mutation was not sent",
      };
    }
  }

  // Cold cache: ask provisioning where the account actually lives BEFORE
  // guessing. Blind region cycling hits hosts that do not know the account,
  // which MetaAPI counts as "unexisting account" lookups and answers with a
  // global 429 TooManyRequestsError for the whole application.
  if (!regionCache.has(accountId)) {
    await resolveAccountRegion(accountId, authToken);
  }
  const cached = regionCache.get(accountId);
  const preferredRegion = cached || META_REGIONS[0];
  const order = !failoverAllowed
    ? [preferredRegion]
    : cached
    ? [cached, ...META_REGIONS.filter((r) => r !== cached)]
    : META_REGIONS;
  let lastBody = ""; let lastStatus = 504; let sawHttpResponse = false;
  const isDnsFailure = (m: string) => /dns error|failed to lookup address/i.test(m);
  const isAccountLookupThrottle = (b: string) =>
    /TooManyRequestsError/i.test(b) && /unexisting or undeployed/i.test(b);
  const queue = [...order];
  const tried = new Set<string>();
  let consultedProvisioning = true;

  while (queue.length) {
    const region = queue.shift()!;
    if (tried.has(region)) continue;
    tried.add(region);

    const url = pathBuilder(metaBaseUrl(region, accountId));
    const headers = { ...(init?.headers || {}), "auth-token": authToken } as Record<string, string>;
    // A 429 from the correct region is rate limiting, not a region mismatch:
    // back off once on the same region before moving on.
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const res = await fetch(url, { ...init, headers, signal: ctrl.signal });
        const body = await res.text();
        if (res.ok) { regionCache.set(accountId, region); return { res, body }; }
        lastBody = body; lastStatus = res.status; sawHttpResponse = true;
        // Application-wide account-lookup throttle: more region attempts only
        // deepen it, so surface it immediately.
        if (isAccountLookupThrottle(body)) {
          return { res: new Response(body, { status: res.status }), body };
        }
        if (!/region|not connected to broker/i.test(body)) {
          return { res: new Response(body, { status: res.status }), body };
        }
        if (res.status === 429 && attempt === 0 && failoverAllowed) {
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }

        console.warn(
          !failoverAllowed
            ? `MetaAPI ${region} returned ${res.status}; unsafe region failover suppressed`
            : `MetaAPI ${region} returned ${res.status} (region/connection mismatch), trying next...`,
        );
      } catch (err) {
        const message = (err as Error).message;
        // An unreachable region host says nothing about the account; keep the
        // more meaningful HTTP status from a region that actually answered.
        if (!sawHttpResponse || !isDnsFailure(message)) {
          lastBody = `network error: ${message}`;
          lastStatus = 504;
        }
        console.warn(
          !failoverAllowed
            ? `MetaAPI ${region} network error; unsafe retry suppressed: ${message}`
            : `MetaAPI ${region} network error, trying next: ${message}`,
        );
      } finally {
        clearTimeout(timer);
      }
      break;
    }

    // Every guessed region rejected the account. Ask MetaAPI provisioning which
    // region actually hosts it instead of failing with a 504 region mismatch.
    if (!queue.length && failoverAllowed && !consultedProvisioning) {
      consultedProvisioning = true;
      regionCache.delete(accountId);
      const provisioned = await resolveAccountRegion(accountId, authToken);
      if (provisioned && !tried.has(provisioned)) queue.push(provisioned);
    }
  }

  return { res: new Response(lastBody, { status: lastStatus }), body: lastBody };

}
