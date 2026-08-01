import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TimeframeEvidencePanel } from "./TimeframeEvidencePanel";
import { formatTimeframeLadder } from "./timeframeEvidenceFormat";

const queryCalls = vi.hoisted(() => ({
  from: vi.fn(),
  eq: vi.fn(),
  order: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: queryCalls.from,
  },
}));

function queryBuilder(data: unknown[] = []) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: string) => {
      queryCalls.eq(column, value);
      return builder;
    }),
    order: vi.fn((column: string, options: unknown) => {
      queryCalls.order(column, options);
      return builder;
    }),
    limit: vi.fn(() => Promise.resolve({ data, error: null })),
  };
  return builder;
}

function installQueryResult(data: unknown[] = []) {
  queryCalls.from.mockReturnValue(queryBuilder(data));
}

describe("TimeframeEvidencePanel evidence binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installQueryResult([]);
  });

  it("loads lazily and binds a historical row by exact evidence UUID", async () => {
    installQueryResult([{
      id: "evidence-123",
      symbol: "GBP/USD",
      direction: "bullish",
      observed_at: "2026-08-01T12:00:00.000Z",
      trading_style: "day_trader",
      selected_timeframe: "1h",
      final_reason: "zone selected",
      slots: [],
      payload_truncated: false,
    }]);
    render(
      <TimeframeEvidencePanel
        symbol="GBP/USD"
        evidenceId="evidence-123"
      />,
    );
    expect(queryCalls.from).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Timeframe Evidence/ }));

    await waitFor(() => expect(queryCalls.from).toHaveBeenCalledTimes(1));
    expect(queryCalls.eq).toHaveBeenCalledWith("id", "evidence-123");
    expect(queryCalls.eq).not.toHaveBeenCalledWith("symbol", "GBP/USD");
  });

  it("falls back to the immutable compact summary after raw evidence expires", async () => {
    queryCalls.from
      .mockReturnValueOnce(queryBuilder([]))
      .mockReturnValueOnce(queryBuilder([{
        evidence_id: "evidence-compact",
        observed_at: "2026-05-01T12:00:00.000Z",
        direction: "bearish",
        selected_timeframe: "4h",
        final_reason: "no qualifying POI",
        winner_candidate_id: null,
        rejection_code_counts: { all_pois_failed_qualification: 3 },
        evidence_hash: "abc123",
      }]));

    render(
      <TimeframeEvidencePanel
        symbol="GBP/USD"
        evidenceId="evidence-compact"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Timeframe Evidence/ }));

    expect(
      await screen.findByText(/Compact retained summary/),
    ).toBeTruthy();
    expect(screen.getByText(/all_pois_failed_qualification ×3/)).toBeTruthy();
    expect(queryCalls.from).toHaveBeenNthCalledWith(
      2,
      "zone_timeframe_evidence_summary",
    );
  });

  it("never substitutes latest symbol evidence for an unlinked historical row", async () => {
    render(<TimeframeEvidencePanel symbol="GBP/USD" />);
    fireEvent.click(screen.getByRole("button", { name: /Timeframe Evidence/ }));

    expect(
      await screen.findByText(/latest symbol evidence is intentionally not substituted/i),
    ).toBeTruthy();
    expect(queryCalls.from).not.toHaveBeenCalled();
  });

  it("allows latest-by-symbol lookup only for an explicit live context", async () => {
    render(
      <TimeframeEvidencePanel
        symbol="GBP/USD"
        direction="long"
        isLiveContext
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Timeframe Evidence/ }));

    await waitFor(() => expect(queryCalls.from).toHaveBeenCalledTimes(1));
    expect(queryCalls.eq).toHaveBeenCalledWith("symbol", "GBP/USD");
    expect(queryCalls.eq).toHaveBeenCalledWith("evidence_source", "live_scan");
    expect(queryCalls.eq).toHaveBeenCalledWith("direction", "bullish");
  });

  it("renders nested timeframe roles without stringifying the roles object", () => {
    expect(formatTimeframeLadder({
      roles: {
        bias: "1h",
        structure: "15min",
        setup: "5min",
        confirmation: "5min",
        refinement: "1min",
      },
      runtimeHTF: "1h",
      runtimeEntry: "5m",
    })).toBe(
      "Bias 1h → Structure 15min → Setup 5min → Confirmation 5min → Refinement 1min → Runtime HTF 1h → Runtime entry 5m",
    );
  });
});
