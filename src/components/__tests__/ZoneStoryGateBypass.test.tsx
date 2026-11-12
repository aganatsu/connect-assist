import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ZoneStoryPanel } from "../ZoneStoryPanel";

// The BTC/USD short of 2026-11-12: Unified TRIGGERED, zone score 3.5 with Min Zone Score 5.
const unified = {
  hasZone: true, state: "triggered", selectedTF: "1H", unifiedScore: 9.5,
  impulse: { direction: "bearish", high: 74996.01, low: 72727.27, origin: 74996.01, bosPrice: 72727.27 },
  zone: { type: "OB", high: 74399.995, low: 73682.13, fibLevel: 0.618, fibLabel: "61.8%", srConfirmed: true, htfLayers: [] },
  price: { atZone: true, insideZone: true, sideOk: true, distancePips: 0 },
  liquidity: { liquidityScore: 2, nearbyPools: [], summary: "BSL @ 74811.75667 (3 touches)", sweepEvent: null },
  scoreBreakdown: { baseScore: 3.5, liquidityBonus: 2, confirmationBonus: 2, tfBonus: 2 },
  entry: { direction: "short", entryPrice: 74050.49, slPrice: 74758.927, tpPrice: 72727.27 },
  confirmation: { type: "ltf_choch", detail: "LTF CHoCH (bearish)", entryReady: true, score: 2 },
};
const gate = {
  hasZone: true, selectedTF: "1H",
  bestZone: { totalScore: 3.5, high: 74399.995, low: 73682.13, type: "ob", ltfRefined: true, ltfType: "ob",
    zone: { poi: { type: "ob", high: 74399.995, low: 73682.13 }, fibLevel: 0.618, srConfirmed: true } },
};

describe("Zone Story gate-score badge", () => {
  it("says REJECTED when the setup went through the Impulse path", () => {
    render(<ZoneStoryPanel unifiedData={unified as never} gateData={gate as never} symbol="BTC/USD" minZoneScore={5} />);
    expect(screen.getByText(/Gate Score 3\.5\/9 — below min 5, REJECTED/)).toBeTruthy();
  });

  it("says bypassed (Unified path) when the Unified path skipped the gate", () => {
    render(<ZoneStoryPanel unifiedData={unified as never} gateData={gate as never} symbol="BTC/USD" minZoneScore={5} zoneGateBypassed />);
    expect(screen.getByText(/Gate Score 3\.5\/9 — below min 5, bypassed \(Unified path\)/)).toBeTruthy();
    expect(screen.queryByText(/REJECTED/)).toBeNull();
  });

  it("the live scan detail passes the flag from the scanner's signalSource", async () => {
    const { readFileSync } = await import("node:fs");
    const view = readFileSync("src/pages/BotView.tsx", "utf8");
    expect(view.match(/zoneGateBypassed=\{d\.signalSource === "unified"\}/g)?.length).toBe(2);
  });
});
