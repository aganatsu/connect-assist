import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
        { __meta: true, activeStyle: "scalper", creditBudget: { refused: 0, unenforced: 0 } },
        { pair: "AUD/JPY", direction: "long", score: 33.7, status: "zone_setup_active", reason: "Price at zone", currentPrice: 112.991 },
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

    expect(await screen.findByRole("heading", { name: "Latest Scan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Zone Setups" })).toBeInTheDocument();
    expect((await screen.findAllByText("AUD/JPY")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("33.7%").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/frozen OB/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /^Kill Switch$/i }));
    await waitFor(() => expect(api.killSwitch).toHaveBeenCalledWith(true));
  });
});
