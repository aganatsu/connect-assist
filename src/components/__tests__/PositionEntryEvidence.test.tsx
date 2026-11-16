import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PositionEntryEvidence } from "../PositionEntryEvidence";
import { getPositionEntryEvidence } from "@/lib/positionEvidence";

describe("position entry evidence selection", () => {
  it("prefers the immutable pending-order story over a signal fallback", () => {
    const pendingStory = { state: "triggered", selectedTF: "1H" };
    const evidence = getPositionEntryEvidence({
      zoneStoryAtFill: pendingStory,
      signalReason: JSON.stringify({ unifiedZone: { state: "watching", selectedTF: "5m" } }),
    });
    expect(evidence.zoneStory).toEqual(pendingStory);
    expect(evidence.zoneStorySource).toBe("pending_order");
  });

  it("uses top-level frozen decision fields before legacy signal fields", () => {
    const evidence = getPositionEntryEvidence({
      directionVerdict: { verdict: "long", confidence: 84 },
      thesisValidation: { valid: true },
      finalAuthorization: { allowed: true },
      signalReason: JSON.stringify({ directionVerdict: { verdict: "short", confidence: 20 } }),
    });
    expect(evidence.directionVerdict?.verdict).toBe("long");
    expect(evidence.thesisValidation?.valid).toBe(true);
    expect(evidence.finalAuthorization?.allowed).toBe(true);
  });
});

describe("expanded trade evidence UI", () => {
  it("shows the zone, verdict, thesis, authorization and provenance", () => {
    render(<PositionEntryEvidence position={{
      symbol: "EUR/GBP",
      direction: "long",
      originatingZone: { type: "OB", low: 0.83502, high: 0.8358 },
      directionVerdict: { verdict: "long", confidence: 84 },
      thesisValidation: { valid: true },
      finalAuthorization: { allowed: true },
      entryConfirmation: { type: "sweep_reclaim" },
      entryRoute: "route2_pending",
      entryZoneTimeframe: "1H",
      tradingStyle: "swing",
      gamePlanVersion: "12345678-aaaa-bbbb-cccc-123456789012",
      candidateId: "87654321-aaaa-bbbb-cccc-123456789012",
      policyFrozenAt: "2026-11-12T05:20:00Z",
    }} />);

    expect(screen.getByText("Trade Story at Entry")).toBeInTheDocument();
    expect(screen.getByText(/0\.83502–0\.83580/)).toBeInTheDocument();
    expect(screen.getByText(/LONG 84%/)).toBeInTheDocument();
    expect(screen.getByText("VALID")).toBeInTheDocument();
    expect(screen.getByText("AUTHORIZED")).toBeInTheDocument();
    expect(screen.getByText("sweep reclaim")).toBeInTheDocument();
    expect(screen.getByText("12345678…")).toBeInTheDocument();
  });

  it("is honest when a legacy/manual trade has no captured zone story", () => {
    render(<PositionEntryEvidence position={{ symbol: "EUR/GBP", direction: "long", signalReason: "manual" }} />);
    expect(screen.getByText(/full Zone Story was not frozen/i)).toBeInTheDocument();
    expect(screen.getByText(/predates entry-evidence capture/i)).toBeInTheDocument();
  });
});

describe("entry-route persistence contract", () => {
  it("freezes unifiedZone into scanner-created trade and pending snapshots", () => {
    const scanner = readFileSync("supabase/functions/bot-scanner/index.ts", "utf8");
    expect(scanner.match(/unifiedZone: \(detail as any\)\.unifiedZone \|\| null/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("the status API exposes the frozen decision fields", () => {
    const api = readFileSync("supabase/functions/paper-trading/index.ts", "utf8");
    for (const field of [
      "zoneStoryAtFill", "frozenStrategyContext", "directionVerdict",
      "thesisValidation", "finalAuthorization", "gamePlanVersion",
    ]) expect(api).toContain(field);
  });
});

