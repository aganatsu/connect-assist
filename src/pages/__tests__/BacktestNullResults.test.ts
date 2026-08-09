import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("src/pages/Backtest.tsx", "utf8");

describe("Backtest sparse result rendering", () => {
  it("does not call toFixed directly on serialized result statistics", () => {
    expect(source).not.toContain("results.stats.profitFactor.toFixed");
    expect(source).not.toContain("results.stats.sharpeRatio.toFixed");
    expect(source).not.toContain("results.stats.avgRR.toFixed");
    expect(source).toContain("profitFactorLabel(results.stats.profitFactor");
    expect(source).toContain("fixedResult(results.stats.sharpeRatio");
  });

  it("treats JSON-null profit factor as infinity only for wins without losses", () => {
    expect(source).toContain('wins > 0 && losses === 0 ? "∞" : "—"');
  });
});
