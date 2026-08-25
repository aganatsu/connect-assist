import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { UnifiedZonePanel } from "./UnifiedZonePanel";

type PanelData = NonNullable<ComponentProps<typeof UnifiedZonePanel>["data"]>;

/**
 * Distance is measured against a zone. When the engine finds none it leaves
 * `distancePips` at its 0 default, and the Price row rendered that verbatim as
 * "0.0 pips away" — indistinguishable from price sitting exactly on the zone,
 * and shown directly beneath a Zone row reading "None found".
 *
 * Observed 2026-08-25 on XAU/USD: the Detail Breakdown claimed "0.0 pips away"
 * while the Watchlist on the same screen reported 1514.9 pips for the same
 * instrument.
 */
const baseData: PanelData = {
  hasZone: false,
  state: "no_zone",
  selectedTF: "1H",
  unifiedScore: 0,
  scoreBreakdown: {
    baseScore: 0,
    liquidityBonus: 0,
    confirmationBonus: 0,
    tfBonus: 0,
    total: 0,
  },
  impulse: {
    direction: "bullish",
    high: 4396.587,
    low: 4310.614,
    pips: 859.7,
    timeframe: "1H",
    startDate: null,
    endDate: null,
    spanBars: 65,
    bosPrice: 4385.788,
  },
  zone: null,
  price: {
    currentPrice: 4641.79,
    atZone: false,
    atZoneStrict: false,
    insideZone: false,
    distancePips: 0,
    sideOk: false,
  },
  liquidity: null,
  confirmation: null,
  entry: null,
  storySummary: "No zone",
  reason: "1H zone selected: no valid zone on any timeframe",
} as unknown as PanelData;

describe("UnifiedZonePanel price distance", () => {
  it("does not report a distance when no zone was found", () => {
    render(<UnifiedZonePanel data={baseData} />);

    expect(screen.getByText("No zone to measure against")).toBeInTheDocument();
    // The 0-default must never surface as a real measurement.
    expect(screen.queryByText(/0\.0 pips away/)).not.toBeInTheDocument();
  });

  it("still reports a real distance when a zone exists", () => {
    const withZone = {
      ...baseData,
      hasZone: true,
      state: "watching",
      zone: {
        type: "OB",
        high: 4490.303,
        low: 4466.855,
        fibLevel: 0.708,
        fibLabel: "70.8%",
        srConfirmed: false,
        htfLayers: [],
        ltfRefined: false,
        totalScore: 4,
        zonesFound: 2,
      },
      price: { ...baseData.price, distancePips: 1514.9 },
    } as unknown as PanelData;

    render(<UnifiedZonePanel data={withZone} />);

    expect(screen.getByText(/1514\.9 pips away/)).toBeInTheDocument();
    expect(
      screen.queryByText("No zone to measure against"),
    ).not.toBeInTheDocument();
  });

  it("reports inside/at zone without a distance", () => {
    const atZone = {
      ...baseData,
      hasZone: true,
      state: "at_zone",
      zone: {
        type: "OB",
        high: 4490.303,
        low: 4466.855,
        fibLevel: 0.708,
        fibLabel: "70.8%",
        srConfirmed: false,
        htfLayers: [],
        ltfRefined: false,
        totalScore: 4,
        zonesFound: 2,
      },
      price: {
        ...baseData.price,
        atZone: true,
        insideZone: true,
        distancePips: 0,
        sideOk: true,
      },
    } as unknown as PanelData;

    render(<UnifiedZonePanel data={atZone} />);

    expect(screen.getByText("Inside zone")).toBeInTheDocument();
    expect(screen.queryByText(/pips away/)).not.toBeInTheDocument();
  });
});
