import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import OperationsDashboard from "../OperationsDashboard";

const api = vi.hoisted(() => ({
  status: vi.fn(),
  logs: vi.fn(),
  pendingSnapshot: vi.fn(),
  activeStaged: vi.fn(),
  lifecycleEvents: vi.fn(),
  impulseLifecycleTransitions: vi.fn(),
  connections: vi.fn(),
  connectionStatus: vi.fn(),
  accountSummary: vi.fn(),
  openTrades: vi.fn(),
  closeTrade: vi.fn(),
  manualScan: vi.fn(),
  startEngine: vi.fn(),
  pauseEngine: vi.fn(),
  killSwitch: vi.fn(),
  closePosition: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { email: "operator@example.com" } }),
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Area: () => null,
  Line: () => null,
  YAxis: () => null,
}));

vi.mock("@/lib/api", () => ({
  paperApi: {
    status: api.status,
    manualScan: api.manualScan,
    startEngine: api.startEngine,
    pauseEngine: api.pauseEngine,
    killSwitch: api.killSwitch,
    closePosition: api.closePosition,
  },
  scannerApi: {
    logs: api.logs,
    pendingSnapshot: api.pendingSnapshot,
    activeStaged: api.activeStaged,
    lifecycleEvents: api.lifecycleEvents,
    impulseLifecycleTransitions: api.impulseLifecycleTransitions,
    manualScan: api.manualScan,
  },
  brokerApi: { list: api.connections },
  brokerExecApi: {
    connectionStatus: api.connectionStatus,
    accountSummary: api.accountSummary,
    openTrades: api.openTrades,
    closeTrade: api.closeTrade,
  },
}));

