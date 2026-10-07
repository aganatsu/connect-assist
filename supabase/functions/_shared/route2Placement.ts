/**
 * STEP 15 — Route 2 order placement through route2_place_order.
 *
 * One transaction: attribution row (A–D) + supersede (link both ways, cancel
 * as before) + the new order carrying the same signal_id. A duplicate (an
 * order for this symbol + direction is already live) rolls all of it back and
 * reports that order's signal_id, so the re-detection links to the setup that
 * is being tracked instead of minting a new identity.
 *
 * Attribution can never stop an order:
 *   - a bad attribution row → the RPC places the order without signal_id;
 *   - the RPC missing (code deployed before its migration) → the exact legacy
 *     path: cancel the superseded orders, insert the order, no signal_id.
 */

export interface PlaceRoute2Input {
  attribution: Record<string, unknown> | null;
  order: Record<string, unknown>;
  supersede: { order_id: string; cancel_reason: string }[];
}

export interface PlaceRoute2Result {
  outcome: "placed" | "duplicate" | "failed";
  error: string | null;
  signalId: string | null;
  attribution: "written" | "none" | "failed" | "legacy_fallback";
  attributionError: string | null;
  existingOrderId: string | null;
  existingSignalId: string | null;
  superseded: string[];
}

const isMissingRpc = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "PGRST202" || /could not find the function|function .*route2_place_order.* does not exist/i.test(e.message ?? ""));

export async function placeRoute2Order(supabase: any, i: PlaceRoute2Input): Promise<PlaceRoute2Result> {
  const base: PlaceRoute2Result = {
    outcome: "failed", error: null, signalId: null, attribution: "none", attributionError: null,
    existingOrderId: null, existingSignalId: null, superseded: [],
  };
  const { data, error } = await supabase.rpc("route2_place_order", {
    p_attribution: i.attribution, p_order: i.order, p_supersede: i.supersede,
  });

  if (error && isMissingRpc(error)) {
    // Legacy path, byte-for-byte what bot-scanner did before step 15.
    if (i.supersede.length > 0) {
      await supabase.from("pending_orders").update({
        status: "cancelled",
        terminal_reason: "CANCELLED_SUPERSEDED",
        resolved_at: new Date().toISOString(),
        cancel_reason: i.supersede[0].cancel_reason,
      }).in("order_id", i.supersede.map((s) => s.order_id)).eq("user_id", i.order.user_id);
    }
    const { error: insErr } = await supabase.from("pending_orders").insert(i.order);
    if (insErr) {
      return { ...base, attribution: "legacy_fallback", superseded: i.supersede.map((s) => s.order_id),
        outcome: /duplicate key/i.test(insErr.message) ? "duplicate" : "failed", error: insErr.message };
    }
    return { ...base, outcome: "placed", attribution: "legacy_fallback", superseded: i.supersede.map((s) => s.order_id) };
  }
  if (error) return { ...base, error: error.message };

  const d = (data ?? {}) as Record<string, any>;
  if (d.outcome === "duplicate") {
    return { ...base, outcome: "duplicate", error: d.error ?? "duplicate key value violates unique constraint",
      existingOrderId: d.existing_order_id ?? null, existingSignalId: d.existing_signal_id ?? null };
  }
  if (d.outcome === "placed") {
    return { ...base, outcome: "placed", signalId: d.signal_id ?? null,
      attribution: d.attribution ?? "none", attributionError: d.attribution_error ?? null,
      superseded: Array.isArray(d.superseded) ? d.superseded : [] };
  }
  return { ...base, error: `route2_place_order: unrecognised reply ${JSON.stringify(d).slice(0, 200)}` };
}
