import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("readable overflow wiring", () => {
  it("uses expandable text for diagnostic and evidence content", () => {
    for (
      const path of [
        "src/pages/OperationsDashboard.tsx",
        "src/components/StopPolicyEvidenceCard.tsx",
        "src/components/GamePlanPanel.tsx",
        "src/components/WatchlistPanel.tsx",
        "src/components/SignalReasoningCard.tsx",
        "src/components/ChartContextPanel.tsx",
        "src/components/RecommendationsDashboard.tsx",
        "src/pages/RejectedSetups.tsx",
        "src/pages/PropFirm.tsx",
        "src/pages/Fundamentals.tsx",
        "src/pages/ScheduledTasks.tsx",
        "src/pages/Index.tsx",
        "src/pages/Settings.tsx",
        "src/pages/Backtest.tsx",
        "src/pages/Journal.tsx",
      ]
    ) {
      expect(read(path), path).toContain("OverflowText");
    }
  });

  it("lets shared page headings and operational event details wrap", () => {
    const workspaceCss = read("src/styles/workspace-page.css");
    const operationsCss = read("src/styles/operations-dashboard.css");

    expect(workspaceCss).toContain("overflow-wrap: anywhere");
    expect(operationsCss).toContain(
      ".apex-event p span { color: var(--ink-soft);",
    );
    expect(operationsCss).not.toContain(
      ".apex-event p span { overflow: hidden;",
    );
  });
});
