import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { ZoneStoryPanel } from "./ZoneStoryPanel";

type ZoneStoryProps = ComponentProps<typeof ZoneStoryPanel>;

const unifiedData: NonNullable<ZoneStoryProps["unifiedData"]> = {
  hasZone: true,
  state: "watching",
  selectedTF: "15m",
  unifiedScore: 6,
  scoreBreakdown: {
    baseScore: 6,
    liquidityBonus: 0,
    confirmationBonus: 0,
    tfBonus: 0,
    total: 6,
  },
  impulse: {
    direction: "bullish",
    high: 1.28,
    low: 1.27,
    pips: 100,
    timeframe: "15m",
    startDate: null,
    endDate: null,
    spanBars: 8,
    bosPrice: 1.278,
  },
  zone: {
    type: "OB",
    high: 1.275,
    low: 1.274,
    fibLevel: 0.786,
    fibLabel: "78.6%",
    srConfirmed: true,
    srLevel: 1.285,
    htfLayers: ["4H S/R"],
    ltfRefined: false,
    totalScore: 6,
    zonesFound: 3,
  },
  price: {
    currentPrice: 1.276,
    atZone: false,
    atZoneStrict: false,
    insideZone: false,
    distancePips: 10,
    sideOk: true,
  },
  liquidity: null,
  confirmation: null,
  entry: null,
  storySummary: "Watching",
  reason: "Waiting for local confirmation",
};

const gateData: NonNullable<ZoneStoryProps["gateData"]> = {
  hasZone: true,
  selectedTF: "15m",
  bestZone: {
    type: "ob",
    totalScore: 6,
    srConfirmed: true,
    ltfRefined: false,
    ltfType: null,
    refinedEntry: null,
    refinedSL: null,
    priceAtZone: false,
    localConfluence: {
      policyVersion: "zone-local-confluence.v1",
      enforcement: "observe_only",
      candidateId: "candidate-1",
      items: [
        {
          source: "impulse_fib",
          label: "88% Fib",
          legacyScoreContribution: 1,
          measurement: {
            proximityClass: "outside",
            qualifiedLocally: false,
            fullCreditEligible: false,
            distancePips: 15,
            overlapPercent: 0,
            permittedBufferPips: 2.5,
            reasonCode: "outside_local_buffer",
          },
          qualification: {
            qualified: false,
            role: "zone_layer",
            proximityClass: "outside",
          },
        },
        {
          source: "htf_order_block",
          label: "4H OB",
          legacyScoreContribution: 2,
          measurement: {
            proximityClass: "inside",
            qualifiedLocally: true,
            fullCreditEligible: true,
            distancePips: 0,
            overlapPercent: 100,
            permittedBufferPips: 2.5,
            reasonCode: "full_overlap",
          },
          qualification: {
            qualified: true,
            role: "zone_layer",
            proximityClass: "inside",
          },
        },
      ],
    },
    shadowRanking: {
      enforcement: "observe_only",
      legacyRank: 1,
      shadowRank: 2,
      legacyComparableScore: 6,
      shadowLocalScore: 2,
      summary: {
        observedItems: 2,
        locallyQualifiedItems: 1,
        contextOnlyItems: 0,
        creditedFamilies: 1,
      },
    },
  },
};

describe("ZoneStoryPanel zone-local explanations", () => {
  it("does not count a Fib 15 pips beyond a 10-pip zone as local confluence", () => {
    render(
      <ZoneStoryPanel
        unifiedData={unifiedData}
        gateData={gateData}
        symbol="GBP/USD"
      />,
    );

    expect(
      screen.getByText(/88% Fib: outside · 0 local credit · 15\.0 pips away/),
    ).toBeTruthy();
    expect(screen.getByText(/4H OB: inside · full credit/)).toBeTruthy();
    expect(screen.getByText("RANK DISAGREEMENT")).toBeTruthy();
    expect(screen.queryByText(/S\/R ✓/)).toBeNull();
  });

  it("shows requested mode separately from the evidence-capped effective mode", () => {
    render(
      <ZoneStoryPanel
        unifiedData={unifiedData}
        gateData={gateData}
        zoneLocalEnforcement={{
          mode: {
            requestedMode: "hard",
            effectiveMode: "observe",
            certifiedMaximum: "observe",
            activationTrusted: false,
            reason: "capped_by_certified_authority",
          },
          allowed: true,
          scoreAdjustment: 0,
          minimumLocalScore: 1,
          reason: "observe_only",
        }}
        symbol="GBP/USD"
      />,
    );

    expect(screen.getByText(/Requested/).textContent).toContain("HARD");
    expect(screen.getByText(/Requested/).textContent).toContain("Effective OBSERVE");
    expect(screen.getByText("ALLOWED")).toBeTruthy();
    expect(screen.getByText(/Observation only/)).toBeTruthy();
  });
});
