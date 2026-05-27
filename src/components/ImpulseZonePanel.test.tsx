/**
 * ImpulseZonePanel — tests for isLiveContext prop gating.
 *
 * Verifies that the "⏳ Hunting 5m CHoCH" badge only appears when
 * isLiveContext=true AND price is at zone (strict/inside).
 * When isLiveContext is false/omitted (historical context), the badge must NOT appear.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ImpulseZonePanel } from "./ImpulseZonePanel";

const baseZoneData = {
  hasZone: true,
  selectedTF: "1H" as const,
  reason: "Zone found",
  impulse: { high: 1.1, low: 1.0, direction: "bullish" as const },
  bestZone: {
    type: "ob" as const,
    high: 1.05,
    low: 1.04,
    fibLevel: 0.618,
    fibDepth: 0.5,
    totalScore: 6,
    srConfirmed: true,
    ltfRefined: true,
    ltfType: "ob" as const,
    refinedEntry: 1.045,
    refinedSL: 1.038,
    priceAtZone: true,
    priceInsideZone: true,
    priceAtZoneStrict: true,
    sideOk: true,
    distanceToZone: 0,
    distancePips: 0,
  },
  allZonesCount: 2,
  h1HasZone: true,
  h4HasZone: false,
};

describe("ImpulseZonePanel — isLiveContext gating", () => {
  it("does NOT show 'Hunting 5m CHoCH' badge when isLiveContext is omitted (default false)", () => {
    render(<ImpulseZonePanel data={baseZoneData} />);
    expect(screen.queryByText(/Hunting 5m CHoCH/)).toBeNull();
  });

  it("does NOT show 'Hunting 5m CHoCH' badge when isLiveContext=false", () => {
    render(<ImpulseZonePanel data={baseZoneData} isLiveContext={false} />);
    expect(screen.queryByText(/Hunting 5m CHoCH/)).toBeNull();
  });

  it("DOES show 'Hunting 5m CHoCH' badge when isLiveContext=true AND price is at zone strict", () => {
    render(<ImpulseZonePanel data={baseZoneData} isLiveContext={true} />);
    expect(screen.getByText(/Hunting 5m CHoCH/)).toBeTruthy();
  });

  it("does NOT show badge when isLiveContext=true but price is NOT at zone", () => {
    const notAtZone = {
      ...baseZoneData,
      bestZone: {
        ...baseZoneData.bestZone,
        priceInsideZone: false,
        priceAtZoneStrict: false,
        priceAtZone: false,
        distanceToZone: 0.005,
        distancePips: 50,
      },
    };
    render(<ImpulseZonePanel data={notAtZone} isLiveContext={true} />);
    expect(screen.queryByText(/Hunting 5m CHoCH/)).toBeNull();
  });

  it("shows zone info (type, fib, score) regardless of isLiveContext", () => {
    const { rerender } = render(<ImpulseZonePanel data={baseZoneData} isLiveContext={false} />);
    // Zone type badge
    expect(screen.getByText("OB")).toBeTruthy();
    // Score
    expect(screen.getByText(/Score 6\/11/)).toBeTruthy();

    // Same info with isLiveContext=true
    rerender(<ImpulseZonePanel data={baseZoneData} isLiveContext={true} />);
    expect(screen.getByText("OB")).toBeTruthy();
    expect(screen.getByText(/Score 6\/11/)).toBeTruthy();
  });
});
