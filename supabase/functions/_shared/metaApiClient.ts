/**
 * MetaAPI account-region and HTTP client — single owner.
 *
 * Account regions are dynamic values returned by the Provisioning API (for
 * example london, new-york, or vint-hill). Callers must never guess from a
 * hard-coded list: wrong-region requests count as nonexistent-account lookups
 * and can trigger an application-wide 429 throttle.
 *
 * Mutations are dispatched at most once. Reads may refresh provisioning once
 * after a genuine region mismatch, but are never sprayed across guessed hosts.
 */

export const regionCache = new Map<string, string>();

const regionResolutionInFlight = new Map<string, Promise<string | null>>();
const accountLookupThrottle = new Map<string, { until: number; body: string }>();
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_THROTTLE_MS = 60_000;

export interface MetaApiProvisioningAccount {
  region?: string;
  state?: string;
  connectionStatus?: string;
  name?: string;
  login?: string | number;
  server?: string;
  type?: string;
  platform?: string;
  [key: string]: unknown;
}

export interface MetaApiProvisioningResult {
  res: Response;
  body: string;
  account: MetaApiProvisioningAccount | null;
  region: string | null;
}

export interface MetaApiFetchResult {
  res: Response;
  body: string;
  region: string | null;
}

export function metaBaseUrl(region: string, accountId: string): string {
  return `https://mt-client-api-v1.${region}.agiliumtrade.ai/users/current/accounts/${accountId}`;
}

function normalizeProvisionedRegion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const region = value.trim().toLowerCase();
  return /^[a-z0-9-]+$/.test(region) ? region : null;
}

function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export async function fetchMetaApiProvisioningAccount(
  accountId: string,
  authToken: string,
  timeoutMs = 10_000,
): Promise<MetaApiProvisioningResult> {
  const timeout = timeoutSignal(timeoutMs);
  try {
    const res = await fetch(
      `https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${accountId}`,
      { headers: { "auth-token": authToken }, signal: timeout.signal },
    );
    const body = await res.text();
    const account = res.ok
      ? await Promise.resolve().then(() => JSON.parse(body)).catch(() => null) as MetaApiProvisioningAccount | null
      : null;
    const deployed = String(account?.state || "").toUpperCase() === "DEPLOYED";
    const region = deployed ? normalizeProvisionedRegion(account?.region) : null;
    if (region) regionCache.set(accountId, region);
    return { res, body, account, region };
  } catch (error) {
    const body = `MetaAPI provisioning request failed: ${(error as Error).message}`;
    return {
      res: new Response(body, { status: 503 }),
      body,
      account: null,
      region: null,
    };
  } finally {
    timeout.clear();
  }
}

export async function resolveAccountRegion(
  accountId: string,
  authToken: string,
  options?: { forceRefresh?: boolean },
): Promise<string | null> {
  if (options?.forceRefresh) regionCache.delete(accountId);
  if (!options?.forceRefresh) {
    const cached = regionCache.get(accountId);
    if (cached) return cached;
    const inFlight = regionResolutionInFlight.get(accountId);
    if (inFlight) return inFlight;
  }

  const resolution = fetchMetaApiProvisioningAccount(accountId, authToken)
    .then((result) => result.region)
    .finally(() => regionResolutionInFlight.delete(accountId));
  regionResolutionInFlight.set(accountId, resolution);
  return resolution;
}

function isRegionMismatch(body: string): boolean {
  return /request URL.*account region|region mismatch|not connected to broker yet/i.test(body);
}

function isAccountLookupThrottle(body: string): boolean {
  return /TooManyRequestsError/i.test(body) && /unexisting or undeployed/i.test(body);
}

function throttleDurationMs(res: Response): number {
  const header = res.headers.get("retry-after");
  if (!header) return DEFAULT_THROTTLE_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const until = Date.parse(header);
  return Number.isFinite(until) ? Math.max(1_000, until - Date.now()) : DEFAULT_THROTTLE_MS;
}

async function requestProvisionedRegion(
  accountId: string,
  authToken: string,
  region: string,
  pathBuilder: (base: string) => string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<MetaApiFetchResult> {
  const timeout = timeoutSignal(timeoutMs);
  try {
    const headers = { ...(init?.headers || {}), "auth-token": authToken } as Record<string, string>;
    const res = await fetch(pathBuilder(metaBaseUrl(region, accountId)), {
      ...init,
      headers,
      signal: timeout.signal,
    });
    const body = await res.text();
    if (isAccountLookupThrottle(body)) {
      accountLookupThrottle.set(accountId, {
        until: Date.now() + throttleDurationMs(res),
        body,
      });
    }
    return { res, body, region };
  } catch (error) {
    const body = `network error: ${(error as Error).message}`;
    return { res: new Response(body, { status: 504 }), body, region };
  } finally {
    timeout.clear();
  }
}

export async function metaFetch(
  accountId: string,
  authToken: string,
  pathBuilder: (base: string) => string,
  init?: RequestInit,
  options?: { allowFailover?: boolean; timeoutMs?: number },
): Promise<MetaApiFetchResult> {
  const throttled = accountLookupThrottle.get(accountId);
  if (throttled && throttled.until > Date.now()) {
    return {
      res: new Response(throttled.body, { status: 429 }),
      body: throttled.body,
      region: regionCache.get(accountId) ?? null,
    };
  }
  if (throttled) accountLookupThrottle.delete(accountId);

  const method = String(init?.method || "GET").toUpperCase();
  const isMutation = method !== "GET" && method !== "HEAD";
  const mayRefreshRegion = !isMutation && options?.allowFailover !== false;
  const region = await resolveAccountRegion(accountId, authToken);
  if (!region) {
    const body = "MetaAPI account region could not be established from provisioning; request was not sent";
    return { res: new Response(body, { status: 503 }), body, region: null };
  }

  const result = await requestProvisionedRegion(
    accountId,
    authToken,
    region,
    pathBuilder,
    init,
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  if (result.res.ok || !mayRefreshRegion || !isRegionMismatch(result.body)) return result;

  regionCache.delete(accountId);
  const refreshedRegion = await resolveAccountRegion(accountId, authToken, { forceRefresh: true });
  if (!refreshedRegion || refreshedRegion === region) return result;

  return requestProvisionedRegion(
    accountId,
    authToken,
    refreshedRegion,
    pathBuilder,
    init,
    options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}
