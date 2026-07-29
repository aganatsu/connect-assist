import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const refreshFunctionSource = readFileSync(
  join(process.cwd(), "supabase/functions/game-plan-refresh/index.ts"),
  "utf8",
);

const gamePlanPanelSource = readFileSync(
  join(process.cwd(), "src/components/GamePlanPanel.tsx"),
  "utf8",
);

describe("manual Game Plan refresh safety", () => {
  it("generates and stores a new plan", () => {
    expect(refreshFunctionSource).toContain("generateInstrumentGamePlan");
    expect(refreshFunctionSource).toContain('source: "manual_refresh"');
    expect(refreshFunctionSource).toContain("persistActiveGamePlan");
    expect(refreshFunctionSource).toContain('.from("scan_logs")');
  });

  it("does not enter trading or position-management paths", () => {
    expect(refreshFunctionSource).not.toContain("paper_positions");
    expect(refreshFunctionSource).not.toContain("manageOpenPositions");
    expect(refreshFunctionSource).not.toContain("place_order");
    expect(refreshFunctionSource).not.toContain("broker-execute");
  });

  it("wires the Game Plan button to regeneration instead of a query-only refresh", () => {
    expect(gamePlanPanelSource).toContain("mutationFn: scannerApi.refreshGamePlan");
    expect(gamePlanPanelSource).toContain('aria-label="Regenerate game plan"');
    expect(gamePlanPanelSource).toContain('.from("active_game_plans")');
    expect(gamePlanPanelSource).not.toContain('.from("scan_logs")');
    expect(gamePlanPanelSource).not.toContain("onClick={() => refetch()}");
  });
});
