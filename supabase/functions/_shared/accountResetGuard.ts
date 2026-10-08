/**
 * STEP 16-D — real-exposure guard for the paper account balance resets
 * (paper-trading `set_balance`, `reset_balance_only`, `reset_account`).
 *
 * All three call reset_paper_account, which posts a reset entry and starts a
 * NEW LEDGER EPOCH. A position opened before the epoch settles later as
 * `pre_epoch_close` with amount 0 (by design: the old period cannot move the
 * new balance), so resetting while real exposure exists silently loses that
 * position's P/L — and `reset_account` used to delete the positions outright.
 *
 * The guard runs BEFORE any write and fails closed:
 *   refuse when the user has any paper position (every row is real exposure:
 *     a DB trigger refuses a position from a dry-run order), or any ACTIVE REAL
 *     order — pending_orders.status IN ('pending','awaiting_confirmation')
 *     (the set idx_pending_orders_unique_active and the hunt use) AND
 *     dry_run IS NOT TRUE (NULL counts as real);
 *   active DRY-RUN orders alone never block (they cannot become positions or
 *     move the balance); their count is reported, and they are not cancelled;
 *   a read error refuses (cannot prove the account is flat).
 */

export const ACTIVE_ORDER_STATUSES = ["pending", "awaiting_confirmation"] as const;

export interface Exposure {
  openPositions: number;
  activeRealOrders: number;
  activeDryRunOrders: number;
}

export interface GuardRefusal {
  code: "reset_refused_real_exposure" | "reset_refused_exposure_unknown";
  error: string;
  exposure: Exposure | null;
}

export function isActiveRealOrder(o: { status: string | null; dry_run: boolean | null }): boolean {
  return (ACTIVE_ORDER_STATUSES as readonly string[]).includes(String(o.status)) && o.dry_run !== true;
}

export function isActiveDryRunOrder(o: { status: string | null; dry_run: boolean | null }): boolean {
  return (ACTIVE_ORDER_STATUSES as readonly string[]).includes(String(o.status)) && o.dry_run === true;
}

/** Classify already-fetched rows (shared by production and the real-Postgres test). */
export function exposureFromRows(
  positions: unknown[], orders: { status: string | null; dry_run: boolean | null }[],
): Exposure {
  return {
    openPositions: positions.length,
    activeRealOrders: orders.filter(isActiveRealOrder).length,
    activeDryRunOrders: orders.filter(isActiveDryRunOrder).length,
  };
}

/** Null = safe to reset (flat). Otherwise the refusal to return, with nothing written. */
export function resetRefusal(e: Exposure): GuardRefusal | null {
  if (e.openPositions === 0 && e.activeRealOrders === 0) return null;
  return {
    code: "reset_refused_real_exposure",
    error: `Reset refused: ${e.openPositions} open position(s) and ${e.activeRealOrders} active real order(s). ` +
      `Close or cancel them first — a new ledger epoch would record their later P/L as $0.`,
    exposure: e,
  };
}

/**
 * Read the user's exposure. Positions: every row for the user. Orders: only the
 * active statuses (filtered server-side), classified real / dry-run here.
 */
export async function readExposure(
  supabase: any, userId: string,
): Promise<{ ok: true; exposure: Exposure } | { ok: false; error: string }> {
  const [pos, ord] = await Promise.all([
    supabase.from("paper_positions").select("id").eq("user_id", userId),
    supabase.from("pending_orders").select("id, status, dry_run").eq("user_id", userId).in("status", [...ACTIVE_ORDER_STATUSES]),
  ]);
  if (pos.error) return { ok: false, error: `paper_positions: ${pos.error.message}` };
  if (ord.error) return { ok: false, error: `pending_orders: ${ord.error.message}` };
  return { ok: true, exposure: exposureFromRows(pos.data ?? [], ord.data ?? []) };
}

/** Read + decide. Fails closed on a read error. */
export async function checkResetAllowed(
  supabase: any, userId: string,
): Promise<{ allowed: true; exposure: Exposure } | { allowed: false; refusal: GuardRefusal }> {
  const r = await readExposure(supabase, userId);
  if (!r.ok) {
    return { allowed: false, refusal: { code: "reset_refused_exposure_unknown", error: `Reset refused: could not verify the account is flat (${r.error}).`, exposure: null } };
  }
  const refusal = resetRefusal(r.exposure);
  return refusal ? { allowed: false, refusal } : { allowed: true, exposure: r.exposure };
}
