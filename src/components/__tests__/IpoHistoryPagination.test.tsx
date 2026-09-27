/**
 * Pagination of the two lists that grow without bound: the decision log and the
 * closed-trade history.
 */
import { render, screen, within, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

import {
  IpoPaperDashboard, type PaperState, type PaperEventRow, type PaperTradeRow,
} from "../IpoPaperMonitor";

const NOW = Date.parse("2026-09-23T12:00:00Z");

const event = (i: number): PaperEventRow => ({
  bar_time: new Date(NOW - i * 3_600_000).toISOString(),
  symbol: i % 2 ? "EUR/USD" : "BTC/USD",
  event_type: "MANAGED", strategy_decision: "HOLD", account_decision: "UNAVAILABLE",
  reason_codes: [], payload: {},
});

const trade = (i: number): PaperTradeRow => ({
  symbol: "USD/JPY", timeframe: "30min", direction: "short", status: "closed",
  entry_time: new Date(NOW - i * 7_200_000).toISOString(), entry_price: 157.5,
  target_price: 156.5, s2_invalidation_level: 158, cost_r: 0.01,
  nominal_risk_usd: 200, nominal_risk_distance: 0.5,
  ipo_candle_time: new Date(NOW - i * 7_200_000).toISOString(),
  volatility_bucket: "HIGH_VOL", zone_entry_ordinal: 1, zone_previous_exit_time: null,
  mae_r: -0.2, mfe_r: 1.1, gap_reason: null, gap_from_bar_time: null,
  exit_time: new Date(NOW - i * 3_600_000).toISOString(), exit_price: 156.5,
  exit_reason: "TARGET_2R", realized_r: 2, gross_r: 2.02, realized_pnl_usd: 400,
  bars_held: 10, same_bar_ambiguous: false, excluded_from_stats: false, exclusion_reason: null,
});

const state = (events: PaperEventRow[], trades: PaperTradeRow[]): PaperState => ({
  health: null, healthStale: false, cadenceMs: 900_000, runtime: [],
  openPositions: [], recentTrades: trades, recentEvents: events,
  summary: { trades: trades.length, wins: 0, winRate: 0, totalR: 0, expectancyR: 0,
             totalPnlUsd: 0, abortedExcluded: 0 },
});

const card = (title: string) =>
  screen.getByText(title).closest(".rounded-none") as HTMLElement;

const draw = (events: PaperEventRow[], trades: PaperTradeRow[]) =>
  render(<IpoPaperDashboard state={state(events, trades)} now={NOW} />);

const rowsIn = (title: string) => {
  const table = within(card(title)).getByRole("table");
  return within(table).getAllByRole("row").slice(1);
};

describe("Why no trade? pagination", () => {
  const events = Array.from({ length: 37 }, (_, i) => event(i));

  it("shows 15 events per page by default", () => {
    draw(events, []);
    const c = within(card("Why no trade?"));
    expect(c.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(rowsIn("Why no trade?")).toHaveLength(15);
  });

  it("no longer truncates the tail at 40 rows with no way to reach it", () => {
    draw(Array.from({ length: 60 }, (_, i) => event(i)), []);
    const c = within(card("Why no trade?"));
    expect(c.getByText("Page 1 of 4")).toBeInTheDocument();
    expect(c.getByText("Showing 1–15 of 60")).toBeInTheDocument();
  });

  it("pages forward", () => {
    draw(events, []);
    const c = within(card("Why no trade?"));
    fireEvent.click(c.getByRole("button", { name: "Next" }));
    expect(c.getByText("Page 2 of 3")).toBeInTheDocument();
    expect(c.getByText("Showing 16–30 of 37")).toBeInTheDocument();
  });

  it("offers its own page sizes", () => {
    draw(events, []);
    const sel = within(card("Why no trade?")).getByLabelText("events per page") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(["15", "30", "60"]);
    fireEvent.change(sel, { target: { value: "60" } });
    expect(within(card("Why no trade?")).getByText("Page 1 of 1")).toBeInTheDocument();
  });

  it("renders no pager when there are no decisions", () => {
    draw([], []);
    expect(within(card("Why no trade?")).queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByText("No decisions recorded yet.")).toBeInTheDocument();
  });
});

describe("closed-trade history pagination", () => {
  const trades = Array.from({ length: 23 }, (_, i) => trade(i));

  it("shows 10 trades per page by default", () => {
    draw([], trades);
    const c = within(card("Trade history"));
    expect(c.getByText("Page 1 of 3")).toBeInTheDocument();
    expect(rowsIn("Trade history")).toHaveLength(10);
  });

  it("pages forward to a short last page", () => {
    draw([], trades);
    const c = within(card("Trade history"));
    fireEvent.click(c.getByRole("button", { name: "Next" }));
    fireEvent.click(c.getByRole("button", { name: "Next" }));
    expect(c.getByText("Page 3 of 3")).toBeInTheDocument();
    expect(rowsIn("Trade history")).toHaveLength(3);
    expect(c.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("paginates the FILTERED set, and the header count agrees", () => {
    draw([], trades);
    const c = within(card("Trade history"));
    // The header already reports the filtered total; the pager must match it.
    expect(c.getByText(/Trade history/)).toBeInTheDocument();
    expect(c.getByText("Showing 1–10 of 23")).toBeInTheDocument();
  });

  it("renders no pager on an empty book", () => {
    draw([], []);
    expect(within(card("Trade history")).queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.getByText("No closed paper trades yet.")).toBeInTheDocument();
  });
});

describe("what is deliberately NOT paginated", () => {
  it("leaves the summary strip and open positions alone", () => {
    draw([], [trade(0)]);
    // Summary metrics and open positions are short by construction; a pager
    // there would be noise.
    // The heading now names the evidence lens. Without a `causal` block the
    // panel degrades to the pooled view, which says so in its own title.
    const summary = card("ALL HISTORY — NOT VALID FOR PERFORMANCE EVALUATION");
    expect(within(summary).queryByRole("button", { name: "Next" })).toBeNull();
    const open = card("Open paper positions (0)");
    expect(within(open).queryByRole("button", { name: "Next" })).toBeNull();
  });
});
