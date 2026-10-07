/**
 * STEP 15 — Route 2 order placement through route2_place_order.
 *
 * One transaction: attribution row (A–D) + supersede (link both ways, cancel
 * as before) + the new order carrying the same signal_id. A duplicate (an
 * order for this symbol + direction is already live) rolls all of it back and
 * reports that order's signal_id, so the re-detection links to the setup that
 * is being tracked instead of minting a new identity.
 *
 * New entries FAIL CLOSED on attribution: no valid attribution row → no order,
 * no supersede cancel, and an explicit outcome for the decision log
 * (ATTRIBUTION_INVALID before the call, ATTRIBUTION_WRITE_FAILED from it).
 * There is no unattributed fallback: the migration is always applied before
 * this code is merged, and if the function is ever missing the order is not
 * placed (RPC_UNAVAILABLE) rather than placed without a signal_id.
 */

export interface PlaceRoute2Input {
  attribution: Record<string, unknown>;
  order: Record<string, unknown>;
  supersede: { order_id: string; cancel_reason: string }[];
}

export type PlaceRoute2Outcome = "placed" | "duplicate" | "attribution_write_failed" | "failed";

export interface PlaceRoute2Result {
  outcome: PlaceRoute2Outcome;
  /** Decision-log code for anything that did not place an order. */
  code: "ATTRIBUTION_WRITE_FAILED" | "DUPLICATE_LIVE_SETUP" | "RPC_UNAVAILABLE" | "INSERT_FAILED" | null;
  error: string | null;
  signalId: string | null;
  existingOrderId: string | null;
  existingSignalId: string | null;
  superseded: string[];
}

const isMissingRpc = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "PGRST202" || /could not find the function|function .*route2_place_order.* does not exist/i.test(e.message ?? ""));

export async function placeRoute2Order(supabase: any, i: PlaceRoute2Input): Promise<PlaceRoute2Result> {
  const base: PlaceRoute2Result = {
    outcome: "failed", code: null, error: null, signalId: null, existingOrderId: null, existingSignalId: null, superseded: [],
  };
  const { data, error } = await supabase.rpc("route2_place_order", {
    p_attribution: i.attribution, p_order: i.order, p_supersede: i.supersede,
  });
  if (error) {
    return { ...base, code: isMissingRpc(error) ? "RPC_UNAVAILABLE" : "INSERT_FAILED", error: error.message };
  }
  const d = (data ?? {}) as Record<string, any>;
  if (d.outcome === "placed") {
    return { ...base, outcome: "placed", signalId: d.signal_id ?? null, superseded: Array.isArray(d.superseded) ? d.superseded : [] };
  }
  if (d.outcome === "duplicate") {
    return { ...base, outcome: "duplicate", code: "DUPLICATE_LIVE_SETUP", error: d.error ?? "duplicate key value violates unique constraint",
      existingOrderId: d.existing_order_id ?? null, existingSignalId: d.existing_signal_id ?? null };
  }
  if (d.outcome === "attribution_write_failed" || d.outcome === "attribution_missing") {
    return { ...base, outcome: "attribution_write_failed", code: "ATTRIBUTION_WRITE_FAILED", error: d.error ?? d.outcome };
  }
  return { ...base, code: "INSERT_FAILED", error: `route2_place_order: unrecognised reply ${JSON.stringify(d).slice(0, 200)}` };
}
