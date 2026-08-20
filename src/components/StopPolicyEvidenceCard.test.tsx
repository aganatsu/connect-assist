import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StopPolicyEvidenceCard } from "./StopPolicyEvidenceCard";

describe("StopPolicyEvidenceCard", () => {
  it("explains when post-deploy candidates have not arrived yet", () => {
    render(
      <StopPolicyEvidenceCard
        loading={false}
        report={{
          summary: {
            total: 0,
            currentValid: 0,
            shadowValid: 0,
            comparable: 0,
            tighter: 0,
            wider: 0,
            unchanged: 0,
            capBreaches: 0,
            proxySamples: 0,
            exactBrokerSamples: 0,
            averageCurrentStopPips: null,
            averageShadowStopPips: null,
            averageCurrentRiskReward: null,
            averageShadowRiskReward: null,
          },
          rows: [],
        }}
      />,
    );

    expect(screen.getByText("Stop Policy Shadow")).toBeTruthy();
    expect(screen.getByText(/New zone-candidate evaluations will appear here automatically/)).toBeTruthy();
  });

  it("shows that zero cap breaches is not enforcement evidence", () => {
    render(
      <StopPolicyEvidenceCard
        loading={false}
        report={{
          summary: {
            total: 1,
            currentValid: 1,
            shadowValid: 1,
            comparable: 1,
            tighter: 1,
            wider: 0,
            unchanged: 0,
            capBreaches: 0,
            proxySamples: 1,
            exactBrokerSamples: 0,
            averageCurrentStopPips: 25,
            averageShadowStopPips: 6,
            averageCurrentRiskReward: 0.55,
            averageShadowRiskReward: 2.2,
          },
          rows: [],
        }}
      />,
    );

    expect(screen.getByText("0 · untested")).toBeTruthy();
    expect(screen.getByText(/configured spread proxy/)).toBeTruthy();
  });
});
