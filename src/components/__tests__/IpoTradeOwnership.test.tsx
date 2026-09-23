/**
 * Rendered proof that lifecycle and execution stay separate in the UI.
 *
 * The unit tests cover the mapping; these cover the thing a reader actually
 * sees, which is where the original confusion lived.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

import { IpoScanDetail, type IpoRow } from "../IpoScanDetail";
import { IpoPaperDashboard, type PaperState, type PaperEventRow } from "../IpoPaperMonitor";
import { classifyRow, type PositionLike, type ClosedLike, type RowLike } from "@/lib/ipoTradeLinkage";

const row = (over: Partial<IpoRow> = {}): IpoRow => ({
  instrument: "USD/JPY", timeframe: "30min", direction: "short",
  ipoCandleTime: "2026-09-22T07:30:00Z", ipoIndex: 412,
  zoneHigh: 157.6, zoneLow: 157.4, midpoint: 157.5,
  state: "VALID_TOUCHED", signalValid: true,
  validationStatus: "VALIDATED@410", observationStatus: "TOUCHED_THIS_BAR",
  fvgPresent: true, fvgStatus: "CONFIRMED",
  contraction: "NO", touch: "YES", oppositeSideCleared: "YES",
  moveAway: "NOT_TRACKED", expansion: "NOT_TRACKED", trend: "NOT_TRACKED",
  volatilityBucket: "HIGH_VOL", volatilityEligible: true,
  intendedEntry: 157.5, target2R: 156.5, s2Invalidation: 158.0, riskPrice: 0.5,
  sequencingState: "FREE", executionEligible: false, reasonCodes: [], ...over,
});

const pos = (over: Partial<PositionLike> = {}): PositionLike => ({
  symbol: "USD/JPY", timeframe: "30min", direction: "short",
  ipo_candle_time: "2026-09-22 07:30:00+00",
  entry_time: "2026-09-22T09:00:00Z", entry_price: 157.5, target_price: 156.5,
  s2_invalidation_level: 158.0, volatility_bucket: "HIGH_VOL", zone_entry_ordinal: 3,
  setup_id: "stp_4444a16ec717d0b4", intent_id: "int_10ef91e52f8a79d0", status: "open", ...over,
});

const closed = (over: Partial<ClosedLike> = {}): ClosedLike => ({
  ...pos(), exit_time: "2026-09-23T07:00:00Z", exit_price: 157.77,
  exit_reason: "S2_CLOSE_INVALIDATION", realized_r: -1.5990, realized_pnl_usd: -319.80, ...over,
});

const asRowLike = (r: IpoRow): RowLike => r;

describe("the open-position owner is unmistakable", () => {
  it("announces that this exact IPO triggered the current trade", () => {
    const link = classifyRow(asRowLike(row()), [pos()], []);
    render(<IpoScanDetail row={row()} link={link} />);
    expect(screen.getByText("This IPO triggered the current trade")).toBeInTheDocument();
  });

  it("shows every identifying field of the owned trade", () => {
    const link = classifyRow(asRowLike(row()), [pos()], []);
    render(<IpoScanDetail row={row()} link={link} />);
    const banner = screen.getByText("This IPO triggered the current trade").closest("section")!;
    const b = within(banner);
    for (const label of ["symbol", "timeframe", "direction", "IPO candle time", "entry time",
                         "entry price", "target", "S2 invalidation", "volatility bucket",
                         "setup_id", "intent_id", "zone entry ordinal"]) {
      expect(b.getByText(label)).toBeInTheDocument();
    }
    expect(b.getByText("stp_4444a16ec717d0b4")).toBeInTheDocument();
    expect(b.getByText("int_10ef91e52f8a79d0")).toBeInTheDocument();
    expect(b.getByText(/3 · 3rd entry from this IPO/)).toBeInTheDocument();
  });

  it("does not claim ownership for a row that merely reads VALID_TOUCHED", () => {
    const other = row({ ipoCandleTime: "2026-09-22T06:30:00Z", ipoIndex: 400 });
    const link = classifyRow(asRowLike(other), [pos()], []);
    render(<IpoScanDetail row={other} link={link} />);
    expect(screen.queryByText("This IPO triggered the current trade")).toBeNull();
  });
});

describe("blocked rows name the real owner", () => {
  const blocked = row({ ipoCandleTime: "2026-09-22T06:30:00Z", ipoIndex: 400 });

  it("says this IPO did not enter, and why", () => {
    const link = classifyRow(asRowLike(blocked), [pos()], []);
    render(<IpoScanDetail row={blocked} link={link} />);
    expect(screen.getByText("This IPO did not enter")).toBeInTheDocument();
    expect(screen.getByText(/another IPO on this instrument already owns the open position/i))
      .toBeInTheDocument();
    expect(screen.getByText(/Blocked by existing USD\/JPY SHORT position/)).toBeInTheDocument();
  });

  it("shows the owning trade's identity, not the blocked row's own", () => {
    const link = classifyRow(asRowLike(blocked), [pos()], []);
    render(<IpoScanDetail row={blocked} link={link} />);
    const section = screen.getByText("This IPO did not enter").closest("section")!;
    const s = within(section);
    expect(s.getByText("2026-09-22 07:30")).toBeInTheDocument();     // owner's IPO candle
    expect(s.queryByText("2026-09-22 06:30")).toBeNull();            // not the blocked row's
    expect(s.getByText("stp_4444a16ec717d0b4")).toBeInTheDocument();
    for (const label of ["owner direction", "owner IPO candle time", "entry time", "entry price",
                         "target", "S2", "setup_id", "intent_id", "zone entry ordinal"]) {
      expect(s.getByText(label)).toBeInTheDocument();
    }
  });

  it("shows no blocked banner when nothing is open", () => {
    const link = classifyRow(asRowLike(blocked), [], []);
    render(<IpoScanDetail row={blocked} link={link} />);
    expect(screen.queryByText("This IPO did not enter")).toBeNull();
  });
});

describe("closed trades map back to their IPO", () => {
  it("renders the close with a readable exit reason", () => {
    const link = classifyRow(asRowLike(row()), [], [closed()]);
    render(<IpoScanDetail row={row()} link={link} />);
    const section = screen.getByText("Closed trade").closest("section")!;
    const s = within(section);
    expect(s.getByText("Stopped — S2 invalidation")).toBeInTheDocument();
    expect(s.getByText("-1.5990R")).toBeInTheDocument();
    expect(s.getByText("$-319.80")).toBeInTheDocument();
    expect(s.getByText(/3 · 3rd entry from this IPO/)).toBeInTheDocument();
  });

  it("reads a target exit as target hit", () => {
    const link = classifyRow(asRowLike(row()), [], [closed({ exit_reason: "TARGET_2R", realized_r: 1.96 })]);
    render(<IpoScanDetail row={row()} link={link} />);
    expect(within(screen.getByText("Closed trade").closest("section")!)
      .getByText("Target hit")).toBeInTheDocument();
  });
});

// ── Why no trade? ────────────────────────────────────────────────────────────

const event = (over: Partial<PaperEventRow> = {}): PaperEventRow => ({
  bar_time: "2026-09-23T14:00:00Z", symbol: "BTC/USD", event_type: "MANAGED",
  strategy_decision: "HOLD", account_decision: "UNAVAILABLE", reason_codes: [], payload: {}, ...over,
});

const state = (events: PaperEventRow[]): PaperState => ({
  health: null, healthStale: false, cadenceMs: 900_000, runtime: [],
  openPositions: [], recentTrades: [], recentEvents: events,
  summary: { trades: 0, wins: 0, winRate: 0, totalR: 0, expectancyR: 0, totalPnlUsd: 0, abortedExcluded: 0 },
});

describe("Why no trade? leads with the execution event", () => {
  it("a filled row says the trade entered, with the verdict underneath", () => {
    render(<IpoPaperDashboard state={state([
      event({ event_type: "FILLED", strategy_decision: "WOULD_ENTER" }),
    ])} />);
    expect(screen.getByText("Trade entered")).toBeInTheDocument();
    expect(screen.getByText("Strategy verdict: WOULD_ENTER")).toBeInTheDocument();
    // The old collapse.
    expect(screen.queryByText("Strategy would enter")).toBeNull();
  });

  it("an intent row says qualified, and explicitly not filled", () => {
    render(<IpoPaperDashboard state={state([
      event({ event_type: "INTENT_CREATED", strategy_decision: "WOULD_ENTER" }),
    ])} />);
    expect(screen.getByText("Qualified — intent created")).toBeInTheDocument();
    expect(screen.getByText(/does not prove a fill/i)).toBeInTheDocument();
    expect(screen.queryByText("Trade entered")).toBeNull();
  });

  it("the two are visibly different rows, not one label", () => {
    render(<IpoPaperDashboard state={state([
      event({ event_type: "FILLED", strategy_decision: "WOULD_ENTER" }),
      event({ event_type: "INTENT_CREATED", strategy_decision: "WOULD_ENTER" }),
    ])} />);
    expect(screen.getByText("Trade entered")).toBeInTheDocument();
    expect(screen.getByText("Qualified — intent created")).toBeInTheDocument();
  });

  it("closes read as target hit or stopped by S2", () => {
    render(<IpoPaperDashboard state={state([
      event({ event_type: "CLOSED", strategy_decision: "WOULD_EXIT", reason_codes: ["TARGET_2R"] }),
      event({ event_type: "CLOSED", strategy_decision: "WOULD_EXIT",
              reason_codes: ["S2_CLOSE_INVALIDATION"], symbol: "USD/JPY" }),
    ])} />);
    expect(screen.getByText("Target hit")).toBeInTheDocument();
    expect(screen.getByText("Stopped — S2 invalidation")).toBeInTheDocument();
  });

  it("a refusal reads did not enter and never implies entry", () => {
    render(<IpoPaperDashboard state={state([
      event({ event_type: "REFUSED", strategy_decision: "WOULD_ENTER",
              payload: { blockReason: "POSITION_ALREADY_OPEN" } }),
    ])} />);
    expect(screen.getByText("Did not enter")).toBeInTheDocument();
    expect(screen.queryByText("Trade entered")).toBeNull();
  });

  it("states the rule on the page", () => {
    render(<IpoPaperDashboard state={state([event()])} />);
    expect(screen.getByText(/WOULD_ENTER does not mean entered\. FILLED proves entry\./))
      .toBeInTheDocument();
  });
});
