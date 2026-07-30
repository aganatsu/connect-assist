/**
 * Caller verification for edge functions that use the service-role key.
 *
 * Two modes:
 * 1. `verifyCronCaller(req)` — cron-only functions. Rejects unless
 *    x-cron-secret header matches CRON_SECRET exactly.
 * 2. `verifyCronOrUserCaller(req)` — dual-path functions called by both
 *    the cron scheduler AND the frontend. Accepts if EITHER:
 *    - x-cron-secret matches exactly (cron path), OR
 *    - the Authorization header carries a Supabase user JWT whose signature
 *      is cryptographically validated via getClaims() (user path).
 *
 * The mere presence of a Bearer token is NEVER treated as authenticated.
 *
 * Usage (cron-only):
 *   const authError = verifyCronCaller(req);
 *   if (authError) return authError;
 *
 * Usage (dual-path):
 *   const authError = await verifyCronOrUserCaller(req);
 *   if (authError) return authError;
 */

import {
  type ClaimsVerifier,
  defaultClaimsVerifier,
  resolveAuthenticatedUserId,
  secretsMatch,
} from "./callerAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function unauthorizedResponse(reason: string): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized", reason }),
    { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

/**
 * Verify the caller is the cron scheduler (x-cron-secret must match exactly).
 * Returns a 401 Response if unauthorized, or null if authorized.
 */
export function verifyCronCaller(req: Request): Response | null {
  const cronSecret = req.headers.get("x-cron-secret");
  const expected = Deno.env.get("CRON_SECRET");

  if (!expected) {
    // Fail closed — refuse all requests when the secret is not configured.
    return unauthorizedResponse("CRON_SECRET not configured on server");
  }

  if (!secretsMatch(cronSecret, expected)) {
    return unauthorizedResponse("Invalid or missing x-cron-secret header");
  }

  return null; // Authorized
}

/**
 * Verify the caller is either the cron scheduler OR an authenticated user.
 * Returns a 401 Response if neither path is satisfied, or null if authorized.
 *
 * Cron path: x-cron-secret matches CRON_SECRET exactly.
 * User path: Authorization Bearer token validated with getClaims(). The
 * service-role key is not a user credential and is rejected here.
 */
export async function verifyCronOrUserCaller(
  req: Request,
  verifier: ClaimsVerifier = defaultClaimsVerifier,
): Promise<Response | null> {
  // Path 1: Cron secret (exact match)
  const expectedCronSecret = Deno.env.get("CRON_SECRET");
  if (secretsMatch(req.headers.get("x-cron-secret"), expectedCronSecret)) {
    return null; // Authorized via cron path
  }

  // Path 2: Cryptographically validated user JWT
  const userId = await resolveAuthenticatedUserId(req, verifier);
  if (userId) return null;

  return unauthorizedResponse(
    "Requires either a valid x-cron-secret header (cron path) or a valid Supabase user JWT (user path)",
  );
}
