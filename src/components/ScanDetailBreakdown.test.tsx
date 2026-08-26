import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TradeDecisionPanel } from "./ScanDetailBreakdown";

describe("TradeDecisionPanel", () => {
  it("keeps the actual rejected scan outcome primary when the workflow is observation-only", () => {
    render(
      <TradeDecisionPanel
        detail={{
          status: "rejected",
          reason: "Trade rejected by minimum risk/reward",
          gates: [{
            code: "minimum_risk_reward",
            passed: false,
            reason: "Effective R:R is 0.69, below the required 1.00.",
          }],
          singleOwnershipDecision: {
            decision: "block",
            reasonCodes: ["safety_minimum_risk_reward"],
          },
          singleOwnershipEnforcement: {
            effectiveMode: "observe",
          },
          canonicalScannerState: {
            stage: "awaiting_liquidity",
            explanation: "Price is at the POI and is waiting for a local liquidity sweep.",
            nextRequirement: "Complete the liquidity-to-structure sequence.",
          },
          canonicalScannerEnforcement: {
            effectiveMode: "observe",
            affectsAuthorization: false,
          },
          tradeDecisionPresentation: {
            primary: {
              stage: "awaiting_liquidity",
              explanation: "Price is at the POI and is waiting for a local liquidity sweep.",
              nextRequirement: "Complete the liquidity-to-structure sequence.",
            },
            authorityChecks: [
              { role: "liquidity", passed: false, reason: "No qualifying sweep" },
            ],
            diagnostics: [],
          },
        }}
      />,
    );

    expect(screen.getByText("Actual scan outcome")).toBeInTheDocument();
    expect(screen.getByText("REJECTED")).toBeInTheDocument();
    expect(screen.getByText(/Effective R:R is 0\.69/)).toBeInTheDocument();
    expect(screen.getByText("Workflow observation")).toBeInTheDocument();
    expect(screen.getByText("AWAITING LIQUIDITY")).toBeInTheDocument();
    expect(screen.getByText(/does not change this scan outcome/i)).toBeInTheDocument();
    expect(screen.queryByText(/current canonical authority/i)).toBeNull();
  });
});
