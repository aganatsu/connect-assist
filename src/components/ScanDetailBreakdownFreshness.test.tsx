import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ScanDetailBreakdown } from "./ScanDetailBreakdown";

vi.mock("./ZoneStoryPanel", () => ({
  ZoneStoryPanel: ({ isLiveContext }: { isLiveContext?: boolean }) => (
    <div>{isLiveContext ? "LIVE ZONE CONTEXT" : "HISTORICAL ZONE SNAPSHOT"}</div>
  ),
}));

const signal = {
  pair: "EUR/USD",
  direction: "long",
  score: 50,
  status: "watching_zone",
  reason: "Watching zone",
  factors: [],
  gates: [],
  unifiedZone: { state: "watching" },
};

describe("ScanDetailBreakdown scan freshness", () => {
  afterEach(() => vi.useRealTimers());

  it("does not present an old scan snapshot as live zone context", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T18:10:00Z"));

    render(
      <ScanDetailBreakdown
        signal={signal}
        observedAt="2026-08-26T18:00:00Z"
      />,
    );

    expect(screen.getByText("HISTORICAL ZONE SNAPSHOT")).toBeInTheDocument();
    expect(screen.queryByText("LIVE ZONE CONTEXT")).toBeNull();
  });

  it("retains live context for a fresh scan", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T18:01:00Z"));

    render(
      <ScanDetailBreakdown
        signal={signal}
        observedAt="2026-08-26T18:00:00Z"
      />,
    );

    expect(screen.getByText("LIVE ZONE CONTEXT")).toBeInTheDocument();
  });
});
