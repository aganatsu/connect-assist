import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("editorial operations dashboard wiring", () => {
  it("owns the /bot route without bypassing the shared shell contract", () => {
    const app = read("App.tsx");
    const page = read("pages/OperationsDashboard.tsx");
    const shell = read("components/AppShell.tsx");

    expect(app).toContain('import OperationsDashboard from "./pages/OperationsDashboard"');
    expect(app).toContain('<OperationsDashboard />');
    expect(page).toContain('<AppShell variant="operations">');
    expect(shell).toContain('variant?: "default" | "operations"');
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

    expect(page).toContain("scannerApi.manualScan()");
    expect(page).toContain("paperApi.killSwitch(true)");
    expect(page).toContain("paperApi.stopEngine()");
    expect(page).toContain("paperApi.setExecutionMode(mode)");
    expect(page).toContain("stopPolicyPresentation(focusedOrder)");
    expect(page).toContain("downloadScanCsv(scanDetails");
    expect(page).toContain('setScanFilter(value)');
    expect(css).toContain("@media (max-width: 899px)");
    expect(css).toContain("grid-template-columns: minmax(260px, 0.82fr)");
    expect(css).toContain("env(safe-area-inset-bottom)");
    expect(css).not.toContain("linear-gradient");
  });
});
