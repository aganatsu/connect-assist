import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

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
});
