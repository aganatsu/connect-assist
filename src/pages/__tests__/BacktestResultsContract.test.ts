import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("src/pages/Backtest.tsx", "utf8");

describe("Backtest result evidence contract", () => {
  it("reads lifecycle from the golden replay decision schema", () => {
    expect(source).toContain("snapshot.decision?.lifecycle?.stage");
    expect(source).toContain('rawStage === "position" ? "entered"');
    expect(source).toContain('rawStage === "gates"');
    expect(source).toContain("effectiveFactorBreakdown");
    expect(source).toContain("for (const factor of trade.factors ?? [])");
  });

  it("does not claim gate accuracy without counterfactual outcomes", () => {
    expect(source).toContain('v.outcomesAvailable === true');
    expect(source).toContain('"Not measured"');
    expect(source).toContain('outcomesAvailable ? v.wouldHaveWon : "—"');
    expect(source).toContain("Lifecycle Waiting");
    expect(source).toContain("lifecycleStageObservations");
  });
});
