/**
 * Zone Setups panel — Route 2 confirmation visibility.
 *
 * Mounted, not grepped: the claims are about what a person sees. The panel
 * used to reduce every fill to the word "confirmed" and told the user every
 * hunt was waiting for a CHoCH, when a Tier 3 fill has no CHoCH at all.
 *
 * The NZD/CAD case is the real forward trade 9394117f (2026-09-30), with its
 * stored values, so a regression fails on the order that exposed the gap.
 */
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PendingOrder } from "@/lib/api";

const api = vi.hoisted(() => ({
  active: [] as unknown[],
  all: [] as unknown[],
}));
vi.mock("@/lib/api", () => ({
  scannerApi: {
    activePending: vi.fn(async () => api.active),
    allPending: vi.fn(async () => api.all),
    cancelPending: vi.fn(async () => ({})),
  },
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import PendingOrdersPanel from "../PendingOrdersPanel";

const base = (over: Partial<PendingOrder> = {}): PendingOrder => ({
  order_id: "abc12345", user_id: "u", bot_id: "smc", symbol: "EUR/USD", direction: "long",
  order_type: "limit_ob", entry_price: 1.1, current_price: 1.1005, stop_loss: 1.098,
  take_profit: 1.104, size: 1, entry_zone_type: "IZ-OB", entry_zone_low: 1.099,
  entry_zone_high: 1.1012, status: "pending", expiry_minutes: 480,
  expires_at: "2026-09-30T18:00:00Z", fill_reason: null, cancel_reason: null,
  filled_at: null, resolved_at: null, signal_reason: null, signal_score: 44,
  setup_type: null, setup_confidence: null, from_watchlist: false, staged_cycles: 0,
  staged_initial_score: null, exit_flags: null, placed_at: "2026-09-30T10:00:00Z",
  created_at: "2026-09-30T10:00:00Z", updated_at: "2026-09-30T10:00:00Z",
  ...over,
});

/** The real forward trade, as stored. */
const NZDCAD = base({
  order_id: "9394117f", symbol: "NZD/CAD", direction: "short", status: "filled",
  entry_price: 0.80165, stop_loss: 0.80316, take_profit: 0.799989, size: 2.5,
  placed_at: "2026-09-30T03:56:05.437Z", expires_at: "2026-09-30T11:56:05.437Z",
  resolved_at: "2026-09-30T06:33:22.515Z", filled_at: "2026-09-30T06:33:22.515Z",
  strategy_version: "smc-route2-confirmation-lifecycle-v2", config_hash: "5135bb1e873a8695",
  would_have_been_route1: true, confirmation_arm_count: 4, confirmation_checks_count: 25,
  confirmation_type: "bearish_reversal_pattern", confirmation_tier: 3, confirmation_timeframe: "5m",
  confirmation_accepted_at: "2026-09-30T06:33:22.515Z", fill_timestamp: "2026-09-30T06:33:22.515Z",
  fill_price: 0.80181, zone_touch_time: "2026-09-30T06:31:01.426Z", terminal_reason: "FILLED",
  pending_distance_atr: 0.2001,
  entry_confirmation: {
    contract: "route2-confirmation.v1", type: "bearish_reversal_pattern", tier: 3,
    timeframe: "5m", price: 0.80181, displacement: 0.9111111111110344, significance: null,
    closeBased: false, supportingSignals: ["displacement", "Displacement (bearish) body 91%"],
  },
});

const mount = async (history: PendingOrder[], active: PendingOrder[] = []) => {
  api.active = active;
  api.all = [...active, ...history];
  render(<PendingOrdersPanel />);
  if (history.length) {
    fireEvent.click(await screen.findByText(/Show setup history/));
  }
};

const rowFor = (symbol: string) =>
  screen.getAllByRole("button", { expanded: false }).find(b => within(b).queryByText(symbol)) as HTMLElement;

const openRow = async (symbol: string) => {
  const row = await waitFor(() => {
    const r = rowFor(symbol);
    if (!r) throw new Error(`no collapsed row for ${symbol}`);
    return r;
  });
  fireEvent.click(row);
  return screen.getByTestId("history-detail");
};

beforeEach(() => { api.active = []; api.all = []; });

// ─── the real trade ─────────────────────────────────────────────────────────

describe("the NZD/CAD forward trade renders what actually happened", () => {
  it("collapsed row: CONFIRMED, T3 REVERSAL, the FILL price", async () => {
    await mount([NZDCAD]);
    const row = await waitFor(() => rowFor("NZD/CAD"));
    expect(within(row).getByText("CONFIRMED")).toBeInTheDocument();
    expect(within(row).getByText("T3 Reversal")).toBeInTheDocument();
    // The fill, not the limit — the two differ by 1.6 pips on this trade.
    expect(within(row).getByText(/Entry 0\.80181/)).toBeInTheDocument();
  });

  it("expanded: confirmation, execution and lifecycle from stored data", async () => {
    await mount([NZDCAD]);
    const d = await openRow("NZD/CAD");
    const t = within(d);
    expect(t.getByText("T3")).toBeInTheDocument();
    expect(t.getByText("Bearish Reversal Pattern")).toBeInTheDocument();
    expect(t.getByText("5m")).toBeInTheDocument();
    expect(t.getByText("91%")).toBeInTheDocument();
    expect(t.getByText("No")).toBeInTheDocument();                           // close based
    expect(t.getByText("displacement, Displacement (bearish) body 91%")).toBeInTheDocument();
    expect(t.getByText("0.80165")).toBeInTheDocument();                      // pending entry
    expect(t.getAllByText("0.80181").length).toBeGreaterThan(0);             // fill + confirmation price
    expect(t.getByText("+1.6 pips (favourable)")).toBeInTheDocument();
    expect(t.getByText("0.80316")).toBeInTheDocument();
    expect(t.getByText("0.79999")).toBeInTheDocument();
    expect(t.getByText("2.5 lots")).toBeInTheDocument();
    expect(t.getByText("Route 2 Pending")).toBeInTheDocument();
    expect(t.getByText("V2")).toBeInTheDocument();
    expect(t.getByText("Ex-Route-1 / Observational")).toBeInTheDocument();
    expect(t.getByText("4")).toBeInTheDocument();
    expect(t.getByText("25")).toBeInTheDocument();
  });

  it("null significance is omitted, not shown as a value", async () => {
    await mount([NZDCAD]);
    const d = await openRow("NZD/CAD");
    expect(within(d).queryByText("Significance")).not.toBeInTheDocument();
  });
});

// ─── tiers ──────────────────────────────────────────────────────────────────

const filledWith = (tier: number, type: string, symbol: string) => base({
  order_id: `t${tier}`, symbol, status: "filled", resolved_at: "2026-09-30T11:00:00Z",
  fill_price: 1.1003, confirmation_tier: tier, confirmation_type: type,
  entry_confirmation: { type, tier, timeframe: "5m", price: 1.1003, displacement: 0.5,
    significance: null, closeBased: tier === 1, supportingSignals: ["engulfing", "rejection wick"] },
});

describe("each tier is labelled as itself", () => {
  it("Tier 1 renders T1 CHoCH", async () => {
    await mount([filledWith(1, "bullish_choch", "EUR/USD")]);
    expect(within(await waitFor(() => rowFor("EUR/USD"))).getByText("T1 CHoCH")).toBeInTheDocument();
    const d = await openRow("EUR/USD");
    expect(within(d).getByText("Bullish CHoCH")).toBeInTheDocument();
    expect(within(d).getByText("Yes")).toBeInTheDocument();
  });

  it("Tier 2 renders T2 CHoCH+", async () => {
    await mount([filledWith(2, "bullish_choch_relaxed", "GBP/USD")]);
    expect(within(await waitFor(() => rowFor("GBP/USD"))).getByText("T2 CHoCH+")).toBeInTheDocument();
    const d = await openRow("GBP/USD");
    expect(within(d).getByText("Bullish CHoCH (wick)")).toBeInTheDocument();
  });

  it("Tier 3 renders T3 Reversal — and nowhere says CHoCH", async () => {
    await mount([filledWith(3, "bullish_reversal_pattern", "USD/JPY")]);
    const row = await waitFor(() => rowFor("USD/JPY"));
    expect(within(row).getByText("T3 Reversal")).toBeInTheDocument();
    const d = await openRow("USD/JPY");
    expect(within(d).getByText("Bullish Reversal Pattern")).toBeInTheDocument();
    // The old panel implied every entry was a CHoCH.
    expect(d.textContent).not.toMatch(/CHoCH/);
  });

  it("supporting signals render in full", async () => {
    await mount([filledWith(1, "bullish_choch", "EUR/USD")]);
    const d = await openRow("EUR/USD");
    expect(within(d).getByText("engulfing, rejection wick")).toBeInTheDocument();
  });
});

// ─── legacy ─────────────────────────────────────────────────────────────────

describe("legacy rows render without inventing anything", () => {
  it("a filled order with no telemetry shows CONFIRMED and no tier, and does not crash", async () => {
    const legacy = base({ order_id: "leg00001", symbol: "AUD/USD", status: "filled",
      resolved_at: "2026-09-22T19:53:00Z", entry_price: 0.71205 });
    await mount([legacy]);
    const row = await waitFor(() => rowFor("AUD/USD"));
    expect(within(row).getByText("CONFIRMED")).toBeInTheDocument();
    expect(within(row).queryByText(/T[123] /)).not.toBeInTheDocument();
    const d = await openRow("AUD/USD");
    expect(within(d).getByText("Not recorded for this order.")).toBeInTheDocument();
    // "Lifecycle" is also a section heading, so assert on the fact labels and
    // values that would only appear if something were invented.
    for (const label of ["Tier", "Displacement", "Entry difference", "Strategy version",
      "Cohort", "Confirmation arms", "Confirmation checks", "Distance"]) {
      expect(within(d).queryByText(label)).not.toBeInTheDocument();
    }
    expect(within(d).queryByText("V2")).not.toBeInTheDocument();
    expect(within(d).queryByText("V1")).not.toBeInTheDocument();
  });

  it("scalar columns alone give tier and type, but no invented price or displacement", async () => {
    const partial = base({ order_id: "par00001", symbol: "EUR/USD", status: "filled",
      resolved_at: "2026-09-30T11:00:00Z", confirmation_tier: 3,
      confirmation_type: "bearish_reversal_pattern", confirmation_timeframe: "5m", direction: "short" });
    await mount([partial]);
    const d = await openRow("EUR/USD");
    expect(within(d).getByText("Bearish Reversal Pattern")).toBeInTheDocument();
    expect(within(d).queryByText("Displacement")).not.toBeInTheDocument();
    expect(within(d).queryByText("Confirmation price")).not.toBeInTheDocument();
  });
});

// ─── cancelled / expired ────────────────────────────────────────────────────

describe("unfilled orders say why", () => {
  it("cancelled order shows the typed terminal reason and its reset detail", async () => {
    const c = base({ order_id: "can00001", symbol: "NZD/CHF", status: "cancelled",
      resolved_at: "2026-09-30T12:00:00Z", terminal_reason: "CANCELLED_IMPULSE_BROKEN",
      reset_reason: "impulse_broken", hard_invalidation: true, confirmation_arm_count: 2,
      cancel_reason: "Impulse broken — price 0.5 exceeded origin" });
    await mount([c]);
    expect(within(await waitFor(() => rowFor("NZD/CHF"))).getByText("CANCELLED — IMPULSE BROKEN")).toBeInTheDocument();
    const d = await openRow("NZD/CHF");
    expect(within(d).getByText("impulse_broken")).toBeInTheDocument();
    expect(within(d).getByText("Yes")).toBeInTheDocument();
    expect(within(d).getByText("Impulse broken — price 0.5 exceeded origin")).toBeInTheDocument();
  });

  it("refined-zone failure and direction flip are named", async () => {
    await mount([
      base({ order_id: "rz000001", symbol: "ETH/USD", status: "cancelled", resolved_at: "2026-09-30T12:00:00Z",
        terminal_reason: "CANCELLED_REFINED_ZONE_FAILURE" }),
      base({ order_id: "df000001", symbol: "BTC/USD", status: "cancelled", resolved_at: "2026-09-30T12:01:00Z",
        terminal_reason: "CANCELLED_DIRECTION_FLIP" }),
    ]);
    expect(await screen.findByText("CANCELLED — REFINED ZONE FAILURE")).toBeInTheDocument();
    expect(screen.getByText("CANCELLED — DIRECTION FLIP")).toBeInTheDocument();
  });

  it("expired order shows the TTL it actually had", async () => {
    await mount([base({ order_id: "exp00001", symbol: "CHF/JPY", status: "expired",
      placed_at: "2026-09-30T02:00:00Z", expires_at: "2026-09-30T10:00:00Z",
      resolved_at: "2026-09-30T10:00:30Z", terminal_reason: "EXPIRED_NEVER_TOUCHED" })]);
    expect(await screen.findByText("EXPIRED — 8H TTL")).toBeInTheDocument();
    expect(screen.getByText("never touched")).toBeInTheDocument();
  });

  it("a legacy cancel without a typed reason is not forced into a category", async () => {
    await mount([base({ order_id: "lc000001", symbol: "EUR/GBP", status: "cancelled",
      resolved_at: "2026-09-16T08:20:00Z", cancel_reason: "Superseded by new setup" })]);
    const row = await waitFor(() => rowFor("EUR/GBP"));
    expect(within(row).getByText("CANCELLED")).toBeInTheDocument();
    const d = await openRow("EUR/GBP");
    expect(within(d).getByText("Superseded by new setup")).toBeInTheDocument();
  });
});

// ─── active hunt ────────────────────────────────────────────────────────────

describe("an active hunt says what it is actually waiting for", () => {
  const hunting = base({ order_id: "hun00001", symbol: "NZD/CAD", direction: "short",
    status: "awaiting_confirmation", zone_touch_time: "2026-09-30T06:31:01Z",
    confirmation_arm_count: 4, confirmation_checks_count: 25,
    confirmation_min_observation_until: "2026-09-30T06:40:00Z",
    pending_distance_atr: 0.2, strategy_version: "smc-route2-confirmation-lifecycle-v2",
    would_have_been_route1: true });

  it("shows all three tiers, with direction, and no longer claims CHoCH only", async () => {
    await mount([], [hunting]);
    expect(await screen.findByText(/Waiting for bearish 5m confirmation/)).toBeInTheDocument();
    expect(screen.getByText("T1 CHoCH · T2 CHoCH+ · T3 Reversal")).toBeInTheDocument();
    expect(screen.queryByText(/waiting for bearish CHoCH on 5m/i)).not.toBeInTheDocument();
  });

  it("shows arms, checks, protected window, distance and lifecycle", async () => {
    await mount([], [hunting]);
    const facts = await screen.findByTestId("hunt-facts");
    expect(facts.textContent).toMatch(/Arms 4/);
    expect(facts.textContent).toMatch(/Checks 25/);
    expect(facts.textContent).toMatch(/Protected until/);
    expect(facts.textContent).toMatch(/0\.20 ATR/);
    expect(facts.textContent).toMatch(/Lifecycle V2/);
  });

  it("no longer claims the hunt has no time limit", async () => {
    await mount([], [hunting]);
    await screen.findByTestId("hunt-facts");
    expect(screen.queryByText(/no time limit/i)).not.toBeInTheDocument();
  });

  it("a legacy hunting order with none of the fields renders no facts line", async () => {
    await mount([], [base({ order_id: "hun00002", status: "awaiting_confirmation" })]);
    await screen.findByText(/Waiting for bullish 5m confirmation/);
    expect(screen.queryByTestId("hunt-facts")).not.toBeInTheDocument();
  });
});
