/**
 * System Reset & Ledger Health — rendered UI contracts.
 *
 * Mounts the presentational panel with readiness fixtures (production state on
 * 2026-10-05 after the ledger went live, and an all-green state). The server is
 * the security boundary; these prove the screen never offers the reset when it
 * should not and never fires it without the exact typed phrase.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() }, rpc: vi.fn() } }));

import { SystemResetPanel } from "../SystemResetPanel";
import type { Readiness } from "@/lib/systemReset";

const cond = (key: string, label: string, pass: boolean, detail = "") => ({ key, label, pass, detail });
const CONDITIONS_LIVE = [
  cond("monitoring_window_complete", "24-hour monitoring period completed", false, "in progress — completes 2026-10-06T17:20:36.756Z"),
  cond("monitoring_checks_passed", "All monitoring checks passed", false, "2 periodic run(s), 0 failed; final not yet"),
  cond("drift_zero", "Reconciliation drift = $0", true, "drift 0"),
  cond("no_unledgered_writes", "Unledgered writes = 0", true),
  cond("no_unsettled_closes", "Unsettled closed trades = 0", true),
  cond("settlement_ledger_healthy", "Settlement ledger healthy", true),
  cond("guard_blocking", "Direct-write protection is BLOCKING", false, "guard mode RECORDING"),
  cond("accounting_migrations_present", "Accounting migrations present", true),
  cond("no_active_settlement_error", "No active settlement error", true),
  cond("market_data_fresh", "Prices and FX rates fresh (needed to close old positions at market)", true),
];

const live: Readiness = {
  generated_at: "2026-10-05T21:30:00Z", ready: false, execute_enabled: false, fingerprint: "a1b2c3d4e5f6a7b8",
  conditions: CONDITIONS_LIVE, blocking: CONDITIONS_LIVE.filter((c) => !c.pass),
  monitor: { status: "PASS", last_run_at: "2026-10-05T20:17:00Z", last_pass_at: "2026-10-05T20:17:00Z", runs_this_window: 2, failed_runs_this_window: 0 },
  window: { status: "In Progress", started_at: "2026-10-05T17:20:36.756Z", completes_at: "2026-10-06T17:20:36.756Z", final_run_at: null, final_pass: null },
  metrics: {
    drift: 0, unledgered_writes: 0, unsettled_closes: 0, duplicate_settlements: 0,
    balance: 105879.62, equity: 105335.66, unrealized_pnl: -543.96,
    open_positions: 2, pending_orders: 2, active_setups: 1, guard_mode: "RECORDING", is_paused: false,
  },
  old_period: {
    positions: [
      { id: "6bf40147", position_id: "3f39df7b", symbol: "GBP/USD", direction: "short", size: 2.46, entry_price: 1.32125, current_price: 1.32112,
        stop_loss: 1.3251992, take_profit: 1.31617088, open_time: "2026-10-05T16:27:06Z", created_at: "2026-10-05T16:27:06Z", unrealized_usd: 31.98 },
      { id: "82541e09", position_id: "2527bfa5", symbol: "CHF/JPY", direction: "long", size: 4.47, entry_price: 190.31367, current_price: 190.11012,
        stop_loss: 189.860209, take_profit: 190.64615658, open_time: "2026-10-05T11:04:02Z", created_at: "2026-10-05T11:04:02Z", unrealized_usd: -575.94 },
    ],
    pending: [
      { id: "92e4d8d1", order_id: "ed07f20a", symbol: "USD/JPY", direction: "short", status: "awaiting_confirmation", entry_price: 158.04, placed_at: "2026-10-05T14:50:11Z", expires_at: "2026-10-05T22:50:11Z" },
      { id: "ee809be7x", order_id: "ee809be7", symbol: "BTC/USD", direction: "long", status: "awaiting_confirmation", entry_price: 85366.3, placed_at: "2026-10-05T17:10:03Z", expires_at: "2026-10-06T01:10:03Z" },
    ],
    setups: [{ id: "s1", symbol: "EUR/USD", direction: "long", status: "watching", created_at: "2026-10-05T20:00:00Z" }],
  },
  recent_runs: [],
};
const green: Readiness = {
  ...live, ready: true, execute_enabled: true,
  conditions: CONDITIONS_LIVE.map((c) => ({ ...c, pass: true })), blocking: [],
  window: { ...live.window, status: "Complete", final_run_at: "2026-10-06T17:25:00Z", final_pass: true },
  metrics: { ...live.metrics, guard_mode: "BLOCKING" },
};

const metric = (label: string) => screen.getByTestId(`metric-${label}`).textContent;

describe("System Reset & Ledger Health", () => {
  it("shows every required field", () => {
    render(<SystemResetPanel readiness={live} />);
    for (const label of ["Ledger monitor", "24h monitoring window", "Monitoring started", "Monitoring completes", "Last successful monitor run",
      "Reconciliation drift", "Unledgered / direct balance writes", "Closed trades without settlement", "Duplicate settlements",
      "Stored balance", "Equity", "Open positions", "Pending orders", "Watched / armed setups", "Direct-write guard", "Reset readiness"]) {
      expect(screen.getByTestId(`metric-${label}`)).toBeTruthy();
    }
    expect(metric("Ledger monitor")).toContain("PASS");
    expect(metric("24h monitoring window")).toContain("In Progress");
    expect(metric("Stored balance")).toContain("$105,879.62");
    expect(metric("Equity")).toContain("$105,335.66");
    expect(metric("Direct-write guard")).toContain("RECORDING");
    expect(metric("Reset readiness")).toContain("NOT READY");
  });

  it("names exactly which prerequisites block the reset, and disables approval", () => {
    render(<SystemResetPanel readiness={live} />);
    expect(screen.getByTestId("readiness-badge").textContent).toContain("NOT READY");
    const blocking = screen.getByTestId("blocking-summary").textContent!;
    expect(blocking).toContain("24-hour monitoring period completed");
    expect(blocking).toContain("Direct-write protection is BLOCKING");
    expect(blocking).not.toContain("Reconciliation drift");
    expect(screen.getByTestId("condition-guard_blocking").getAttribute("data-pass")).toBe("false");
    expect((screen.getByTestId("approve-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists the old-period positions, orders and setups that the reset would close/cancel", () => {
    render(<SystemResetPanel readiness={live} />);
    const pos = screen.getByTestId("old-positions");
    expect(within(pos).getByText("GBP/USD")).toBeTruthy();
    expect(within(pos).getByText("CHF/JPY")).toBeTruthy();
    expect(within(pos).getByText("-$575.94")).toBeTruthy();
    const orders = screen.getByTestId("old-orders");
    expect(within(orders).getByText("ed07f20a")).toBeTruthy();
    expect(within(orders).getByText("ee809be7")).toBeTruthy();
    expect(screen.getByTestId("old-setups").textContent).toContain("EUR/USD long (watching)");
  });

  it("stays disabled when READY but execution is switched off server-side", () => {
    render(<SystemResetPanel readiness={{ ...green, execute_enabled: false }} />);
    expect(screen.getByTestId("readiness-badge").textContent).toContain("READY");
    expect(screen.getByTestId("execute-disabled")).toBeTruthy();
    expect((screen.getByTestId("approve-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("one click only opens the dialog; the final button needs the exact phrase", async () => {
    const onExecute = vi.fn().mockResolvedValue({ status: "succeeded", resetId: "r1", verification: [] });
    render(<SystemResetPanel readiness={green} onExecute={onExecute} />);
    fireEvent.click(screen.getByTestId("approve-button"));
    expect(onExecute).not.toHaveBeenCalled();

    const dialog = screen.getByTestId("confirm-dialog");
    for (const text of ["$105,879.62", "$105,335.66", "closed at market", "cancelled", "will be reset", "preserved", "RESET 100000", "will NOT resume", "separately approved"]) {
      expect(dialog.textContent).toContain(text);
    }
    const input = screen.getByTestId("confirm-input");
    const final = () => screen.getByTestId("final-confirm") as HTMLButtonElement;
    expect(final().disabled).toBe(true);
    for (const wrong of ["reset 100000", "RESET 100,000", "RESET 100000 ", " RESET 100000", "RESET"]) {
      fireEvent.change(input, { target: { value: wrong } });
      expect(final().disabled, `"${wrong}" must not enable`).toBe(true);
    }
    fireEvent.change(input, { target: { value: "RESET 100000" } });
    expect(final().disabled).toBe(false);
    fireEvent.click(final());
    await vi.waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    const req = onExecute.mock.calls[0][0];
    expect(req.confirmation).toBe("RESET 100000");
    expect(req.fingerprint).toBe(green.fingerprint);
    expect(typeof req.requested_at).toBe("string");
  });

  it("shows where a failed reset stopped and that the bot was left paused", async () => {
    const onExecute = vi.fn().mockResolvedValue({ status: "failed", resetId: "r2", failedStep: "close_old_positions", reason: "settlement of CHF/JPY failed" });
    render(<SystemResetPanel readiness={green} onExecute={onExecute} />);
    fireEvent.click(screen.getByTestId("approve-button"));
    fireEvent.change(screen.getByTestId("confirm-input"), { target: { value: "RESET 100000" } });
    fireEvent.click(screen.getByTestId("final-confirm"));
    const result = await screen.findByTestId("reset-result");
    expect(result.textContent).toContain("FAILED");
    expect(result.textContent).toContain("close_old_positions");
    expect(result.textContent).toContain("left paused");
  });
});
