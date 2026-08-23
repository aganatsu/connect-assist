import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  stopEngine: vi.fn(),
  setExecutionMode: vi.fn(),
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
    startEngine: api.startEngine,
    pauseEngine: api.pauseEngine,
    stopEngine: api.stopEngine,
    setExecutionMode: api.setExecutionMode,
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

function knownStatus(overrides: Record<string, unknown> = {}) {
  return {
    isRunning: true,
    isPaused: false,
    executionMode: "paper",
    killSwitchActive: false,
    balance: 10_000,
    positions: [],
    tradeHistory: [],
    ...overrides,
  };
}

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

describe("OperationsDashboard safety integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.status.mockResolvedValue(knownStatus());
    api.logs.mockResolvedValue([]);
    api.pendingSnapshot.mockResolvedValue({ active: [], history: [], fetchedAt: null });
    api.activeStaged.mockResolvedValue([]);
    api.connections.mockResolvedValue([]);
    api.connectionStatus.mockResolvedValue({ ready: true });
    api.accountSummary.mockResolvedValue({ balance: 10_000, equity: 10_000 });
    api.openTrades.mockResolvedValue([]);
    api.closeTrade.mockResolvedValue({ success: true });
    api.startEngine.mockResolvedValue({ success: true });
    api.pauseEngine.mockResolvedValue({ success: true });
    api.stopEngine.mockResolvedValue({ success: true });
    api.setExecutionMode.mockResolvedValue({ success: true, executionMode: "paper" });
    api.killSwitch.mockResolvedValue({ success: true });
    api.closePosition.mockResolvedValue({ success: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("keeps risk-reducing controls available while account state is unknown", async () => {
    api.status.mockReturnValue(new Promise(() => undefined));
    api.connections.mockReturnValue(new Promise(() => undefined));
    renderDashboard();

    const pause = await screen.findByRole("button", { name: "Pause engine" });
    expect(pause).toBeEnabled();
    expect(screen.getByRole("button", { name: "Stop engine" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Mode unknown" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run scan now" })).toBeDisabled();
    expect(screen.queryByText("Engine stopped")).not.toBeInTheDocument();

    fireEvent.click(pause);
    await waitFor(() => expect(api.pauseEngine).toHaveBeenCalledTimes(1));
  });

  it("shows known positions without claiming complete exposure when one broker is not ready", async () => {
    api.status.mockResolvedValue(knownStatus({ executionMode: "live" }));
    api.connections.mockResolvedValue([
      { id: "ready", display_name: "FTMO", is_active: true },
      { id: "offline", display_name: "Small Live", is_active: true },
    ]);
    api.connectionStatus.mockImplementation(async (connectionId: string) => ({ ready: connectionId === "ready" }));
    api.openTrades.mockImplementation(async (connectionId: string) => {
      if (connectionId !== "ready") throw new Error("Broker position state unavailable");
      return [{
        id: "trade-1",
        symbol: "EUR/USD",
        direction: "long",
        openPrice: 1.1,
        currentPrice: 1.101,
        profit: 10,
      }];
    });
    renderDashboard();

    const modeButton = await screen.findByRole("button", { name: "→ Paper" });
    await waitFor(() => expect(modeButton).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Positions" }));
    expect(await screen.findByText(/Broker exposure could not be verified for every active connection/i)).toBeInTheDocument();
    expect(screen.getByText("EUR/USD")).toBeInTheDocument();
    expect(screen.queryByText(/report no open trades/i)).not.toBeInTheDocument();
    expect(api.openTrades).toHaveBeenCalledTimes(2);
  });

  it("allows a disconnected but confirmed-flat broker to return to paper", async () => {
    api.status.mockResolvedValue(knownStatus({ executionMode: "live" }));
    api.connections.mockResolvedValue([{ id: "offline", display_name: "Small Live", is_active: true }]);
    api.connectionStatus.mockResolvedValue({ ready: false });
    api.openTrades.mockResolvedValue([]);
    renderDashboard();

    const modeButton = await screen.findByRole("button", { name: "→ Paper" });
    await waitFor(() => expect(modeButton).toBeEnabled());
    expect(api.openTrades).toHaveBeenCalledWith("offline");
    expect(api.accountSummary).not.toHaveBeenCalled();
  });

  it("allows paper mode only after every broker reports verified empty exposure", async () => {
    api.status.mockResolvedValue(knownStatus({ executionMode: "live" }));
    api.connections.mockResolvedValue([{ id: "ready", display_name: "FTMO", is_active: true }]);
    api.setExecutionMode.mockResolvedValue({ success: true, executionMode: "paper" });
    renderDashboard();

    const modeButton = await screen.findByRole("button", { name: "→ Paper" });
    await waitFor(() => expect(modeButton).toBeEnabled());
    fireEvent.click(modeButton);
    await waitFor(() => expect(api.setExecutionMode).toHaveBeenCalledWith("paper"));
  });

  it("labels managed closes as broker-first and refreshes both exposure ledgers", async () => {
    api.status.mockResolvedValue(knownStatus({
      positions: [{
        id: "position-1",
        symbol: "GBP/USD",
        direction: "long",
        entryPrice: 1.3,
        currentPrice: 1.301,
        pnl: 12,
      }],
    }));
    api.connections.mockResolvedValue([{ id: "ready", display_name: "FTMO", is_active: true }]);
    renderDashboard();

    fireEvent.click(screen.getByRole("button", { name: "Positions" }));
    const closeButton = await screen.findByRole("button", { name: /Close managed position/i });
    fireEvent.click(closeButton);

    await waitFor(() => expect(api.closePosition).toHaveBeenCalledWith("position-1"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Linked live broker positions close first"));
    await waitFor(() => expect(api.openTrades.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(api.accountSummary.mock.calls.length).toBeGreaterThan(1));
  });

  it("disables broker and managed closes when their record IDs are unavailable", async () => {
    api.status.mockResolvedValue(knownStatus({
      executionMode: "live",
      positions: [{ symbol: "GBP/USD", direction: "long", entryPrice: 1.3, currentPrice: 1.301, pnl: 12 }],
    }));
    api.connections.mockResolvedValue([{ id: "ready", display_name: "FTMO", is_active: true }]);
    api.openTrades.mockResolvedValue([{ symbol: "EUR/USD", direction: "long", openPrice: 1.1, currentPrice: 1.101, profit: 10 }]);
    renderDashboard();

    fireEvent.click(screen.getByRole("button", { name: "Positions" }));
    expect(await screen.findByRole("button", { name: /Close at broker/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Close managed position/i })).toBeDisabled();
  });
});
