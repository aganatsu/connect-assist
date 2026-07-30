/**
 * callerAuth — shared caller verification primitives for edge functions.
 *
 * Security rules enforced here:
 *  - Service-role callers are identified by an EXACT match of the
 *    SUPABASE_SERVICE_ROLE_KEY (sent either as `apikey` or `Authorization:
 *    Bearer`). This is a trusted server-to-server path.
 *  - User callers must present a Supabase-signed JWT that is
 *    CRYPTOGRAPHICALLY validated (getClaims). The mere presence of a Bearer
 *    token is never sufficient.
 *
 * Behaviour of the trading bot is intentionally untouched — these helpers only
 * decide whether a request is allowed to reach the existing logic.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.103.2";

export interface VerifiedClaims {
  sub: string;
  role?: string;
}

export interface CallerScopedUserId {
  userId: string | null;
  forbidden: boolean;
}

/** Verifier signature so tests can inject a deterministic implementation. */
export type ClaimsVerifier = (token: string) => Promise<VerifiedClaims | null>;

/** Length-safe, constant-time-ish string comparison. */
export function secretsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Extract a Bearer token from the Authorization header (null when absent). */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * True only when the caller presented the exact service-role key.
 * Trusted server-to-server path (cron chain, optimizer, self-invocation).
 */
export function isServiceRoleCaller(req: Request): boolean {
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!serviceRoleKey) return false;
  if (secretsMatch(req.headers.get("apikey"), serviceRoleKey)) return true;
  return secretsMatch(bearerToken(req), serviceRoleKey);
}

/** Default verifier — validates the JWT signature via Supabase auth. */
export const defaultClaimsVerifier: ClaimsVerifier = async (token) => {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ||
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !anonKey) return null;
  const client = createClient(url, anonKey, { auth: { persistSession: false } });
  try {
    const auth = client.auth as unknown as {
      getClaims?: (jwt: string) => Promise<{ data: unknown; error: unknown }>;
    };
    if (typeof auth.getClaims === "function") {
      const { data, error } = await auth.getClaims(token);
      const claims = (data as { claims?: Record<string, unknown> } | null)?.claims;
      if (error || !claims || typeof claims.sub !== "string") return null;
      return { sub: claims.sub as string, role: claims.role as string | undefined };
    }
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user?.id) return null;
    return { sub: data.user.id, role: data.user.role ?? undefined };
  } catch (_e) {
    return null;
  }
};

/**
 * Resolve the authenticated end-user for a request.
 * Returns null unless a Supabase-signed *user* JWT was validated.
 * The service-role key is explicitly rejected on this path.
 */
export async function resolveAuthenticatedUserId(
  req: Request,
  verifier: ClaimsVerifier = defaultClaimsVerifier,
): Promise<string | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (secretsMatch(token, serviceRoleKey)) return null;
  const claims = await verifier(token);
  if (!claims?.sub) return null;
  if (claims.role === "service_role" || claims.role === "anon") return null;
  return claims.sub;
}

/**
 * Scope a caller-supplied user id to the cryptographically verified user.
 *
 * Cron and service callers have no authenticated user id and may retain their
 * explicit target. A user caller may omit the target (their own id is used) or
 * repeat their own id, but may never select a different user.
 */
export function resolveCallerScopedUserId(
  authenticatedUserId: string | null,
  requestedUserId: unknown,
): CallerScopedUserId {
  const requested = typeof requestedUserId === "string" &&
      requestedUserId.trim().length > 0
    ? requestedUserId.trim()
    : null;
  if (
    authenticatedUserId && requested &&
    requested !== authenticatedUserId
  ) {
    return { userId: null, forbidden: true };
  }
  return {
    userId: authenticatedUserId || requested,
    forbidden: false,
  };
}
