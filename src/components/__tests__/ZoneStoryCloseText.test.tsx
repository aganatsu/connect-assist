import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ZoneStoryPanel } from "../ZoneStoryPanel";
import { describeClose } from "@/lib/candleCloseText";

// XAU/USD 1H bearish impulse the owner asked about on 2026-11-16: "Closes: origin 57% · BOS 94%".
const unified = {
  hasZone: true, state: "watching", selectedTF: "1H", unifiedScore: 8,
  impulse: {
    direction: "bearish", high: 3901.178, low: 3833.621, origin: 3901.178, bosPrice: 3833.621,
    candleQuality: { originCloseStrength: 0.57, bosCloseStrength: 0.94, bosRejectionWick: 0.05 },
  },
  zone: { type: "OB", high: 3900.71, low: 3877.446, fibLevel: 0.786, fibLabel: "78.6%", srConfirmed: true, htfLayers: [] },
  price: { atZone: false, insideZone: false, sideOk: true, distancePips: 340.6 },
  liquidity: { liquidityScore: 0, nearbyPools: [], summary: "No significant pools near zone", sweepEvent: null },
  scoreBreakdown: { baseScore: 6, liquidityBonus: 0, confirmationBonus: 0, tfBonus: 2 },
  entry: null,
  confirmation: null,
};

describe("Zone Story: how the candles closed, in plain words", () => {
  it("names each candle and says where it closed for a bearish move", () => {
    render(<ZoneStoryPanel unifiedData={unified as never} gateData={null as never} symbol="XAU/USD" />);
    expect(screen.getByText("Break candle (BOS):")).toBeTruthy();
    expect(screen.getByText("closed near its low (94%) — strong")).toBeTruthy();
    expect(screen.getByText("Start candle (origin):")).toBeTruthy();
    expect(screen.getByText("closed near the middle (57%) — undecided")).toBeTruthy();
    expect(screen.queryByText(/^Closes:/)).toBeNull();
  });

  it("flips to the high for a bullish move, and calls a weak close rejected", () => {
    expect(describeClose(0.85, "bullish").text).toBe("closed near its high (85%) — strong");
    expect(describeClose(0.22, "bullish")).toEqual({ tone: "weak", text: "closed back toward its low (22%) — rejected" });
    expect(describeClose(0.65, "bearish").text).toBe("closed in its lower part (65%) — solid");
  });
});
