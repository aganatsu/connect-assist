export type PendingOrderDisplayStage =
  | "watching"
  | "confirmation"
  | "retracement"
  | "reconciliation"
  | "history";

interface PendingOrderDisplayInput {
  status: string;
  post_confirmation_entry?: { state?: string | null } | null;
}

/** Presentation-only projection of the persisted pending-order lifecycle. */
export function pendingOrderDisplayStage(
  order: PendingOrderDisplayInput,
): PendingOrderDisplayStage {
  const retracementState = order.post_confirmation_entry?.state;
  const isActive = order.status === "pending" || order.status === "awaiting_confirmation";
  if (
    isActive &&
    (retracementState === "awaiting_retracement" || retracementState === "ready")
  ) {
    return "retracement";
  }
  if (order.status === "reconciliation_required") return "reconciliation";
  if (order.status === "awaiting_confirmation") return "confirmation";
  if (order.status === "pending") return "watching";
  return "history";
}
