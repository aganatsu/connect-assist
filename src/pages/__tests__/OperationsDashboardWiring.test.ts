import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("operations dashboard wiring", () => {
  it("owns the /bot route through the shared application shell", () => {
    const app = read("App.tsx");
    const page = read("pages/OperationsDashboard.tsx");
    const shell = read("components/AppShell.tsx");

    expect(app).toContain('import OperationsDashboard from "./pages/OperationsDashboard"');
    expect(app).toContain('<OperationsDashboard />');
    expect(page).toContain("<AppShell>");
    expect(page).not.toContain('<AppShell variant="operations">');
    expect(page).not.toContain('className="apex-topbar"');
    expect(page).not.toContain('className="apex-sidebar"');
    expect(shell).not.toContain('"operations"');
  });

  it("inherits the application theme instead of defining a private light palette", () => {
    const css = read("styles/operations-dashboard.css");

    expect(css).toMatch(/--paper:\s*hsl\(var\(--background\)\)/);
    expect(css).toMatch(/--ink:\s*hsl\(var\(--foreground\)\)/);
    expect(css).toMatch(/--rule:\s*hsl\(var\(--border\)\)/);
    expect(css).toMatch(/--sans:\s*var\(--font-sans\)/);
    expect(css).not.toMatch(/--paper:\s*#f4f3ef/i);
    expect(css).not.toMatch(/--ink:\s*#1f201d/i);
    expect(css).not.toContain('Georgia, "Times New Roman", serif');
  });

  it("uses existing operational APIs for every market-facing surface", () => {
    const page = read("pages/OperationsDashboard.tsx");

    expect(page).toContain("scannerApi.logs()");
    expect(page).toContain("scannerApi.pendingSnapshot()");
    expect(page).toContain("scannerApi.activeStaged()");
    expect(page).toContain("paperApi.status()");
    expect(page).toContain("brokerApi.list()");
    expect(page).toContain("brokerExecApi.connectionStatus(connection.id)");
    expect(page).toContain("brokerExecApi.openTrades(connection.id)");
    expect(page).toContain("scannerApi.cancelPending(orderId)");
    expect(page).toContain("scannerApi.dismissStaged(setupId)");
    expect(page).toContain("pendingOrderDisplayStage(order)");
    expect(page).not.toContain("112.991");
  });

  it("keeps the key controls functional and the layout responsive", () => {
    const page = read("pages/OperationsDashboard.tsx");
    const css = read("styles/operations-dashboard.css");
    const shell = read("components/AppShell.tsx");

    expect(page).toContain("scannerApi.manualScan()");
    expect(page).toContain("paperApi.killSwitch(true)");
    expect(page).toContain("paperApi.stopEngine()");
    expect(page).toContain("paperApi.setExecutionMode(mode)");
    expect(page).toContain("stopPolicyPresentation(focusedOrder)");
    expect(page).toContain("downloadScanCsv(scanDetails");
    expect(page).toContain('setScanFilter(value)');
    expect(css).toContain("@media (max-width: 899px)");
    expect(css).toContain("grid-template-columns: minmax(260px, 0.82fr)");
    expect(shell).toContain("env(safe-area-inset-bottom)");
    expect(css).not.toContain("linear-gradient");
  });
});
