import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { StagedSetupCard } from "./WatchlistPanel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { StagedSetup } from "@/lib/api";

const source = fs.readFileSync(path.resolve(process.cwd(), "src/components/WatchlistPanel.tsx"), "utf8");

describe("Watchlist lifecycle language", () => {
  it("shows lifecycle authority before legacy diagnostics", () => {
    expect(source).toContain("Frozen lifecycle authority");
    expect(source).toContain("Frozen zone");
    expect(source).toContain("Invalidation");
    expect(source).toContain("Show legacy diagnostics");
    expect(source).toContain("diagnostics only; does not authorize entry");
    expect(source).toContain("near zone");
    expect(source).not.toContain("near gate");
    expect(source).not.toContain("Watch: {setup.watch_threshold}%");
    expect(source).not.toContain("T1: {setup.tier1_count}/4");
    expect(source).not.toContain("generateWatchlistNarrative(setup)");
  });

  it("does not turn missing staged prices into zero-valued trading levels", () => {
    const setup = {
      id: "monitoring-1",
      user_id: "user-1",
      bot_id: "smc",
      symbol: "EUR/USD",
      direction: "long",
      initial_score: 20,
      current_score: 21,
      watch_threshold: 30,
      initial_factors: [],
      current_factors: [],
      missing_factors: [],
      entry_price: null,
      sl_level: null,
      tp_level: null,
      status: "watching",
      candidate_id: "candidate-1",
      execution_eligible: false,
      scan_cycles: 1,
      min_cycles: 1,
      ttl_minutes: 60,
      promotion_reason: null,
      invalidation_reason: null,
      setup_type: "waiting_for_unified_zone",
      tier1_count: 0,
      tier2_count: 0,
      tier3_count: 0,
      analysis_snapshot: {},
      originating_zone: { low: null, high: null, entry: null },
      lifecycle_phase: "monitoring_pre_zone",
      lifecycle_evidence: null,
      staged_at: new Date().toISOString(),
      last_eval_at: new Date().toISOString(),
      resolved_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } satisfies StagedSetup;

    render(
      <TooltipProvider>
        <StagedSetupCard setup={setup} defaultExpanded />
      </TooltipProvider>,
    );

    expect(screen.queryByText(/0\.00000/)).toBeNull();
    expect(screen.queryByText(/Staged entry\/reference/i)).toBeNull();
    expect(screen.queryByText(/Structural invalidation:/i)).toBeNull();
    expect(screen.queryByText(/Projected target:/i)).toBeNull();
  });
});
