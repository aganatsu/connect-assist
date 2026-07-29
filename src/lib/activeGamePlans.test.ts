import { describe, expect, it } from "vitest";
import {
  type ActiveGamePlanDisplayRow,
  activeGamePlanRowsToLogs,
} from "./activeGamePlans";

function row(
  symbol: string,
  version: string,
  generatedAt: string,
  active = true,
): ActiveGamePlanDisplayRow {
  return {
    id: `${version}-${symbol}`,
    plan_version: version,
    symbol,
    session: "London",
    bias: symbol === "GBP/CAD" ? "bearish" : "bullish",
    bias_confidence: "64",
    v2_conviction: { confidence: 61 },
    state: "tradeable",
    state_reason: "Coherent",
    generated_at: generatedAt,
    expires_at: "2026-07-29T14:00:00.000Z",
    invalidation_conditions: ["Structure breaks"],
    source_candle_timestamps: { entry: "2026-07-29T09:45:00.000Z" },
    plan_json: { tradeable: true, keyLevels: [], scenarios: [] },
    focus_pairs: ["GBP/CAD", "EUR/USD"],
    news_events: [],
    news_impacts: [],
    summary: "London plan",
    generation_source: "automatic_scan",
    contract_version: "phase3.v1",
    is_active: active,
  };
}

describe("active Gameplan display history", () => {
  it("groups instruments by immutable version and keeps newest first", () => {
    const logs = activeGamePlanRowsToLogs([
      row("GBP/CAD", "new-version", "2026-07-29T10:00:00.000Z"),
      row("EUR/USD", "new-version", "2026-07-29T10:00:00.000Z"),
      row("GBP/CAD", "old-version", "2026-07-29T06:00:00.000Z", false),
    ]);

    expect(logs).toHaveLength(2);
    expect(logs[0].id).toBe("new-version");
    expect(logs[0].details_json.plans).toHaveLength(2);
    expect(logs[0].details_json.plans[0].planVersion).toBe("new-version");
    expect(logs[0].details_json.plans[0].gamePlanId).toContain("new-version");
    expect(logs[1].id).toBe("old-version");
  });

  it("limits history by complete versions rather than instrument rows", () => {
    const logs = activeGamePlanRowsToLogs([
      row("GBP/CAD", "v3", "2026-07-29T10:00:00.000Z"),
      row("EUR/USD", "v3", "2026-07-29T10:00:00.000Z"),
      row("GBP/CAD", "v2", "2026-07-29T08:00:00.000Z"),
      row("GBP/CAD", "v1", "2026-07-29T06:00:00.000Z"),
    ], 2);
    expect(logs.map((log) => log.id)).toEqual(["v3", "v2"]);
  });
});
