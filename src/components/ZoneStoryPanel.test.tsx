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
    qualification: { state: "qualified", reasons: [], measurements: {} },
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
  it("shows the qualified internal sweep authority instead of a generic nearby-pool claim", () => {
    render(
      <ZoneStoryPanel
        unifiedData={{
          ...unifiedData,
          state: "waiting_for_sweep",
          liquidity: {
            liquidityScore: 1,
            summary: "BSL @ 1.27450 (3 touches)",
            nearbyPools: 2,
            entryTriggerState: "unswept",
            hasUnsweptEntryTrigger: true,
            gateReason: "Local BSL inside zone is unswept — sweep required",
            entryTrigger: {
              level: 1.2745,
              type: "buy-side",
              nearEdge: "inside",
              distanceToZone: 0,
              maxDistance: 0.0005,
              state: "unswept",
            },
            sweepEvent: null,
          },
        }}
        symbol="GBP/USD"
      />,
    );

    expect(screen.getByText(/Local BSL inside zone is unswept/)).toBeTruthy();
    expect(screen.getByText(/\(2 nearby; 1 gating\)/)).toBeTruthy();
    expect(screen.queryByText("No significant pools near zone")).toBeNull();
  });

  it("labels contextual pools as non-gating", () => {
    render(
      <ZoneStoryPanel
        unifiedData={{
          ...unifiedData,
          liquidity: {
            liquidityScore: 0,
            summary: "2 contextual pool(s); none local enough to gate entry",
            nearbyPools: 2,
            entryTriggerState: "none",
            hasUnsweptEntryTrigger: false,
            gateReason: "2 contextual pool(s); none local enough to gate entry",
            entryTrigger: null,
            sweepEvent: null,
          },
        }}
        symbol="GBP/USD"
      />,
    );

    expect(screen.getByText(/none local enough to gate entry/)).toBeTruthy();
    expect(screen.getByText(/\(2 nearby; 0 gating\)/)).toBeTruthy();
  });

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

  it("shows the engine-owned impulse qualification state", () => {
    render(<ZoneStoryPanel unifiedData={unifiedData} gateData={gateData} symbol="GBP/USD" />);
    expect(screen.getByText("QUALIFIED")).toBeTruthy();
  });

  it("keeps timeframe diagnostics available when no impulse was found", () => {
    render(
      <ZoneStoryPanel
        unifiedData={{
          ...unifiedData,
          state: "no_impulse",
          hasZone: false,
          impulse: null,
          zone: null,
          reason: "No valid impulse on any configured timeframe",
        }}
        symbol="GBP/USD"
        direction="long"
        isLiveContext
      />,
    );

    expect(screen.getByText(/No Impulse/)).toBeTruthy();
    expect(screen.getByText(/Timeframe Evidence/)).toBeTruthy();
  });
  it("does not report a distance when no zone was found", () => {
    // Distance is measured against a zone. With none found the engine leaves
    // distancePips at its 0 default, and the Price row rendered that verbatim
    // as "0.0 pips away" — indistinguishable from price sitting exactly on the
    // zone, and shown directly beneath a Zone row with no qualified entry zone.
    //
    // Observed 2026-08-25 on XAU/USD: the Detail Breakdown claimed 0.0 pips
    // away while the Watchlist on the same screen reported 1514.9 pips for the
    // same instrument.
    render(
      <ZoneStoryPanel
        unifiedData={{
          ...unifiedData,
          hasZone: false,
          zone: null,
          price: { ...unifiedData.price, distancePips: 0, atZone: false, insideZone: false },
        }}
        gateData={gateData}
        symbol="XAU/USD"
      />,
    );

    expect(screen.getByText("No entry zone to measure against")).toBeTruthy();
    expect(screen.queryByText(/^0\.0 pips away$/)).toBeNull();
  });

  it("still reports a real distance when a zone exists", () => {
    render(
      <ZoneStoryPanel
        unifiedData={unifiedData}
        gateData={gateData}
        symbol="GBP/USD"
      />,
    );

    expect(screen.queryByText("No entry zone to measure against")).toBeNull();
  });

  it("labels loose proximity as near the zone instead of an exact zone touch", () => {
    render(
      <ZoneStoryPanel
        unifiedData={{
          ...unifiedData,
          state: "at_zone",
          price: {
            ...unifiedData.price,
            atZone: true,
            atZoneStrict: false,
            insideZone: false,
            sideOk: false,
            distancePips: 6.4,
          },
        }}
        symbol="GBP/USD"
      />,
    );

    expect(screen.getByText("Near zone (wrong side)")).toBeTruthy();
    expect(screen.queryByText("At zone (wrong side)")).toBeNull();
  });

  it("distinguishes an impulse candidate from a qualified entry zone", () => {
    render(
      <ZoneStoryPanel
        unifiedData={{
          ...unifiedData,
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
            direction: "bearish",
            high: 1.63148,
            low: 1.62313,
            pips: 83.5,
            timeframe: "1H",
            startDate: "2026-08-25T15:00:00Z",
            endDate: "2026-08-25T22:00:00Z",
            breakDate: "2026-08-25T18:00:00Z",
            extendedBeyondBreak: true,
            spanBars: 7,
            bosPrice: 1.62313,
            qualification: {
              state: "forming",
              reasons: ["No accepted FVG or Order Block was created by the impulse"],
              measurements: { breakType: "choch" },
            },
          },
          zone: null,
          price: {
            currentPrice: 1.624,
            atZone: false,
            atZoneStrict: false,
            insideZone: false,
            distancePips: 0,
            sideOk: false,
          },
          liquidity: null,
          confirmation: null,
          entry: null,
          reason: "No valid zone on any timeframe",
          storySummary: "Developing structural leg",
        }}
        zoneLocalEnforcement={{
          mode: {
            requestedMode: "observe",
            effectiveMode: "observe",
            certifiedMaximum: "observe",
            activationTrusted: false,
            reason: "no_activation",
          },
          allowed: true,
          scoreAdjustment: 0,
          minimumLocalScore: 1,
          reason: "observe_only",
        }}
        symbol="EUR/USD"
      />,
    );

    expect(screen.getByText("— No Entry Zone")).toBeTruthy();
    expect(screen.getByText("impulse via 1H")).toBeTruthy();
    expect(screen.getByText("1.63148 → 1.62313")).toBeTruthy();
    expect(screen.getByText("FORMING")).toBeTruthy();
    expect(screen.getByText("Extended after CHoCH")).toBeTruthy();
    expect(screen.getByText("CHoCH")).toBeTruthy();
    expect(screen.getByText(/confirmed/)).toBeTruthy();
    expect(screen.queryByText("BOS")).toBeNull();
    expect(screen.getByText("No qualified entry zone")).toBeTruthy();
    expect(screen.getByText("NOT APPLIED")).toBeTruthy();
    expect(screen.queryByText("ALLOWED")).toBeNull();
    expect(screen.getAllByText("Not evaluated — no entry zone")).toHaveLength(2);
    expect(screen.getByText("Unavailable — no entry zone")).toBeTruthy();
    expect(screen.getByText(/1H impulse candidate inspected; no entry zone selected/)).toBeTruthy();
    expect(screen.queryByText(/1H zone selected/)).toBeNull();
    expect(screen.queryByText(/Waiting for confirmation/)).toBeNull();
  });

  it("labels a completed BOS leg without an entry zone as completed rather than forming", () => {
    render(
      <ZoneStoryPanel
        unifiedData={{
          ...unifiedData,
          hasZone: false,
          state: "no_zone",
          zone: null,
          selectedTF: "1H",
          impulse: {
            ...unifiedData.impulse!,
            qualification: {
              state: "completed_unqualified",
              reasons: ["No accepted FVG or Order Block was created by the impulse"],
              measurements: { breakType: "bos" },
            },
          },
        }}
        symbol="AUD/USD"
      />,
    );

    expect(screen.getByText("COMPLETED — NOT QUALIFIED")).toBeTruthy();
    expect(screen.queryByText("FORMING")).toBeNull();
  });
});
