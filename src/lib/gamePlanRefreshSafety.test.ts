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

const scannerSource = readFileSync(
  join(process.cwd(), "supabase/functions/bot-scanner/index.ts"),
  "utf8",
);

const scheduledMigrationSource = readFileSync(
  join(process.cwd(), "supabase/migrations/20260804110000_schedule_game_plan_authority_refresh.sql"),
  "utf8",
);

describe("manual Game Plan refresh safety", () => {
  it("generates and stores a new plan", () => {
    expect(refreshFunctionSource).toContain("generateInstrumentGamePlan");
    expect(refreshFunctionSource).toContain('source: "manual_refresh"');
    expect(refreshFunctionSource).toContain("persistActiveGamePlan");
  });

  it("retries missing pairs and never activates an incomplete plan", () => {
    expect(refreshFunctionSource).toContain("generateGamePlansWithRetry");
    expect(refreshFunctionSource).toContain(
      "if (blockingMissing.length > 0 || generation.plans.length === 0)",
    );
    expect(refreshFunctionSource).toContain(
      "previous complete plan remains active",
    );
    expect(refreshFunctionSource).not.toContain('.from("scan_logs")');
    expect(refreshFunctionSource).not.toContain("pairs_scanned: 0");
  });

  it("uses market-aware completeness so closed weekend pairs cannot block crypto", () => {
    expect(refreshFunctionSource).toContain("resolveGamePlanMarketScope");
    expect(refreshFunctionSource).toContain(
      "symbols: marketScope.eligibleSymbols",
    );
    expect(scannerSource).toContain("gamePlanSymbolsMatchScope");
    expect(gamePlanPanelSource).toContain("STALE PLAN");
    expect(gamePlanPanelSource).toContain("currentPlanIsExpired");
  });

  it("does not enter trading or position-management paths", () => {
    expect(refreshFunctionSource).not.toContain("paper_positions");
    expect(refreshFunctionSource).not.toContain("manageOpenPositions");
    expect(refreshFunctionSource).not.toContain("place_order");
    expect(refreshFunctionSource).not.toContain("broker-execute");
  });

  it("wires the Game Plan button to regeneration instead of a query-only refresh", () => {
    expect(gamePlanPanelSource).toContain(
      "mutationFn: scannerApi.refreshGamePlan",
    );
    expect(gamePlanPanelSource).toContain('aria-label="Regenerate game plan"');
    expect(gamePlanPanelSource).toContain('.from("active_game_plans")');
    expect(gamePlanPanelSource).not.toContain('.from("scan_logs")');
    expect(gamePlanPanelSource).not.toContain("onClick={() => refetch()}");
  });
});

describe("automatic Game Plan refresh safety", () => {
  it("keeps generation and activation out of the trading scanner", () => {
    expect(scannerSource).toContain("loadActiveGamePlan(");
    for (
      const forbiddenCall of [
        "generateInstrumentGamePlan(",
        "buildSessionGamePlan(",
        "fetchNewsForGamePlan(",
        "persistActiveGamePlan(",
        "applyGamePlanValidityWindow(",
      ]
    ) {
      expect(scannerSource).not.toContain(forbiddenCall);
    }
    expect(scannerSource).not.toContain('source: "automatic_scan"');
    expect(refreshFunctionSource).toContain("generateInstrumentGamePlan(");
    expect(refreshFunctionSource).toContain("persistActiveGamePlan(");
  });

  it("keeps rotating discovery slots out of Game Plan authority scope", () => {
    expect(scannerSource).toContain(
      "resolveGamePlanMarketScope(\n        fullInstrumentUniverse,"
    );
    expect(scannerSource).not.toContain(
      "resolveGamePlanMarketScope(scanUniverse, now)"
    );
  });

  it("refreshes independently of scanner trade and position gates", () => {
    expect(scheduledMigrationSource).toContain("game-plan-authority-refresh-15min");
    expect(scheduledMigrationSource).toContain("/functions/v1/game-plan-refresh");
    expect(scheduledMigrationSource).toContain("x-cron-secret");
    expect(refreshFunctionSource).toContain("body.source === \"scheduled\"");
    expect(refreshFunctionSource).toContain("* 0.75");
  });

  it("records refresh health and exposes exact failures in the Game Plan panel", () => {
    expect(refreshFunctionSource).toContain("recordRefreshFailure");
    expect(refreshFunctionSource).toContain("game_plan_refresh_status");
    expect(gamePlanPanelSource).toContain("fetchGamePlanRefreshStatus");
    expect(gamePlanPanelSource).toContain("REFRESH FAILED");
    expect(gamePlanPanelSource).toContain("failure_message");
    expect(gamePlanPanelSource).toContain("next_retry_at");
  });
});
