import { readFileSync } from "node:fs";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OpenPositionsContent, SyncStatusContent } from "./BrokerTradesTab";

const paperPosition = {
  id: "paper-1",
  symbol: "EUR/USD",
  direction: "long",
  stop_loss: 1.08,
};

const orphanBrokerPosition = {
  id: "broker-1",
  symbol: "GBP/USD",
  comment: "paper:missing-position",
  stopLoss: 1.25,
};

describe("BrokerTrades sync truth", () => {
  it("does not render sync or orphan verdicts while either source is fetching", () => {
    const { container } = render(
      <SyncStatusContent
        brokerPositions={[orphanBrokerPosition]}
        paperPositions={[paperPosition]}
        isLoading
      />,
    );

    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    expect(screen.queryByText("NOT ON BROKER")).not.toBeInTheDocument();
    expect(screen.queryByText("Orphaned on broker")).not.toBeInTheDocument();
  });

  it("does not render sync or orphan verdicts when either source failed", () => {
    render(
      <SyncStatusContent
        brokerPositions={[orphanBrokerPosition]}
        paperPositions={[paperPosition]}
        isLoading={false}
        error="Broker position state is unavailable"
      />,
    );

    expect(screen.getByText("Broker position state is unavailable")).toBeInTheDocument();
    expect(screen.queryByText("NOT ON BROKER")).not.toBeInTheDocument();
    expect(screen.queryByText("Orphaned on broker")).not.toBeInTheDocument();
  });

  it("renders a mismatch only after both sources are available", () => {
    render(
      <SyncStatusContent
        brokerPositions={[]}
        paperPositions={[paperPosition]}
        isLoading={false}
      />,
    );

    expect(screen.getByText("NOT ON BROKER")).toBeInTheDocument();
  });
});


describe("BrokerTrades position actions", () => {
  it("derives close capability only from the selected connection position read", () => {
    const source = readFileSync("src/components/BrokerTradesTab.tsx", "utf8");
    expect(source).toContain(
      "const brokerCloseEnabled = !!connId && positionsAvailable &&\n" +
        "    Array.isArray(brokerPositions);",
    );
  });

  it("keeps close available when stale aggregate truth disables SL/TP edits", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const props: ComponentProps<typeof OpenPositionsContent> = {
      positions: [{
        id: "trade-1",
        symbol: "EUR/USD",
        type: "POSITION_TYPE_BUY",
        openPrice: 1.1,
        currentPrice: 1.11,
        volume: 0.1,
        profit: 10,
      }],
      paperPositions: [],
      connectionId: "broker-1",
      isLoading: false,
      modifyEnabled: false,
      closeEnabled: true,
      mutationUnavailableMessage: "Current broker truth is unavailable",
    };

    render(
      <QueryClientProvider client={queryClient}>
        <OpenPositionsContent {...props} />
      </QueryClientProvider>,
    );

    expect(screen.getByTitle("Broker state unavailable")).toBeDisabled();
    expect(screen.getAllByTitle("Close position")).toHaveLength(2);
    for (const closeButton of screen.getAllByTitle("Close position")) {
      expect(closeButton).toBeEnabled();
    }
    expect(screen.getByRole("button", { name: "Close EUR/USD position" })).toBeEnabled();
  });
});
