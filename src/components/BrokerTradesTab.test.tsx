import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SyncStatusContent } from "./BrokerTradesTab";

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
