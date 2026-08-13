import { describe, expect, it } from "vitest";
import { buildPendingLifecycleEvidence } from "./pendingLifecycleEvidence";

describe("pending lifecycle evidence", () => {
  it("keeps waiting outcomes separate and links a filled position", () => {
    const report = buildPendingLifecycleEvidence([
      {
        id: "1", order_id: "pending-1", candidate_id: "candidate-1",
        symbol: "EUR/USD", direction: "long", status: "filled",
        entry_price: 1.1, current_price: 1.101, placed_at: "2026-08-12T10:00:00Z",
        expires_at: "2026-08-12T14:00:00Z", zone_touch_time: "2026-08-12T11:00:00Z",
        resolved_at: "2026-08-12T11:30:00Z",
        liquidity_confirmation_observation: {
          contractVersion: "liquidity-confirmation.v2", ready: true,
          reasonCode: "sequence_confirmed",
        },
      },
    ], [{
      source_pending_order_id: "1", position_id: "position-1",
      position_status: "closed", close_reason: "tp_hit", pnl: 100, pnl_pips: 20,
    }]);
    expect(report.summary.touched).toBe(1);
    expect(report.summary.sequenceReady).toBe(1);
    expect(report.summary.linkedOutcomes).toBe(1);
    expect(report.rows[0].linkedPosition?.close_reason).toBe("tp_hit");
  });
});
