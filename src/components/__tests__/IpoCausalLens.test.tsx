/**
 * The causal forward lens — rendered, not grepped.
 *
 * WHAT THIS GUARDS. The dashboard used to pool pre-fix and post-fix trades into
 * one headline: 11 closed, +12.91R, ~82% win. Pre-fix rows could book a same-bar
 * target whose excursion happened BEFORE the entry, so that headline was not a
 * measurement of anything. The database keeps every row; the LENS changed.
 *
 * The first screen must answer "what has the trustworthy forward strategy done
 * since the fix" without the reader mentally subtracting legacy trades — so
 * these tests mount the component and read what a user would see.
 */
import { render, screen, within, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// Same reason as IpoDashboardUi: the module imports the Supabase client at
// module scope. The stub is never called — the dashboard takes state as a prop.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

import {
  IpoPaperDashboard,
  type PaperState, type PaperTradeRow, type PaperPositionRow, type CausalReportView,
} from "../IpoPaperMonitor";
import { fmtPF, fmtPct, type PerfLike } from "@/lib/ipoDashboard";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const V = "1m-ordering-v1";
const START = "2026-09-24T17:36:19Z";

const position = (over: Partial<PaperPositionRow> = {}): PaperPositionRow => ({
  symbol: "USD/JPY", timeframe: "30min", direction: "short", status: "open",
  entry_time: "2026-09-25T09:00:00Z", entry_price: 157.5, target_price: 156.5,
  s2_invalidation_level: 158.0, cost_r: 0.0123, nominal_risk_usd: 200,
  nominal_risk_distance: 0.5, ipo_candle_time: "2026-09-25T07:00:00Z",
  volatility_bucket: "HIGH_VOL", zone_entry_ordinal: 1, zone_previous_exit_time: null,
  mae_r: -0.3, mfe_r: 1.2, gap_reason: null, gap_from_bar_time: null,
  last_managed_bar_time: "2026-09-25T11:30:00Z", ...over,
});

const trade = (over: Partial<PaperTradeRow> = {}): PaperTradeRow => ({
  ...position(), exit_time: "2026-09-25T15:00:00Z", exit_price: 156.5,
  exit_reason: "TARGET_2R", realized_r: 2, gross_r: 2.02, realized_pnl_usd: 400,
  bars_held: 12, same_bar_ambiguous: false, excluded_from_stats: false,
  exclusion_reason: null, ...over,
});

const perf = (over: Partial<PerfLike> = {}): PerfLike => ({
  trades: 0, wins: 0, losses: 0, winRate: null, netR: 0, pnlUsd: 0,
  expectancyR: null, avgWinR: null, avgLossR: null, grossWinR: 0, grossLossR: 0,
  profitFactor: null, pfNote: "NO_TRADES", maxDrawdownR: 0,
  longestWinStreak: 0, longestLossStreak: 0, ...over,
});

const report = (over: Partial<CausalReportView> = {}): CausalReportView => ({
  boundary: { forwardCausalStart: START, causalExecutionVersion: V,
              deployedStrategyCommit: "a67b5099" },
  headline: perf(),
  open: { total: 0, ambiguous: 0, legacy: 0 },
  byInstrument: { "EUR/USD": perf(), "USD/JPY": perf(), "BTC/USD": perf() },
  byDirection: { long: perf(), short: perf() },
  byDailyStructure: { ALIGNED: perf(), OPPOSED: perf(), RANGING: perf(), UNKNOWN: perf() },
  quality: {
    resolutionMethods: {}, events: {},
    validatedIncluded: 0, excludedUnresolved: 0,
    excludedSequenceContaminated: 0, excludedOther: 0, causalRowsTotal: 0,
  },
  candidates: { intentsCreated: 0, filled: 0, refused: 0, closed: 0, fillConversion: null },
  milestones: { current: 0, targets: [25, 50, 100, 200], next: 25 },
  smallSample: null,
  ...over,
});

const state = (over: Partial<PaperState> = {}): PaperState => ({
  health: {
    lastRunAt: "2026-09-26T11:45:00Z", lastSuccessAt: "2026-09-26T11:45:00Z",
    lastStatus: "OK", durationMs: 820, instrumentsChecked: 3, barsProcessed: 4,
    eventsEmitted: 1, bootstrapRequired: [], divergent: [], errorCode: null,
    errorMessage: null, consecutiveFailures: 0, strategyVersion: "spec-1.1",
  },
  healthStale: false, cadenceMs: 900_000,
  runtime: [],
  openPositions: [], recentTrades: [], recentEvents: [],
  summary: { trades: 0, wins: 0, winRate: 0, totalR: 0, expectancyR: 0, totalPnlUsd: 0, abortedExcluded: 0 },
  causal: report(),
  legacy: { trades: 0, netR: 0, pnlUsd: 0, winRate: null, notCausallyOrdered: true },
  causalTrades: [],
  ...over,
});

const draw = (s: PaperState) => render(<IpoPaperDashboard state={s} now={NOW} />);

// ─────────────────────────────────────────────────────────────────────────────
// the default lens
// ─────────────────────────────────────────────────────────────────────────────

describe("the dashboard defaults to the causal forward population", () => {
  it("leads with the causal title, the version and the boundary", () => {
    draw(state());
    expect(screen.getByText(/IPO CAUSAL FORWARD TEST/i)).toBeInTheDocument();
    expect(screen.getByText(/1m-ordering-v1/)).toBeInTheDocument();
    // Quoted in UTC, always — a local-time boundary is unauditable. It appears
    // both on the lens line and in the empty-state sentence.
    expect(screen.getAllByText(/Sep 24, 2026 17:36 UTC/).length).toBeGreaterThan(0);
  });

  it("does not show the legacy total in the headline when only legacy trades exist", () => {
    // The exact situation at deploy: 11 pre-fix trades, +12.91R, and nothing causal.
    const s = state({
      recentTrades: [trade({ realized_r: 12.91, causal_execution_version: null } as Partial<PaperTradeRow>)],
      legacy: { trades: 11, netR: 12.91, pnlUsd: 2582, winRate: 0.82, notCausallyOrdered: true },
    });
    draw(s);
    // The causal strip reports nothing, and says so in words — in the metric
    // strip and again where the history table would have been.
    expect(screen.getAllByText(/No causal forward trades have closed yet/i).length).toBeGreaterThan(0);
    // The legacy figure is NOT the headline.
    const header = screen.getByText(/IPO CAUSAL FORWARD TEST/i).closest("div")!;
    expect(within(header).queryByText(/12\.91/)).toBeNull();
  });

  it("shows — rather than a misleading zero for rates with no sample", () => {
    draw(state());
    // win rate and expectancy have no value to report yet.
    expect(fmtPct(null)).toBe("—");
    const strip = screen.getByText(/win rate/i).closest("div")!.parentElement!;
    expect(within(strip).getAllByText("—").length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the lens toggle
// ─────────────────────────────────────────────────────────────────────────────

describe("legacy evidence stays reachable and stays labelled", () => {
  const withBoth = () => state({
    recentTrades: [
      trade({ realized_r: 1.5, causal_execution_version: V, intent_id: "int_causal" } as Partial<PaperTradeRow>),
      trade({ realized_r: 9.9, causal_execution_version: null, intent_id: "int_legacy" } as Partial<PaperTradeRow>),
    ],
    causalTrades: [trade({ realized_r: 1.5, causal_execution_version: V, intent_id: "int_causal" } as Partial<PaperTradeRow>)],
    causal: report({ headline: perf({ trades: 1, wins: 1, winRate: 1, netR: 1.5, pnlUsd: 300,
      expectancyR: 1.5, avgWinR: 1.5, grossWinR: 1.5, pfNote: "NO_LOSSES" }) }),
    legacy: { trades: 1, netR: 9.9, pnlUsd: 1980, winRate: 1, notCausallyOrdered: true },
  });

  it("offers all three lenses with causal pressed", () => {
    draw(withBoth());
    expect(screen.getByRole("button", { name: /^causal$/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /legacy pre-fix/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /all history/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("warns explicitly on the legacy lens", () => {
    draw(withBoth());
    fireEvent.click(screen.getByRole("button", { name: /legacy pre-fix/i }));
    expect(screen.getByText(/PRE-FIX \/ NOT CAUSALLY ORDERED/i)).toBeInTheDocument();
    expect(screen.getByText(/LEGACY PRE-FIX — NOT CAUSALLY ORDERED/i)).toBeInTheDocument();
  });

  it("warns that the pooled view is not valid for performance evaluation", () => {
    draw(withBoth());
    fireEvent.click(screen.getByRole("button", { name: /all history/i }));
    expect(screen.getAllByText(/NOT VALID FOR PERFORMANCE EVALUATION/i).length).toBeGreaterThan(0);
  });

  it("never renders a combined causal+legacy performance number as the default", () => {
    draw(withBoth());
    // 1.5 is the causal total. 11.4 would be the pooled one; it must not appear.
    expect(screen.queryByText(/\+11\.40R/)).toBeNull();
    expect(screen.getAllByText(/\+1\.50R/).length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// profit factor, small samples, milestones
// ─────────────────────────────────────────────────────────────────────────────

describe("statistics that are easy to state dishonestly", () => {
  it("shows ∞ for a population with wins and no losses, never a number", () => {
    expect(fmtPF({ profitFactor: null, pfNote: "NO_LOSSES" })).toBe("∞");
    expect(fmtPF({ profitFactor: null, pfNote: "NO_TRADES" })).toBe("—");
    expect(fmtPF({ profitFactor: 1.42, pfNote: null })).toBe("1.42");
    draw(state({ causal: report({
      headline: perf({ trades: 2, wins: 2, winRate: 1, netR: 3.5, grossWinR: 3.5, pfNote: "NO_LOSSES" }),
    }) }));
    expect(screen.getByText("∞")).toBeInTheDocument();
  });

  it("calls out a small sample and implies no confidence", () => {
    draw(state({ causal: report({
      headline: perf({ trades: 4, wins: 3, losses: 1, winRate: 0.75, netR: 2.1, expectancyR: 0.525 }),
      smallSample: { below: 25, n: 4 },
    }) }));
    expect(screen.getByText(/SMALL SAMPLE — N=4/)).toBeInTheDocument();
    expect(screen.getByText(/not\s+estimates of future performance/i)).toBeInTheDocument();
  });

  it("shows milestones as landmarks, not as validation", () => {
    draw(state({ causal: report({ milestones: { current: 3, targets: [25, 50, 100, 200], next: 25 } }) }));
    expect(screen.getByText("3 / 25")).toBeInTheDocument();
    expect(screen.getByText(/monitoring landmark, not a threshold/i)).toBeInTheDocument();
    // "validated in stats" is a row count in the quality card and is fine. What
    // must never appear is a claim that the STRATEGY is validated at a count.
    expect(screen.queryByText(/strategy is validated|validated at \d/i)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ambiguous positions and data quality
// ─────────────────────────────────────────────────────────────────────────────

describe("an ordering-ambiguous position is visible and honest", () => {
  const ambiguous = state({
    openPositions: [position({
      status: "ordering_ambiguous",
      ambiguity_kind: "ENTRY_VS_TARGET_SAME_MINUTE",
      causal_execution_version: V, entry_resolution_method: "ORDERING_UNRESOLVED",
      htf_source: "twelvedata", minute_source: "twelvedata",
      daily_structure: "BEARISH", daily_structure_alignment: "OPPOSED",
    } as Partial<PaperPositionRow>)],
    causal: report({ open: { total: 1, ambiguous: 1, legacy: 0 } }),
  });

  it("appears under open positions, labelled", () => {
    draw(ambiguous);
    expect(screen.getByText(/Open paper positions \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText("ORDERING AMBIGUOUS")).toBeInTheDocument();
  });

  it("explains that the slot is still occupied", () => {
    draw(ambiguous);
    expect(screen.getByText(/At least one causal path remains open/i)).toBeInTheDocument();
    expect(screen.getByText(/Position slot remains occupied/i)).toBeInTheDocument();
  });

  it("shows no guessed unrealized R", () => {
    draw(ambiguous);
    // Both places that mention unrealized R say it is NOT shown; neither offers
    // a figure. The panel has no current price to compute one from.
    const mentions = screen.getAllByText(/unrealized/i);
    expect(mentions.length).toBeGreaterThan(0);
    for (const el of mentions) {
      expect(el.textContent ?? "").toMatch(/not shown|No unrealized R is shown/i);
    }
    expect(screen.getByText(/No unrealized R is shown/i)).toBeInTheDocument();
  });

  it("surfaces the causal provenance of the position", () => {
    draw(ambiguous);
    expect(screen.getAllByText("twelvedata").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("ENTRY_VS_TARGET_SAME_MINUTE")).toBeInTheDocument();
  });
});

describe("the causal data-quality section accounts for everything", () => {
  it("shows every ordering verdict and every exclusion bucket", () => {
    draw(state({ causal: report({
      headline: perf({ trades: 2, wins: 1, losses: 1, winRate: 0.5, netR: 0.6,
        expectancyR: 0.3, grossWinR: 1.8, grossLossR: 1.2, profitFactor: 1.5, pfNote: null }),
      quality: {
        resolutionMethods: { HTF_UNAMBIGUOUS: 1, ONE_MINUTE_RESOLVED: 1 },
        events: { ORDERING_AMBIGUOUS: 2, AMBIGUITY_RESOLVED: 1, SEQUENCE_FORKED: 1, CAUSAL_OVERRIDE: 3 },
        validatedIncluded: 2, excludedUnresolved: 1,
        excludedSequenceContaminated: 1, excludedOther: 0, causalRowsTotal: 4,
      },
    }) }));
    for (const k of ["HTF_UNAMBIGUOUS", "ONE_MINUTE_RESOLVED", "TICK_RESOLVED", "ORDERING_UNRESOLVED",
                     "ORDERING_AMBIGUOUS", "AMBIGUITY_RESOLVED", "SEQUENCE_FORKED"]) {
      expect(screen.getByText(k)).toBeInTheDocument();
    }
    expect(screen.getByText(/validated in stats/i)).toBeInTheDocument();
    expect(screen.getByText(/excluded — seq\. contaminated/i)).toBeInTheDocument();
    // The arithmetic is shown, so a reader can check it rather than trust it.
    expect(screen.getByText(/2 included \+ 1 \+ 1 \+ 0 = 4 causal-era trades/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// breakdowns
// ─────────────────────────────────────────────────────────────────────────────

describe("the breakdowns are observational", () => {
  const withSplits = () => state({ causal: report({
    headline: perf({ trades: 3, wins: 2, losses: 1, winRate: 2 / 3, netR: 2.4,
      expectancyR: 0.8, grossWinR: 3.6, grossLossR: 1.2, profitFactor: 3, pfNote: null }),
    byInstrument: {
      "EUR/USD": perf({ trades: 2, wins: 2, winRate: 1, netR: 3.6, expectancyR: 1.8,
        grossWinR: 3.6, pfNote: "NO_LOSSES" }),
      "USD/JPY": perf({ trades: 1, losses: 1, winRate: 0, netR: -1.2, expectancyR: -1.2,
        grossLossR: 1.2, profitFactor: 0, pfNote: null }),
      "BTC/USD": perf(),
    },
    byDirection: {
      long: perf({ trades: 2, wins: 2, winRate: 1, netR: 3.6, expectancyR: 1.8, grossWinR: 3.6, pfNote: "NO_LOSSES" }),
      short: perf({ trades: 1, losses: 1, winRate: 0, netR: -1.2, expectancyR: -1.2, grossLossR: 1.2, profitFactor: 0, pfNote: null }),
    },
    byDailyStructure: {
      ALIGNED: perf({ trades: 2, wins: 2, winRate: 1, netR: 3.6, expectancyR: 1.8, grossWinR: 3.6, pfNote: "NO_LOSSES" }),
      OPPOSED: perf({ trades: 1, losses: 1, winRate: 0, netR: -1.2, expectancyR: -1.2, grossLossR: 1.2, profitFactor: 0, pfNote: null }),
      RANGING: perf(), UNKNOWN: perf(),
    },
  }) });

  it("lists all three instruments, including one with no trades", () => {
    draw(withSplits());
    for (const sym of ["EUR/USD", "USD/JPY", "BTC/USD"]) {
      expect(screen.getAllByText(sym).length).toBeGreaterThan(0);
    }
  });

  it("splits long and short without offering a directional filter", () => {
    draw(withSplits());
    expect(screen.getByText("LONG")).toBeInTheDocument();
    expect(screen.getByText("SHORT")).toBeInTheDocument();
    expect(screen.getByText(/Reported, not filtered on/i)).toBeInTheDocument();
  });

  it("states that the Daily buckets are observational and unranked", () => {
    draw(withSplits());
    for (const b of ["ALIGNED", "OPPOSED", "RANGING", "UNKNOWN"]) {
      expect(screen.getAllByText(b).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/OBSERVATIONAL ONLY/i)).toBeInTheDocument();
    expect(screen.getByText(/failed unseen validation/i)).toBeInTheDocument();
    expect(screen.getByText(/no bucket is preferred/i)).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// the audit list
// ─────────────────────────────────────────────────────────────────────────────

describe("trade history is auditable", () => {
  it("carries the columns needed to check a row without the schema", () => {
    draw(state({
      causalTrades: [trade({
        causal_execution_version: V, exit_resolution_method: "ONE_MINUTE_RESOLVED",
        daily_structure_alignment: "ALIGNED",
      } as Partial<PaperTradeRow>)],
      recentTrades: [trade({ causal_execution_version: V } as Partial<PaperTradeRow>)],
      causal: report({ headline: perf({ trades: 1, wins: 1, winRate: 1, netR: 2,
        expectancyR: 2, grossWinR: 2, pfNote: "NO_LOSSES" }) }),
    }));
    for (const h of ["resolution", "daily", "causal", "excluded"]) {
      expect(screen.getAllByText(h, { exact: false }).length).toBeGreaterThan(0);
    }
    // Appears in the quality card and again on the row itself.
    expect(screen.getAllByText("ONE_MINUTE_RESOLVED").length).toBeGreaterThan(0);
    expect(screen.getByText("in stats")).toBeInTheDocument();
  });

  it("labels a sequence-contaminated row and keeps it out of the headline", () => {
    draw(state({
      causalTrades: [trade({
        causal_execution_version: V, sequence_contaminated: true, realized_r: 5,
      } as Partial<PaperTradeRow>)],
      // The headline reports nothing: the row is excluded at source.
      causal: report({ quality: {
        resolutionMethods: {}, events: {}, validatedIncluded: 0, excludedUnresolved: 0,
        excludedSequenceContaminated: 1, excludedOther: 0, causalRowsTotal: 1,
      } }),
    }));
    expect(screen.getByText("SEQUENCE CONTAMINATED")).toBeInTheDocument();
    expect(screen.getByText(/No causal forward trades have closed yet/i)).toBeInTheDocument();
  });
});
