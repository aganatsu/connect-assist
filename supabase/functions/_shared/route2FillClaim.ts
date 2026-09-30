/**
 * ROUTE 2 FILL OWNERSHIP — the only way a pending order becomes a position.
 *
 * Wraps the `route2_claim_and_fill` RPC (migration 20260930140000), which
 * claims the order and inserts the position in ONE transaction. This module
 * turns its reply into a decision both pollers act on identically:
 *
 *   filled              this caller owns the fill; carry on (notify, mirror)
 *   lost_race           another poller resolved or reset the order first,
 *                       or the confirmation is stale — do NOTHING
 *   duplicate_position  a position already exists for this pending order —
 *                       do NOTHING
 *   failed              the RPC errored; nothing committed and the order is
 *                       still fillable, so the next poll retries
 *
 * THE RACE IT REPLACES: position inserted first, order claimed second, with
 * the claim's zero-row result ignored. On a439f5bc (2026-09-29) that left an
 * order live and fillable for 58 minutes after its position existed.
 */

export type ClaimOutcome =
  | { outcome: "filled"; pendingId: string; positionRowId: string | null }
  | { outcome: "lost_race"; currentStatus: string | null; currentArmCount: number | null; expectedArmCount: number | null }
  | { outcome: "duplicate_position"; detail: string | null }
  | { outcome: "failed"; error: string };

/** Minimal client surface — lets tests supply a fake without Supabase. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface ClaimArgs {
  /** pending_orders.id (uuid primary key) — NOT the 8-char order_id. */
  pendingRowId: string;
  userId: string;
  /** confirmation_arm_count exactly as THIS poller read it. */
  expectedArmCount: number | null;
  /** Fill telemetry to write onto the pending row as part of the claim. */
  pendingPatch: Record<string, unknown>;
  /** The paper_positions row. source_pending_order_id is forced server-side. */
  position: Record<string, unknown>;
}

/** Interpret the RPC reply. Pure; anything unrecognised is a failure. */
export function interpretClaim(data: unknown, error: { message: string } | null): ClaimOutcome {
  if (error) return { outcome: "failed", error: error.message };
  const d = (data ?? {}) as Record<string, unknown>;
  switch (d.outcome) {
    case "filled":
      if (typeof d.pending_id !== "string") return { outcome: "failed", error: "filled reply without pending_id" };
      return { outcome: "filled", pendingId: d.pending_id, positionRowId: (d.position_row_id as string) ?? null };
    case "lost":
      return {
        outcome: "lost_race",
        currentStatus: (d.current_status as string) ?? null,
        currentArmCount: typeof d.current_arm_count === "number" ? d.current_arm_count : null,
        expectedArmCount: typeof d.expected_arm_count === "number" ? d.expected_arm_count : null,
      };
    case "duplicate_position":
      return { outcome: "duplicate_position", detail: (d.detail as string) ?? null };
    default:
      return { outcome: "failed", error: `unrecognised claim reply: ${JSON.stringify(data)?.slice(0, 200)}` };
  }
}

/**
 * Claim and fill. The ONLY caller-visible success is `filled`; every other
 * outcome means this poller must not notify, mirror, or count a trade.
 *
 * Never throws: a transport error becomes `failed`, which is safe because
 * the RPC commits nothing unless it returns `filled`.
 */
export async function claimRoute2Fill(client: RpcClient, a: ClaimArgs): Promise<ClaimOutcome> {
  if (!a.pendingRowId || !a.userId) {
    return { outcome: "failed", error: "missing pending row id or user id" };
  }
  try {
    const { data, error } = await client.rpc("route2_claim_and_fill", {
      p_pending_id: a.pendingRowId,
      p_user_id: a.userId,
      p_expected_arm_count: a.expectedArmCount,
      p_pending_patch: a.pendingPatch,
      p_position: a.position,
    });
    return interpretClaim(data, error);
  } catch (e) {
    return { outcome: "failed", error: (e as Error)?.message ?? String(e) };
  }
}

/** One log line per non-fill outcome, so a lost race is never silent. */
export function describeClaimMiss(o: Exclude<ClaimOutcome, { outcome: "filled" }>): string {
  switch (o.outcome) {
    case "lost_race":
      return `lost race / stale confirmation — order is now ${o.currentStatus ?? "absent"}` +
        (o.currentArmCount !== o.expectedArmCount
          ? ` (arm ${o.expectedArmCount} -> ${o.currentArmCount}: re-armed since this poll read it)`
          : "");
    case "duplicate_position":
      return `a position already exists for this pending order — no second fill (${o.detail ?? ""})`;
    case "failed":
      return `claim failed, NOTHING committed, order still fillable: ${o.error}`;
  }
}
