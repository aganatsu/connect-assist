/**
 * ChartContextPanel — tests for scan staleness gating.
 *
 * Verifies that "⚡ PRICE AT ZONE" only shows when scan data is fresh (< 2 min),
 * and shows "Was at zone (scan stale)" when data is older than 2 minutes.
 */
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChartContextPanel } from "./ChartContextPanel";

// Mock the market data utilities used by ChartContextPanel
vi.mock("@/lib/marketData", () => ({
  getCurrentSession: () => "London",
  isInKillzone: () => ({ active: true, name: "London Open" }),
}));

const baseSignal = {
  pair: "EUR/USD",
  direction: "long",
  score: 7.5,
  entry: 1.085,
  impulseZone: {
    hasZone: true,
    selectedTF: "1H",
    reason: "Zone found",
    impulse: { high: 1.09, low: 1.08, direction: "bullish" },
    bestZone: {
      type: "ob",
      high: 1.085,
      low: 1.084,
      fibLevel: 0.618,
      fibDepth: 0.5,
      totalScore: 6,
      priceAtZone: true,
      priceInsideZone: true,
      priceAtZoneStrict: true,
      distanceToZone: 0,
    },
    allZonesCount: 1,
    h1HasZone: true,
    h4HasZone: false,
  },
};

describe("ChartContextPanel — scan staleness gating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows '⚡ PRICE AT ZONE' when scan is fresh (< 2 min old)", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    vi.setSystemTime(now);

    // Scanned 30 seconds ago
    const scannedAt = new Date(now.getTime() - 30_000).toISOString();

    render(
      <ChartContextPanel
        analysis={null}
        unified={null}
        botScanSignal={{ signal: baseSignal, scannedAt }}
        currentPrice={1.0845}
      />
    );

    expect(screen.getByText(/PRICE AT ZONE/)).toBeTruthy();
    expect(screen.queryByText(/scan stale/)).toBeNull();
  });

  it("shows 'Was at zone (scan stale)' when scan is older than 2 minutes", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    vi.setSystemTime(now);

    // Scanned 3 minutes ago
    const scannedAt = new Date(now.getTime() - 3 * 60_000).toISOString();

    render(
      <ChartContextPanel
        analysis={null}
        unified={null}
        botScanSignal={{ signal: baseSignal, scannedAt }}
        currentPrice={1.0845}
      />
    );

    expect(screen.queryByText(/⚡ PRICE AT ZONE/)).toBeNull();
    expect(screen.getByText(/scan stale/)).toBeTruthy();
  });

  it("does not show either badge when price is NOT at zone", () => {
    const now = new Date("2026-05-27T12:00:00Z");
    vi.setSystemTime(now);

    const scannedAt = new Date(now.getTime() - 30_000).toISOString();
    const notAtZoneSignal = {
      ...baseSignal,
      impulseZone: {
        ...baseSignal.impulseZone,
        bestZone: {
          ...baseSignal.impulseZone.bestZone,
          priceAtZone: false,
          priceInsideZone: false,
          priceAtZoneStrict: false,
          distanceToZone: 0.005,
        },
      },
    };

    render(
      <ChartContextPanel
        analysis={null}
        unified={null}
        botScanSignal={{ signal: notAtZoneSignal, scannedAt }}
        currentPrice={1.09}
      />
    );

    expect(screen.queryByText(/PRICE AT ZONE/)).toBeNull();
    expect(screen.queryByText(/scan stale/)).toBeNull();
  });
});