function renderDashboard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <MemoryRouter initialEntries={["/bot"]}>
          <OperationsDashboard />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("OperationsDashboard", () => {
  beforeEach(() => {
    api.status.mockResolvedValue({
      isRunning: true,
      isPaused: false,
      executionMode: "paper",
      killSwitchActive: false,
      positions: [],
    });
    api.logs.mockResolvedValue([{
      scanned_at: "2026-08-23T14:31:12Z",
      pairs_scanned: 1,
      signals_found: 1,
      trades_placed: 0,
      details_json: [
        {
          __meta: true,
          activeStyle: "scalper",
          creditBudget: { refused: 0, unenforced: 0 },
          impulseRotation: {
            sessionObservation: {
              contract: "session-aware-rotation-observation.v1",
              mode: "observe",
              status: "ready",
              affectsExecution: false,
              additionalMarketDataCalls: 0,
              style: "scalper",
              session: { name: "New York", filterKey: "newyork", isKillZone: true },
              actual: ["AUD/JPY", "USD/CAD"],
              proposed: ["AUD/JPY", "XAU/USD"],
              overlapCount: 1,
              overlapPercent: 50,
              wouldPromote: ["XAU/USD"],
              wouldDefer: ["USD/CAD"],
            },
          },
        },
        {
          pair: "AUD/JPY",
          direction: "long",
          score: 33.7,
          status: "zone_setup_active",
          reason: "Price at zone",
          currentPrice: 112.991,
          unifiedZone: {
            hasZone: true,
            state: "watching",
            selectedTF: "5m",
            unifiedScore: 5.5,
            scoreBreakdown: { baseScore: 4.5, liquidityBonus: 0, confirmationBonus: 0, tfBonus: 1, total: 5.5 },
            impulse: {
              direction: "bullish",
              high: 112.95,
              low: 112.32,
              pips: 63,
              timeframe: "5m",
              startDate: "2026-08-23T13:00:00Z",
              endDate: "2026-08-23T14:00:00Z",
              spanBars: 12,
              bosPrice: 112.90,
            },
            zone: { type: "OB", high: 112.58252, low: 112.32812, fibLevel: 0.618, fibLabel: "61.8%", srConfirmed: false, htfLayers: [], ltfRefined: true, totalScore: 4.5, zonesFound: 1 },
            price: { currentPrice: 112.991, atZone: true, atZoneStrict: true, insideZone: true, distancePips: 0, sideOk: true },
            liquidity: null,
            confirmation: null,
            entry: null,
            storySummary: "Bullish impulse into order block watch.",
            reason: "Waiting for confirmation",
          },
        },
      ],
    }]);
    api.pendingSnapshot.mockResolvedValue({
      fetchedAt: "2026-08-23T14:31:20Z",
      history: [],
      active: [{
        order_id: "order-1",
        symbol: "AUD/JPY",
        direction: "long",
        order_type: "limit_ob",
        entry_price: 112.58252,
        current_price: 112.991,
        stop_loss: 112.2713,
        take_profit: 112.7713,
        size: null,
        entry_zone_type: "ob",
        entry_zone_low: 112.32812,
        entry_zone_high: 112.58252,
        status: "awaiting_confirmation",
        expiry_minutes: 2160,
        expires_at: "2026-08-24T16:00:00Z",
        fill_reason: null,
        cancel_reason: null,
        filled_at: null,
        resolved_at: null,
        signal_reason: {},
        signal_score: 33.7,
        setup_type: "ob",
        setup_confidence: null,
        from_watchlist: true,
        candidate_id: "ea2b21ab-02f9-4015-9560-f63d98617983",
        confirmation_method: "indicators",
        confirmation_config: { afterChochMode: "wait_retracement" },
        staged_cycles: 2,
        staged_initial_score: 33.7,
        exit_flags: {},
        final_authorization: null,
        decision_context: null,
        placed_at: "2026-08-23T14:00:00Z",
        created_at: "2026-08-23T14:00:00Z",
        updated_at: "2026-08-23T14:31:00Z",
      }],
    });
    api.activeStaged.mockResolvedValue([]);
    api.lifecycleEvents.mockResolvedValue([]);
    api.impulseLifecycleTransitions.mockResolvedValue([]);
    api.connections.mockResolvedValue([{ id: "broker-1", display_name: "FTMO Demo", is_active: true, is_live: false }]);
    api.connectionStatus.mockResolvedValue({ ok: true, ready: true, connectionStatus: "CONNECTED" });
    api.accountSummary.mockResolvedValue({ balance: 10000, equity: 10000 });
    api.openTrades.mockResolvedValue([]);
    api.closeTrade.mockResolvedValue({ success: true });
    api.manualScan.mockResolvedValue({ started: true });
    api.pauseEngine.mockResolvedValue({ success: true });
    api.startEngine.mockResolvedValue({ success: true });
    api.killSwitch.mockResolvedValue({ success: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders live scan and lifecycle data and wires the safety control", async () => {
    renderDashboard();
    expect(screen.getByText("SMC Trading Dashboard")).toBeInTheDocument();

    expect(await screen.findByRole("heading", { name: "Latest Scan" })).toBeInTheDocument();
    const sessionPriority = await screen.findByRole("status", {
      name: "Session-aware scan priority observation",
    });
    expect(within(sessionPriority).getByText("Session priority")).toBeInTheDocument();
    expect(within(sessionPriority).getByText("Observe only")).toBeInTheDocument();
    expect(within(sessionPriority).getByText("1/2 same slots")).toBeInTheDocument();
    expect(within(sessionPriority).getByText(/New York · scalper · no extra API calls/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Zone Setups" })).toBeInTheDocument();
    expect((await screen.findAllByText("AUD/JPY")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("33.7%").length).toBeGreaterThan(0);

    const detailTab = screen.getByRole("tab", { name: "Detail Breakdown" });
    const lifecycleTab = screen.getByRole("tab", { name: "Lifecycle" });
    expect(detailTab).toHaveAttribute("aria-selected", "true");
    expect(detailTab).toHaveAttribute("tabindex", "0");
    expect(lifecycleTab).toHaveAttribute("tabindex", "-1");
    expect(await screen.findByText("ICT Setup Model")).toBeInTheDocument();
    expect(screen.getByText("Impulse")).toBeInTheDocument();

    detailTab.focus();
    fireEvent.keyDown(detailTab, { key: "ArrowRight" });
    expect(lifecycleTab).toHaveFocus();
    expect(lifecycleTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "What’s happening now" })).toBeInTheDocument();
    expect(screen.getByText("Confirmation and entry modes frozen at setup")).toBeInTheDocument();
    expect(screen.getByText("Indicator consensus")).toBeInTheDocument();
    expect(screen.getByText("Post-confirmation retracement")).toBeInTheDocument();
    expect(screen.getByText("#ea2b21ab")).toBeInTheDocument();
    expect(screen.getAllByText(/frozen OB/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /AUD\/JPY 33\.7% Watchlist/i }));
    expect(screen.getByRole("tab", { name: "Detail Breakdown" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("button", { name: /^Kill Switch$/i }));
    await waitFor(() => expect(api.killSwitch).toHaveBeenCalledWith(true));
  });

  it("shows a non-fatal session-priority observation failure without implying execution stopped", async () => {
    api.logs.mockResolvedValue([{
      scanned_at: "2026-08-26T22:12:37Z",
      pairs_scanned: 0,
      signals_found: 0,
      trades_placed: 0,
      details_json: [{
        __meta: true,
        activeStyle: "day_trader",
        impulseRotation: {
          sessionObservation: {
            contract: "session-aware-rotation-observation.v1",
            mode: "observe",
            status: "unavailable",
            affectsExecution: false,
            additionalMarketDataCalls: 0,
            style: "day_trader",
            session: { name: "Off-Hours", filterKey: "offhours", isKillZone: false },
            actual: [],
            unavailableReason: "invalid observation input",
          },
        },
      }],
    }]);

    renderDashboard();
    const sessionPriority = await screen.findByRole("status", {
      name: "Session-aware scan priority observation",
    });
    expect(within(sessionPriority).getByText("Unavailable")).toBeInTheDocument();
    expect(within(sessionPriority).getByText(/scan continued unchanged/i)).toBeInTheDocument();
  });

  it("shows when the shared market schedule has reduced scanning to crypto", async () => {
    api.logs.mockResolvedValue([{
      scanned_at: "2026-08-29T16:00:00Z",
      pairs_scanned: 2,
      signals_found: 0,
      trades_placed: 0,
      details_json: [{
        __meta: true,
        activeStyle: "scalper",
        marketSchedule: {
          reason: "weekend_crypto_only",
          eligibleSymbols: ["BTC/USD", "ETH/USD"],
          excludedSymbols: ["EUR/USD", "XAU/USD"],
          nonCryptoMarketsClosed: true,
          nonCryptoTradingDayEnabled: false,
          effectiveTradingDay: 6,
        },
      }],
    }]);

    renderDashboard();
    const marketSchedule = await screen.findByRole("status", {
      name: "Market schedule",
    });
    expect(within(marketSchedule).getByText("Weekend")).toBeInTheDocument();
    expect(within(marketSchedule).getByText("Crypto only")).toBeInTheDocument();
    expect(within(marketSchedule).getByText(/2 closed-market instruments paused/i)).toBeInTheDocument();
  });

  it("describes an unqualified impulse candidate without claiming no impulse exists", async () => {
    api.logs.mockResolvedValue([{
      scanned_at: "2026-08-26T22:12:37Z",
      pairs_scanned: 1,
      signals_found: 0,
      trades_placed: 0,
      details_json: [{
        pair: "EUR/AUD",
        direction: "short",
        score: 28.6,
        status: "skipped_no_impulse_zone",
        unifiedZone: {
          hasZone: false,
          state: "no_zone",
          selectedTF: "1H",
          unifiedScore: 0,
          scoreBreakdown: {
            baseScore: 0,
            liquidityBonus: 0,
            confirmationBonus: 0,
            tfBonus: 0,
            total: 0,
          },
          impulse: {
            direction: "bearish",
            high: 1.63148,
            low: 1.62313,
            pips: 83.5,
            timeframe: "1H",
            startDate: "2026-08-25T15:00:00Z",
            endDate: "2026-08-25T22:00:00Z",
            spanBars: 7,
            bosPrice: 1.62313,
            qualification: {
              state: "developing",
              reasons: ["No accepted FVG or Order Block was created by the impulse"],
              measurements: {},
            },
          },
          zone: null,
          price: {
            currentPrice: 1.624,
            atZone: false,
            atZoneStrict: false,
            insideZone: false,
            distancePips: 0,
            sideOk: false,
          },
          liquidity: null,
          confirmation: null,
          entry: null,
          storySummary: "Impulse candidate not yet qualified",
          reason: "No valid zone on any timeframe",
        },
      }],
    }]);
    api.pendingSnapshot.mockResolvedValue({ active: [], history: [], fetchedAt: null });

    renderDashboard();

    expect((await screen.findAllByText("impulse candidate found · no valid entry zone")).length).toBeGreaterThan(0);
    expect(screen.getByText("— No Entry Zone")).toBeInTheDocument();
    expect(screen.queryByText("skipped no impulse zone")).toBeNull();
  });

  it("renders the frozen nested POI route instead of CHoCH and retracement", async () => {
    api.pendingSnapshot.mockResolvedValue({
      fetchedAt: "2026-08-23T14:31:20Z",
      history: [],
      active: [{
        order_id: "nested-order-1",
        symbol: "AUD/JPY",
        direction: "long",
        order_type: "limit_ob",
        entry_price: 112.48,
        current_price: 112.50,
        stop_loss: 112.27,
        take_profit: 112.77,
        size: null,
        entry_zone_type: "ob",
        entry_zone_low: 112.32812,
        entry_zone_high: 112.58252,
        status: "awaiting_confirmation",
        expiry_minutes: 2160,
        expires_at: "2026-08-24T16:00:00Z",
        fill_reason: null,
        cancel_reason: null,
        filled_at: null,
        resolved_at: null,
        signal_reason: {},
        signal_score: 33.7,
        setup_type: "ob",
        setup_confidence: null,
        from_watchlist: true,
        candidate_id: "ea2b21ab-02f9-4015-9560-f63d98617983",
        confirmation_method: "choch",
        confirmation_config: {
          afterChochMode: "wait_retracement",
          entryMode: "nested_poi_market",
        },
        frozen_strategy_context: {
          contractVersion: "setup-policy-freeze.v1",
          nestedPoiEntry: {
            contractVersion: "nested-poi-entry.v1",
            enforcement: "observe_only",
            mode: "enforce_paper",
            route: "nested_poi_market",
            monitoringTimeframe: "5m",
            direction: "long",
            frozenAt: "2026-08-23T14:00:00Z",
            outerCandidateId: "outer-1",
            outerZone: { low: 112.32812, high: 112.58252, direction: "bullish" },
            selected: {
              id: "inner-breaker",
              type: "breaker",
              geometry: "range",
              low: 112.45,
              high: 112.48,
              entryPrice: 112.48,
              timeframe: "5m",
            },
            candidates: [],
            reason: "selected",
          },
        },
        post_confirmation_entry: {
          state: "awaiting_retracement",
          zone: { type: "micro_ob", low: 112.6, high: 112.7, midpoint: 112.65 },
          protectedLevel: 112.3,
          expiresAt: "2026-08-23T15:00:00Z",
          reason: "stale legacy artifact",
        },
        impulse_entry_lifecycle: {
          mode: "enforce",
          entryMode: "nested_poi_market",
          status: "active",
          activeCandidateId: "inner-breaker",
          impulse: { timeframe: "5m", protectedLevel: 112.27 },
          candidates: [],
          confirmation: null,
          lastTransitionReason: "Outer zone touched",
        },
        staged_cycles: 2,
        staged_initial_score: 33.7,
        exit_flags: {},
        final_authorization: null,
        decision_context: null,
        placed_at: "2026-08-23T14:00:00Z",
        created_at: "2026-08-23T14:00:00Z",
        updated_at: "2026-08-23T14:31:00Z",
      }],
    });

    renderDashboard();
    fireEvent.click(await screen.findByRole("tab", { name: "Lifecycle" }));

    expect(screen.getByText("Nested POI market route frozen at setup")).toBeInTheDocument();
    expect(screen.getByText("Outer zone entered")).toBeInTheDocument();
    expect(screen.getByText("Nested POI trigger")).toBeInTheDocument();
    expect(screen.getAllByText(/Active breaker 112.45 - 112.48 on 5m/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Displaced MSS / CHoCH")).not.toBeInTheDocument();
    expect(screen.queryByText("Micro OB retracement")).not.toBeInTheDocument();
  });

  it("does not attach an unrelated active order lifecycle to the selected scan", async () => {
    api.logs.mockResolvedValue([{
      scanned_at: "2026-08-26T17:48:21Z",
      pairs_scanned: 2,
      signals_found: 1,
      trades_placed: 0,
      details_json: [
        {
          pair: "USD/CHF",
          direction: "neutral",
          score: 61.7,
          status: "rejected",
          reason: "Effective R:R is below the required minimum",
        },
        {
          pair: "XAU/USD",
          direction: "short",
          score: 42,
          status: "zone_setup_active",
          reason: "Zone setup active",
          setupIdentity: {
            orderId: "xau-order",
            stagedSetupId: "xau-setup",
            candidateId: "xau-candidate",
            impulseEntryLifecycleId: "xau-impulse-lifecycle",
          },
        },
      ],
    }]);
    api.pendingSnapshot.mockResolvedValue({
      fetchedAt: "2026-08-26T17:48:30Z",
      history: [],
      active: [{
        order_id: "xau-order",
        symbol: "XAU/USD",
        direction: "short",
        order_type: "limit_ob",
        entry_price: 4400,
        current_price: 4450,
        stop_loss: 4470,
        take_profit: 4300,
        size: null,
        entry_zone_type: "ob",
        entry_zone_low: 4390,
        entry_zone_high: 4410,
        status: "pending",
        expiry_minutes: 2880,
        expires_at: "2026-08-28T17:48:21Z",
        fill_reason: null,
        cancel_reason: null,
        filled_at: null,
        resolved_at: null,
        signal_reason: {},
        signal_score: 42,
        setup_type: "ob",
        setup_confidence: null,
        from_watchlist: true,
        candidate_id: "xau-candidate",
        staged_setup_id: "xau-setup",
        impulse_entry_lifecycle_id: "xau-impulse-lifecycle",
        staged_cycles: 1,
        staged_initial_score: 42,
        exit_flags: {},
        final_authorization: null,
        decision_context: null,
        placed_at: "2026-08-26T17:40:00Z",
        created_at: "2026-08-26T17:40:00Z",
        updated_at: "2026-08-26T17:47:00Z",
      }],
    });
    api.lifecycleEvents.mockResolvedValue([{
      id: "event-xau",
      staged_setup_id: "xau-setup",
      candidate_id: "xau-candidate",
      symbol: "XAU/USD",
      direction: "short",
      from_status: "watching",
      to_status: "pending",
      lifecycle_phase: "zone_discovered",
      reason: "XAU setup armed",
      reason_code: "pending_created",
      evidence: {},
      created_at: "2026-08-26T17:40:00Z",
      bot_id: "smc",
      user_id: "user-1",
    }]);
    api.impulseLifecycleTransitions.mockResolvedValue([{
      id: "impulse-event-xau",
      lifecycle_id: "xau-impulse-lifecycle",
      user_id: "user-1",
      event_type: "zone_touched",
      reason: "Nested XAU zone touched",
      event_payload: {},
      lifecycle_snapshot: {},
      from_candidate_id: "xau-candidate",
      to_candidate_id: "xau-candidate",
      from_revision: 1,
      to_revision: 2,
      created_at: "2026-08-26T17:45:00Z",
    }]);

    renderDashboard();

    fireEvent.click(await screen.findByRole("button", { name: /USD\/CHF 61\.7% Rejected/i }));
    expect(await screen.findByText("No active setup linked to USD/CHF")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Lifecycle" }));
    expect(screen.getByText(/No active order is linked to the selected USD\/CHF scan/i)).toBeInTheDocument();
    expect(screen.queryByText("XAU setup armed")).toBeNull();
    expect(screen.queryByText("Nested XAU zone touched")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Select XAU\/USD active setup/i }));
    expect(await screen.findByText(/Frozen .* · Updated .*/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(api.lifecycleEvents).toHaveBeenLastCalledWith({
        stagedSetupId: "xau-setup",
        candidateId: "xau-candidate",
      });
      expect(api.impulseLifecycleTransitions).toHaveBeenLastCalledWith(
        "xau-impulse-lifecycle",
      );
    });
    expect(screen.getByText("XAU setup armed")).toBeInTheDocument();
    expect(screen.getByText("Nested XAU zone touched")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Detail Breakdown" }));
    fireEvent.click(screen.getByRole("button", { name: /USD\/CHF 61\.7% Rejected/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Lifecycle" }));
    expect(screen.queryByText("XAU setup armed")).toBeNull();
    expect(screen.queryByText("Nested XAU zone touched")).toBeNull();
  });

  it("keeps global recent activity visible when the selected scan has no lifecycle identity", async () => {
    api.logs.mockResolvedValue([{
      scanned_at: "2026-08-27T15:00:00Z",
      pairs_scanned: 1,
      signals_found: 0,
      trades_placed: 0,
      details_json: [{
        pair: "USD/CHF",
        direction: "neutral",
        score: 18,
        status: "skipped",
        reason: "No valid impulse or entry zone",
      }],
    }]);
    api.pendingSnapshot.mockResolvedValue({
      active: [],
      history: [{
        order_id: "resolved-xau-order",
        symbol: "XAU/USD",
        direction: "long",
        entry_zone_type: "ob",
        status: "cancelled",
        cancel_reason: "Frozen target already reached",
        resolved_at: "2026-08-27T14:55:00Z",
      }],
      fetchedAt: "2026-08-27T15:00:05Z",
    });

    renderDashboard();
    fireEvent.click(await screen.findByRole("tab", { name: "Lifecycle" }));

    expect(screen.getByText("Scan completed")).toBeInTheDocument();
    expect(screen.getByText("XAU/USD · cancelled")).toBeInTheDocument();
    expect(screen.getByText("Frozen target already reached")).toBeInTheDocument();
    expect(screen.queryByText("No persisted events for this selected setup.")).toBeNull();
  });

  it("opens the selected staged candidate from its persisted snapshot and lifecycle identity", async () => {
    api.activeStaged.mockResolvedValue([{
      id: "staged-usdcad",
      user_id: "user-1",
      bot_id: "smc",
      symbol: "USD/CAD",
      direction: "long",
      initial_score: 40.1,
      current_score: 44.3,
      watch_threshold: 35,
      initial_factors: [{ name: "Order Block", weight: 2, tier: "T1" }],
      current_factors: [{ name: "Order Block", weight: 2, tier: "T1" }],
      missing_factors: [{ name: "Confirmation", weight: 1, tier: "T2" }],
      entry_price: 1.3542,
      sl_level: 1.349,
      tp_level: 1.361,
      status: "watching",
      candidate_id: "candidate-usdcad",
      lifecycle_version: "phase4.v1",
      lifecycle_reason: "Frozen zone retained; waiting for price and confirmation",
      lifecycle_phase: "zone_discovered",
      lifecycle_reason_code: "waiting_for_zone_confirmation",
      lifecycle_evidence: {
        phase: "zone_discovered",
        milestones: ["zone_discovered"],
        observedAt: "2026-08-29T21:58:00Z",
        observedPrice: 1.3542,
        frozenDirection: "long",
        boundary: {
          level: 1.349,
          source: "impulse_origin",
          bufferPrice: 0.0005,
        },
        score: 44.3,
        threshold: 35,
      },
      impulse_entry_lifecycle_id: "impulse-life-usdcad",
      impulse_entry_lifecycle: {
        mode: "observe",
        status: "active",
        activeCandidateId: "zone-usdcad",
        impulse: { timeframe: "1H", protectedLevel: 1.349 },
        candidates: [{
          id: "zone-usdcad",
          type: "order_block",
          low: 1.351,
          high: 1.352,
          timeframe: "15m",
          state: "active",
        }],
        lastTransitionReason: "Initial zone activated",
      },
      qualified_at: null,
      pending_order_id: null,
      position_id: null,
      game_plan_id: "plan-usdcad",
      game_plan_version: "gameplan-v3",
      direction_verdict_id: "verdict-usdcad",
      direction_verdict: { verdict: "long" },
      thesis_version: "thesis-v2",
      originating_zone: {
        type: "ob",
        low: 1.351,
        high: 1.352,
        entry: 1.3515,
        stopLoss: 1.3485,
        takeProfit: 1.361,
      },
      execution_eligible: true,
      observation_parent_id: null,
      observation_reason: null,
      confirmation_method: "choch",
      confirmation_config: {
        indicatorMinCount: 3,
        afterChochMode: "confirmation_close",
        afterChochExpiryMinutes: 30,
      },
      authorization_result: null,
      scan_cycles: 3,
      min_cycles: 1,
      ttl_minutes: 240,
      promotion_reason: null,
      invalidation_reason: null,
      setup_type: "order_block_retest",
      tier1_count: 1,
      tier2_count: 0,
      tier3_count: 0,
      analysis_snapshot: {},
      staged_at: "2026-08-29T21:45:00Z",
      last_eval_at: "2026-08-29T21:58:00Z",
      resolved_at: null,
      created_at: "2026-08-29T21:45:00Z",
      updated_at: "2026-08-29T21:58:00Z",
    }]);
    api.lifecycleEvents.mockResolvedValue([{
      id: "event-usdcad",
      staged_setup_id: "staged-usdcad",
      candidate_id: "candidate-usdcad",
      symbol: "USD/CAD",
      direction: "long",
      from_status: null,
      to_status: "watching",
      lifecycle_phase: "zone_discovered",
      reason: "Frozen USD/CAD zone discovered",
      reason_code: "waiting_for_zone_confirmation",
      evidence: {},
      created_at: "2026-08-29T21:45:00Z",
      bot_id: "smc",
      user_id: "user-1",
    }]);
    api.impulseLifecycleTransitions.mockResolvedValue([]);

    renderDashboard();

    fireEvent.click(await screen.findByRole("button", {
      name: "View USD/CAD staged candidate",
    }));

    expect(screen.getByRole("heading", { name: "Staged Candidate" })).toBeInTheDocument();
    expect(screen.getAllByText("1.35100–1.35200").length).toBeGreaterThan(0);
    expect(screen.getByText((_, element) =>
      element?.textContent === "Planned entry: 1.35150"
    )).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.textContent === "Latest staged reference: 1.35420"
    )).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.textContent === "Structural invalidation: 1.34900"
    )).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.textContent === "Planned position stop: 1.34850"
    )).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.textContent === "Projected target: 1.36100"
    )).toBeInTheDocument();
    expect(screen.getByText(/Frozen zone retained; waiting for price and confirmation/i)).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.textContent === "Initial 40.1%"
    )).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.textContent === "Watch floor 35.0%"
    )).toBeInTheDocument();
    expect(screen.queryByText("ICT Setup Model")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Lifecycle" }));
    await waitFor(() => {
      expect(api.lifecycleEvents).toHaveBeenLastCalledWith({
        stagedSetupId: "staged-usdcad",
        candidateId: "candidate-usdcad",
      });
      expect(api.impulseLifecycleTransitions).toHaveBeenLastCalledWith(
        "impulse-life-usdcad",
      );
    });
    expect(screen.getByText("Frozen USD/CAD zone discovered")).toBeInTheDocument();
    expect(screen.queryByText("Indicator consensus")).toBeNull();
  });
});
