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

// Which Edge Function this isolate is. Several functions reach TwelveData
// through candleSource, so without this every credit is attributed to
// "candleSource" and the breakdown says nothing about who to tune.
//
// p_caller must always be sent, and not only for attribution: the database
// carries both a 3-arg and a 4-arg reserve_api_credit, and a 3-arg call matches
// both. PostgREST then refuses to choose (PGRST203, HTTP 300), which this
// module reads as a reason to fail open — enforcement silently off while
// appearing configured. Naming all four parameters resolves it unambiguously.
let _callerContext = "unknown";

/** Call once at module load in each Edge Function that fetches market data. */
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
  caller = _callerContext,
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

/** Read and clear the counters. Surfaced in scan diagnostics. */
export function resetCreditBudgetStats(): { rpcFailures: number; refused: number } {
  const stats = { rpcFailures: _rpcFailures, refused: _reservationsRefused };
  _rpcFailures = 0;
  _reservationsRefused = 0;
  return stats;
}
