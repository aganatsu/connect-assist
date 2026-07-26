/**
 * Caller verification for edge functions that use the service-role key.
 *
 * Two modes:
 * 1. `verifyCronCaller(req)` — cron-only functions. Rejects unless
 *    x-cron-secret header matches CRON_SECRET env var.
 * 2. `verifyCronOrUserCaller(req)` — dual-path functions called by both
 *    the cron scheduler AND the frontend. Accepts if EITHER:
 *    - x-cron-secret matches (cron path), OR
 *    - Authorization header contains a valid Supabase user JWT (user path)
 *
 * Usage (cron-only):
 *   const authError = verifyCronCaller(req);
 *   if (authError) return authError;
 *
 * Usage (dual-path):
 *   const authError = verifyCronOrUserCaller(req);
 *   if (authError) return authError;
 */

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
 * Verify the caller is the cron scheduler (x-cron-secret must match).
 * Returns a 401 Response if unauthorized, or null if authorized.
 */
export function verifyCronCaller(req: Request): Response | null {
  const cronSecret = req.headers.get("x-cron-secret");
  const expected = Deno.env.get("CRON_SECRET");

  if (!expected) {
    // If CRON_SECRET is not configured, fail closed — refuse all requests.
    // This prevents the function from being callable if the secret hasn't been set.
    return unauthorizedResponse("CRON_SECRET not configured on server");
  }

  if (cronSecret !== expected) {
    return unauthorizedResponse("Invalid or missing x-cron-secret header");
  }

  return null; // Authorized
}

/**
 * Verify the caller is either the cron scheduler OR an authenticated user.
 * Returns a 401 Response if neither path is satisfied, or null if authorized.
 *
 * Cron path: x-cron-secret header matches CRON_SECRET env var.
 * User path: Authorization header contains "Bearer <token>" where the token
 * is a valid JWT signed by Supabase (verified by Supabase's built-in JWT
 * middleware before the function is invoked — if the request reaches us
 * with a Bearer token, Supabase has already validated it).
 */
export function verifyCronOrUserCaller(req: Request): Response | null {
  // Path 1: Cron secret
  const cronSecret = req.headers.get("x-cron-secret");
  const expectedCronSecret = Deno.env.get("CRON_SECRET");
  if (expectedCronSecret && cronSecret === expectedCronSecret) {
    return null; // Authorized via cron path
  }

  // Path 2: User JWT (Supabase validates the JWT before the function runs;
  // if Authorization contains a Bearer token, the user is authenticated)
  const authHeader = req.headers.get("authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    // The service role key is NOT a valid user token — reject it on the user path.
    // This prevents the scheduled-tasks function (which sends Bearer <SERVICE_ROLE_KEY>)
    // from accidentally passing the user-path check when it should use x-cron-secret.
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (token === serviceRoleKey) {
      // Service role key is not a user credential — must use x-cron-secret path
      return unauthorizedResponse(
        "Service role key is not accepted on the user auth path. " +
        "Cron callers must include x-cron-secret header."
      );
    }
    // Any other Bearer token has been validated by Supabase's JWT middleware
    return null; // Authorized via user path
  }

  // Neither path satisfied
  return unauthorizedResponse(
    "Requires either x-cron-secret header (cron path) or valid user JWT (user path)"
  );
}
