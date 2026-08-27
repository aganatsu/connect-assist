import { describe, expect, it } from "vitest";
import { getStrategyActivationDisplay } from "./strategyActivation";

describe("strategy activation display", () => {
  it("defaults an unregistered feature to safe observation-only shadow mode", () => {
    expect(getStrategyActivationDisplay(null)).toEqual({
      authorityLabel: "SHADOW",
      scopeLabel: "OBSERVATION",
      runtimeLabel: "NOT ENFORCED",
      description:
        "No activation record exists, so the safe default is Shadow / Observation with no trade impact.",
    });
  });

  it("does not describe a registered stage as active unless runtime enforcement is explicit", () => {
    const display = getStrategyActivationDisplay({
      feature_key: "gameplan_hierarchy",
      variant_key: "default",
      authority_stage: "log_only",
      runtime_scope: "paper",
      runtime_enforced: false,
      revision: 2,
      transition_reason: "Evidence passed",
      evidence_hash: "a".repeat(64),
      updated_at: "2026-07-30T20:00:00Z",
    });

    expect(display.authorityLabel).toBe("LOG ONLY");
    expect(display.scopeLabel).toBe("PAPER");
    expect(display.runtimeLabel).toBe("NOT ENFORCED");
    expect(display.description).toContain("runtime enforcement is currently disabled");
  });
});
