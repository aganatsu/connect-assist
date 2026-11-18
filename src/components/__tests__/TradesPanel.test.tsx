import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TradesPanel } from "../TradesPanel";
import { toChartTrades } from "@/lib/chartTrades";

const trades = toChartTrades({
  positions: [{ id: "o1", symbol: "EUR/USD", direction: "long", entryPrice: 1.1, currentPrice: 1.101, stopLoss: 1.098, takeProfit: 1.104, openTime: "2026-11-18T10:00:00Z", pnl: 10 }],
  tradeHistory: [{
    id: "btc-1", symbol: "BTC/USD", direction: "short", entryPrice: 64777.4, exitPrice: 63421.56,
    stopLoss: 65489.22, takeProfit: 63421.56, openTime: "2026-11-17T22:52:02Z", closedAt: "2026-11-18T14:40:02Z",
    closeReason: "tp_hit", pnl: 989.76,
    signalReason: JSON.stringify({ originalSL: 65489.22, originalTP: 63421.56,
      unifiedZone: { impulse: { direction: "bearish", high: 66100, low: 64500 }, zone: { low: 64700, high: 64950, type: "ob" } } }),
  }],
});

describe("TradesPanel", () => {
  it("shows the selected trade with its result, reason and the bot's record at entry", () => {
    render(<TradesPanel trades={trades} selectedId="btc-1" onSelect={() => {}} excursion={null} />);
    expect(screen.getAllByText("BTC/USD").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Target hit").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+1.90R").length).toBeGreaterThan(0);
    expect(screen.getByText("+$989.76")).toBeTruthy();
    expect(screen.getByText("66100.00 → 64500.00")).toBeTruthy();   // impulse at entry
  });

  it("shows times in UTC, like the chart axis, whatever the browser's timezone", () => {
    render(<TradesPanel trades={trades} selectedId="btc-1" onSelect={() => {}} excursion={null} />);
    expect(screen.getAllByText(/18 Nov, 14:40 UTC/).length).toBeGreaterThan(0);   // closedAt 14:40:02Z
    expect(screen.getAllByText(/17 Nov, 22:52 UTC/).length).toBeGreaterThan(0);   // openTime 22:52:02Z
  });

  it("lists open trades above closed ones and selects on click", () => {
    const onSelect = vi.fn();
    render(<TradesPanel trades={trades} selectedId={null} onSelect={onSelect} excursion={null} />);
    const headings = screen.getAllByText(/^(Open|Recent closed)/).map((n) => n.textContent);
    expect(headings[0]).toBe("Open");
    fireEvent.click(screen.getByText("EUR/USD"));
    expect(onSelect).toHaveBeenCalledWith("o1");
  });
});
