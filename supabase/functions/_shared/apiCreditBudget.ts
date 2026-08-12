// ─── Shared API Credit Budget ────────────────────────────────────────
// A rate limiter held in a module-level array exists once per Edge Function
// ISOLATE, not once per plan. bot-scanner, the every-minute manage loop,
// zone-confirmation-scanner and paper-trading each stayed under their own
// 50/minute while collectively spending far more than the 55 we actually have.
//
// Measured 2026-08-11: 75 credits/min average, 371 peak, 100% of quota — with
// the in-process throttle counter reading 0 throughout, because no single
// isolate ever exceeded its own budget.
//
// Reservations therefore go through Postgres, which is the only thing all the
// isolates share. See migration 20260812020000_add_api_credit_budget.sql.

/** How long to wait on the reservation RPC before giving up and failing open. */
const RESERVE_TIMEOUT_MS = 2_000;

let _rpcFailures = 0;
let _reservationsRefused = 0;
let _unenforced = 0;   // grants issued without the budget being consulted

// Which Edge Function this isolate is. Eight functions reach TwelveData through
// candleSource, so without this every credit would be attributed to
// "candleSource" and the breakdown would say nothing about who to tune.
let _callerContext = "unknown";

/** Call once at module load in each Edge Function. */
export function setCreditCallerContext(name: string): void {
  _callerContext = name;
}

export interface CreditReservation {
  granted: boolean;
  /** True when the budget was consulted; false when we failed open. */
  enforced: boolean;
  reason?: string;
}

/**
 * Reserve one credit from the shared budget.
 *
 * FAILS OPEN. If the RPC errors, times out, or the environment has no service
 * role key, this returns granted with enforced=false and the caller proceeds.
 * A broken limiter must not take the bot offline — over-spending degrades into
 * 429s and a fallback provider, whereas blocking every fetch is a hard outage.
 * Failures are counted so the condition is visible rather than silent, which is
 * the specific way the previous limiter misled us.
 */
export async function reserveApiCredit(
  provider: string,
  limit: number,
  windowSeconds = 60,
  caller = "unknown",
): Promise<CreditReservation> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    return { granted: true, enforced: false, reason: "no_service_credentials" };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RESERVE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/rest/v1/rpc/reserve_api_credit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        p_provider: provider,
        p_limit: limit,
        p_window_seconds: windowSeconds,
        p_caller: caller,
      }),
      signal: abort.signal,
    });

    if (!res.ok) {
      _rpcFailures++;
      console.warn(
        `[apiCreditBudget] reserve_api_credit HTTP ${res.status} — failing open (failure #${_rpcFailures})`,
      );
      return { granted: true, enforced: false, reason: `http_${res.status}` };
    }

    const granted = await res.json();
    if (typeof granted !== "boolean") {
      _rpcFailures++;
      console.warn(
        `[apiCreditBudget] reserve_api_credit returned ${JSON.stringify(granted)}, expected boolean — failing open`,
      );
      return { granted: true, enforced: false, reason: "bad_response" };
    }

    if (!granted) _reservationsRefused++;
    return { granted, enforced: true };
  } catch (err) {
    _rpcFailures++;
    const reason = err instanceof Error && err.name === "AbortError" ? "timeout" : "error";
    console.warn(
      `[apiCreditBudget] reserve_api_credit ${reason} — failing open (failure #${_rpcFailures}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return { granted: true, enforced: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

export interface AcquireOptions {
  windowSeconds?: number;
  /** Total time to keep retrying before giving up. 0 means try once. */
  maxWaitMs?: number;
  /** How often to re-ask while waiting. The window rolls, so credits free up
   *  a few at a time rather than all at once. */
  pollMs?: number;
  /**
   * Identifies the call site. Used both for the throttle log line and as the
   * `caller` recorded against each reserved credit, which is what makes the
   * spend attributable — the budget was saturated at exactly 50/min from the
   * moment it went live, and without this there is no way to see whose it is.
   */
  label?: string;
}

/**
 * Reserve one credit, waiting for the rolling window if the budget is full.
 *
 * This is the entry point every caller should use. The reservation is only
 * useful if it sits on the path that ALL TwelveData traffic takes — the
 * original bug was a limiter that several call sites simply did not go
 * through, so the budget it enforced was fictional.
 *
 * Returns false when the caller should skip the fetch (fall back, or degrade).
 */
export async function acquireApiCredit(
  provider: string,
  limit: number,
  opts: AcquireOptions = {},
): Promise<boolean> {
  const { windowSeconds = 60, maxWaitMs = 0, pollMs = 2_000, label = provider } = opts;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const reservation = await reserveApiCredit(provider, limit, windowSeconds, `${_callerContext}:${label}`);
    if (reservation.granted) {
      if (!reservation.enforced) _unenforced++;
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      console.warn(`[apiCreditBudget] ${label}: budget exhausted, skipping fetch`);
      return false;
    }
    await new Promise((r) => setTimeout(r, Math.min(pollMs, remaining)));
  }
}

/** Read and clear the counters. Surfaced in scan diagnostics. */
export function resetCreditBudgetStats(): {
  rpcFailures: number;
  refused: number;
  unenforced: number;
} {
  const stats = { rpcFailures: _rpcFailures, refused: _reservationsRefused, unenforced: _unenforced };
  _rpcFailures = 0;
  _reservationsRefused = 0;
  _unenforced = 0;
  return stats;
}
