/**
 * IPO dashboard — rendered UI contracts.
 *
 * These MOUNT the component rather than grepping its source. The existing
 * `IpoPaperMonitor.test.ts` greps, which is the right tool for "this file must
 * never contain a broker call"; it is the wrong tool for "the PAPER badge is
 * visible in every state", because a string can be present in a branch that
 * never renders.
 *
 * The presentational `IpoPaperDashboard` takes state as a prop, so nothing here
 * needs a network mock — which also means these tests cannot accidentally pass
 * because a fetch was stubbed into returning nothing.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// The module under test sits in the same file as the fetching wrapper, which
// imports the Supabase client at module scope; that client throws without env
// vars. Stubbed rather than restructured, because splitting the file would move
// the strings `IpoPaperMonitor.test.ts` greps for out from under it — and that
// test guards the read-only property, which is worth more than tidiness here.
// The stub is never called: IpoPaperDashboard takes its state as a prop.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

import { IpoPaperDashboard, type PaperState, type PaperTradeRow, type PaperPositionRow } from "../IpoPaperMonitor";

const NOW = Date.parse("2026-09-22T12:00:00Z");

const position = (over: Partial<PaperPositionRow> = {}): PaperPositionRow => ({
  symbol: "USD/JPY", timeframe: "30min", direction: "short", status: "open",
  entry_time: "2026-09-22T09:00:00Z", entry_price: 157.5, target_price: 156.5,
  s2_invalidation_level: 158.0, cost_r: 0.0123, nominal_risk_usd: 200,
  nominal_risk_distance: 0.5, ipo_candle_time: "2026-09-22T07:00:00Z",
  volatility_bucket: "HIGH_VOL", zone_entry_ordinal: 1, zone_previous_exit_time: null,
  mae_r: -0.3, mfe_r: 1.2, gap_reason: null, gap_from_bar_time: null,
  last_managed_bar_time: "2026-09-22T11:30:00Z", ...over,
});

const trade = (over: Partial<PaperTradeRow> = {}): PaperTradeRow => ({
  ...position(), exit_time: "2026-09-21T15:00:00Z", exit_price: 156.5,
  exit_reason: "TARGET_2R", realized_r: 2, gross_r: 2.02, realized_pnl_usd: 400,
  bars_held: 12, same_bar_ambiguous: false, excluded_from_stats: false,
  exclusion_reason: null, ...over,
});

const state = (over: Partial<PaperState> = {}): PaperState => ({
  health: {
    lastRunAt: "2026-09-22T11:45:00Z", lastSuccessAt: "2026-09-22T11:45:00Z",
    lastStatus: "OK", durationMs: 820, instrumentsChecked: 3, barsProcessed: 4,
    eventsEmitted: 1, bootstrapRequired: [], divergent: [], errorCode: null,
    errorMessage: null, consecutiveFailures: 0, strategyVersion: "spec-1.1",
  },
  healthStale: false, cadenceMs: 900_000,
  runtime: [{ symbol: "EUR/USD", timeframe: "1h", cursorBarTime: "2026-09-22T11:00:00Z",
              activatedAtBarTime: "2026-09-15T00:00:00Z", barsSeen: 1200, bootstrapCount: 1 }],
  openPositions: [], recentTrades: [], recentEvents: [],
  summary: { trades: 0, wins: 0, winRate: 0, totalR: 0, expectancyR: 0, totalPnlUsd: 0, abortedExcluded: 0 },
  ...over,
});

const draw = (s: PaperState) => render(<IpoPaperDashboard state={s} now={NOW} />);

// ── the PAPER badge ──────────────────────────────────────────────────────────

describe("the PAPER badge is always visible", () => {
  const cases: Array<[string, PaperState]> = [
    ["empty book", state()],
    ["no heartbeat", state({ health: null })],
    ["stale heartbeat", state({ healthStale: true })],
    ["open position", state({ openPositions: [position()] })],
    ["closed trades", state({ recentTrades: [trade(), trade({ realized_r: -1.4 })] })],
    ["suspended position", state({ openPositions: [position({ status: "data_gap_suspended", gap_reason: "COVERAGE_LOST" })] })],
    ["failed runner", state({ health: { ...state().health!, lastStatus: "FAILED", consecutiveFailures: 4, errorCode: "X", errorMessage: "boom" } })],
  ];

  for (const [label, s] of cases) {
    it(`renders PAPER with ${label}`, () => {
      draw(s);
      expect(screen.getByText("PAPER")).toBeInTheDocument();
    });
  }

  it("offers no way to trade from the dashboard", () => {
    draw(state({ openPositions: [position()], recentTrades: [trade()] }));
    for (const label of [/buy/i, /sell/i, /place order/i, /close position/i, /go live/i]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });
});

// ── summary metrics ──────────────────────────────────────────────────────────

describe("the summary strip leads with trader metrics", () => {
  it("shows counts, R, P&L and win rate from the rows", () => {
    draw(state({
      openPositions: [position()],
      recentTrades: [
        trade({ realized_r: 2, realized_pnl_usd: 400, exit_time: "2026-09-20T10:00:00Z" }),
        trade({ realized_r: -1.4, realized_pnl_usd: -280, exit_time: "2026-09-21T10:00:00Z",
                exit_reason: "S2_CLOSE_INVALIDATION" }),
      ],
    }));
    expect(screen.getByText("+0.60R")).toBeInTheDocument();     // 2 + (-1.4)
    expect(screen.getByText("$120.00")).toBeInTheDocument();    // 400 - 280
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("1W / 1L")).toBeInTheDocument();
  });

  it("shows drawdown with the window it covers", () => {
    draw(state({
      recentTrades: [
        trade({ realized_r: 3, exit_time: "2026-09-18T10:00:00Z" }),
        trade({ realized_r: -2, exit_time: "2026-09-19T10:00:00Z", exit_reason: "S2_CLOSE_INVALIDATION" }),
      ],
    }));
    expect(screen.getByText(/max 2\.00R · 2 trades/)).toBeInTheDocument();
  });

  it("reads zero rather than NaN on an empty book", () => {
    draw(state());
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("says the dollar figure is not a maximum loss", () => {
    draw(state());
    expect(screen.getByText(/NOT a maximum loss/)).toBeInTheDocument();
  });
});

// ── small sample ─────────────────────────────────────────────────────────────

describe("small-sample labelling appears when it should", () => {
  it("labels a single closed trade and does not imply a track record", () => {
    draw(state({ recentTrades: [trade()] }));
    expect(screen.getAllByText(/small sample · n=1/).length).toBeGreaterThan(0);
    expect(screen.getByText(/not estimates of future performance/)).toBeInTheDocument();
  });

  it("labels an empty book too — 0 is the smallest sample there is", () => {
    draw(state());
    expect(screen.getAllByText(/small sample · n=0/).length).toBeGreaterThan(0);
  });

  it("drops the label once the sample is big enough", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      trade({ exit_time: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T10:00:00Z` }));
    draw(state({ recentTrades: many }));
    expect(screen.queryByText(/small sample/)).toBeNull();
  });
});

// ── readable status ──────────────────────────────────────────────────────────

describe("raw statuses are rendered as sentences, with the code preserved", () => {
  it("translates an execution block and keeps the raw code on the row", () => {
    draw(state({
      recentEvents: [{
        bar_time: "2026-09-22T10:00:00Z", symbol: "BTC/USD", event_type: "REFUSED",
        strategy_decision: "WOULD_ENTER", account_decision: "UNAVAILABLE",
        reason_codes: [], payload: { costR: 2.4137, blockReason: "ECONOMICALLY_UNTRADEABLE_COST" },
      }],
    }));
    expect(screen.getByText(/Not taken — costs too much of the edge/)).toBeInTheDocument();
    expect(screen.getByText(/costR 2\.4137/)).toBeInTheDocument();
    // The raw code survives for debugging — in the cell and in its tooltip.
    // `getAllBy` because it deliberately appears in both.
    expect(screen.getAllByText(/ECONOMICALLY_UNTRADEABLE_COST/).length).toBeGreaterThan(0);
    expect(screen.getByTitle(/WOULD_ENTER/)).toBeInTheDocument();
  });

  it("translates a data gap and keeps its code", () => {
    draw(state({
      recentEvents: [{
        bar_time: "2026-09-22T10:00:00Z", symbol: "EUR/USD", event_type: "GAP_SUSPENDED",
        strategy_decision: "HOLD", account_decision: "UNAVAILABLE",
        reason_codes: ["COVERAGE_LOST"], payload: {},
      }],
    }));
    expect(screen.getByText(/Data gap — bars missing/)).toBeInTheDocument();
    // The raw cell splits its codes across text nodes, so the tooltip — which
    // carries every reason code — is the thing to assert on.
    expect(screen.getByTitle(/COVERAGE_LOST/)).toBeInTheDocument();
  });

  it("translates the exit reason on a closed row and keeps it hoverable", () => {
    draw(state({ recentTrades: [trade({ exit_reason: "S2_CLOSE_INVALIDATION", realized_r: -1.4 })] }));
    expect(screen.getByText("Stopped — S2 invalidation")).toBeInTheDocument();
    // Hoverable in the history row AND in the exit-reason split.
    expect(screen.getAllByTitle(/S2_CLOSE_INVALIDATION/).length).toBeGreaterThan(0);
  });

  it("shows an unknown code raw instead of inventing a meaning for it", () => {
    draw(state({
      recentEvents: [{
        bar_time: "2026-09-22T10:00:00Z", symbol: "EUR/USD", event_type: "SOMETHING_NEW",
        strategy_decision: "BRAND_NEW_VERDICT", account_decision: "UNAVAILABLE",
        reason_codes: [], payload: {},
      }],
    }));
    expect(screen.getByText(/Unrecognised code/)).toBeInTheDocument();
  });
});

// ── open positions ───────────────────────────────────────────────────────────

describe("open positions", () => {
  it("shows the plan, the ordinal, the bucket and the stored excursions", () => {
    draw(state({ openPositions: [position({ zone_entry_ordinal: 3 })] }));
    expect(screen.getByText("USD/JPY")).toBeInTheDocument();
    expect(screen.getByText("short")).toBeInTheDocument();
    expect(screen.getByText("HIGH_VOL")).toBeInTheDocument();
    expect(screen.getByText("RE-ENTRY #3")).toBeInTheDocument();
    expect(screen.getByText("1.20R")).toBeInTheDocument();      // MFE
    expect(screen.getByText("-0.30R")).toBeInTheDocument();     // MAE
  });

  it("states plainly that there is no current price, rather than leaving a blank", () => {
    draw(state({ openPositions: [position()] }));
    expect(screen.getByText(/no current price on\s+this page/i)).toBeInTheDocument();
    expect(screen.getByText(/unrealized R is not shown rather than guessed/i)).toBeInTheDocument();
  });

  it("reads a suspended position as a gap and a live one calmly", () => {
    draw(state({ openPositions: [position({ status: "data_gap_suspended", gap_reason: "COVERAGE_LOST" })] }));
    expect(screen.getByText(/SUSPENDED · COVERAGE_LOST/)).toBeInTheDocument();
    draw(state({ openPositions: [position()] }));
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
  });

  it("says Flat when there is nothing open", () => {
    draw(state());
    expect(screen.getByText("Flat.")).toBeInTheDocument();
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe("lifecycle strip", () => {
  it("renders all five stages in order", () => {
    draw(state());
    for (const label of ["Valid IPO", "Touch", "Trend", "Position open", "Target / S2"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("never shows Trend as achieved or failed", () => {
    draw(state({ openPositions: [position()], recentTrades: [trade()] }));
    expect(screen.getByTitle(/^TREND —/)).toBeInTheDocument();
    expect(screen.getByText(/not computed by the frozen rules/)).toBeInTheDocument();
  });
});

// ── health stays secondary and calm ──────────────────────────────────────────

describe("health is available but visually secondary", () => {
  it("keeps every engineering field", () => {
    draw(state());
    for (const label of ["last run", "last success", "consecutive failures", "duration",
                         "instruments", "bars processed", "events emitted", "strategy"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("a healthy runner shows OK and no alarm text", () => {
    draw(state());
    expect(screen.getAllByText("OK").length).toBeGreaterThan(0);
    expect(screen.queryByText(/No run for more than three scheduled intervals/)).toBeNull();
    expect(screen.queryByText(/DIVERGENCE/)).toBeNull();
  });

  it("a stale runner does raise an alarm", () => {
    draw(state({ healthStale: true }));
    expect(screen.getAllByText("STALE").length).toBeGreaterThan(0);
    expect(screen.getByText(/No run for more than three scheduled intervals/)).toBeInTheDocument();
  });

  it("puts the health card after the trader sections in document order", () => {
    const { container } = draw(state({ openPositions: [position()] }));
    const text = container.textContent ?? "";
    expect(text.indexOf("IPO forward test")).toBeLessThan(text.indexOf("Open paper positions"));
    expect(text.indexOf("Open paper positions")).toBeLessThan(text.indexOf("Runner health"));
    expect(text.indexOf("Why no trade?")).toBeLessThan(text.indexOf("Runner health"));
  });
});

// ── history and filters ──────────────────────────────────────────────────────

describe("trade history", () => {
  it("shows entry→exit, R, P&L, ordinal, bucket and both excursions", () => {
    draw(state({ recentTrades: [trade({ zone_entry_ordinal: 2 })] }));
    const table = screen.getByText("Trade history").closest(".rounded-none") as HTMLElement;
    const t = within(table);
    // Prices above 100 render at 2dp, below at 5dp — a JPY pair is the 2dp case.
    // The cell interleaves text nodes around the arrow, so match on the cell's
    // own textContent rather than on a single node.
    expect(t.getByText((_, el) => el?.tagName === "TD"
      && /157\.50\s*→\s*156\.50/.test(el.textContent ?? ""))).toBeInTheDocument();
    expect(t.getByText("2.0000")).toBeInTheDocument();
    expect(t.getByText("$400.00")).toBeInTheDocument();
  });

  it("exposes a filter for each requested dimension", () => {
    draw(state({ recentTrades: [trade()] }));
    for (const label of [/filter by symbol/i, /filter by volatility bucket/i,
                         /filter by entry ordinal/i, /filter by exit reason/i]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText(/filter from date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/filter to date/i)).toBeInTheDocument();
  });

  it("distinguishes an empty book from an empty filter result", () => {
    draw(state());
    expect(screen.getByText("No closed paper trades yet.")).toBeInTheDocument();
  });
});
