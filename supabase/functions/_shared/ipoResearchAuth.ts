/**
 * Authentication for the project-owned IPO corpus. RESEARCH ONLY.
 *
 * WHY NOT A USER JWT. The corpus is canonical project data, not per-user
 * application data, so "which signed-in account is this" is the wrong question
 * — every account would get the same answer and any account could rewrite the
 * shared record. What the endpoints actually need is "is this the research
 * operator", which is a single shared secret held server-side.
 *
 * WHY ipo_coverage NEEDS IT TOO. Coverage is not a cheap read. It builds a full
 * inventory per timeframe and, with startDate/endDate, issues paged historical
 * fetches against a metered provider. Left open to the publishable key it is an
 * unauthenticated way to spend the project's data budget.
 *
 * THE COMPARISON IS CONSTANT-TIME. A plain === leaks the length of the matching
 * prefix through timing, which turns guessing a token into a per-character
 * search rather than a search of the whole space. The cost here is a few
 * microseconds.
 *
 * The token is never echoed. Not in a response, not in an error, not in a log
 * line — a secret that appears in a diagnostic payload has been disclosed to
 * everyone who can read that payload.
 */

export const RESEARCH_KEY_HEADER = "X-IPO-Research-Key";
export const RESEARCH_KEY_ENV = "IPO_RESEARCH_ADMIN_TOKEN";

export type ResearchAuthResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Length-independent constant-time comparison.
 *
 * Both strings are hashed to a fixed 32 bytes first, so the loop length no
 * longer depends on either input and an early length check — itself a timing
 * signal — is unnecessary.
 */
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Checks the research key on a request.
 *
 * A missing server secret is a 503, not a 401. Those are different operational
 * facts: "you are not authorised" tells the caller to fix their request, while
 * "this deployment has no token configured" tells them nothing they send will
 * ever work. Collapsing them sends someone hunting for a credential problem
 * that is really a deployment problem.
 *
 * Both the 401 and the 503 describe the situation without quoting any part of
 * either the expected or the supplied value.
 */
export async function checkResearchKey(req: Request): Promise<ResearchAuthResult> {
  const expected = Deno.env.get(RESEARCH_KEY_ENV) ?? "";
  if (!expected) {
    return {
      ok: false, status: 503,
      error: `${RESEARCH_KEY_ENV} is not configured on this deployment — ` +
        "the IPO corpus endpoints are unavailable until it is set",
    };
  }
  // Header names are case-insensitive per the Headers spec, so a caller sending
  // x-ipo-research-key matches too.
  const supplied = req.headers.get(RESEARCH_KEY_HEADER) ?? "";
  if (!supplied) {
    return {
      ok: false, status: 401,
      error: `${RESEARCH_KEY_HEADER} header required — the IPO corpus is ` +
        "project-owned research data and is not reachable with a publishable or user key",
    };
  }
  if (!(await constantTimeEquals(supplied, expected))) {
    return { ok: false, status: 401, error: `${RESEARCH_KEY_HEADER} is not valid` };
  }
  return { ok: true };
}
