import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The R:R Ratio (TP Target) input must be reachable in the config UI whatever
 * the Take Profit Method is set to.
 *
 * bot-scanner recomputes TP as entry ± risk × tpRatio after the structural stop
 * is chosen, and again each time the SL floor widens the stop — overwriting
 * whatever calculateSLTP produced. So this ratio sets the take profit on every
 * trade, not only when the method happens to read "rr_ratio".
 *
 * It used to be rendered behind `takeProfitMethod === "rr_ratio"`. A config
 * carrying an unrecognised method, "fib_extension_3pt", therefore hid the field
 * while tpRRRatio sat at 1. Fourteen trades were placed at 1:1 into a 13% win
 * rate, and the value could only be changed with SQL.
 */
const src = readFileSync(
  resolve(__dirname, "..", "BotConfigModal.tsx"),
  "utf8",
);

/** The JSX region that renders the tpRRRatio input, plus its lead-in. */
function tpRatioRegion(): string {
  const at = src.indexOf("'exit', 'tpRRRatio'");
  expect(at, "tpRRRatio input not found in BotConfigModal").toBeGreaterThan(-1);
  return src.slice(Math.max(0, at - 1200), at + 200);
}

describe("R:R Ratio (TP Target) field", () => {
  it("is not gated on takeProfitMethod", () => {
    const region = tpRatioRegion();
    // A conditional immediately wrapping this input is the regression: any
    // `takeProfitMethod === "..." && (` between the label and the input hides it.
    const labelAt = region.indexOf("R:R Ratio (TP Target)");
    expect(labelAt, "label not found next to the input").toBeGreaterThan(-1);
    const wrapper = region.slice(0, labelAt);
    const lastConditional = wrapper.lastIndexOf("takeProfitMethod ===");
    const lastFieldGroupEnd = wrapper.lastIndexOf(")}");
    expect(
      lastConditional === -1 || lastConditional < lastFieldGroupEnd,
      "the tpRRRatio FieldGroup must not sit inside a takeProfitMethod conditional — " +
        "tpRatio governs TP for every method",
    ).toBe(true);
  });

  it("still writes exit.tpRRRatio, the field the scanner reads first", () => {
    // configMapper resolves: exit.tpRRRatio ?? risk.defaultRR ?? risk.minRiskReward ?? ...
    // Writing anywhere else would be shadowed by a stale tpRRRatio.
    expect(src).toMatch(/updateField\('exit',\s*'tpRRRatio'/);
  });

  it("tells the user it applies to every TP method", () => {
    const region = tpRatioRegion();
    expect(region).toMatch(/every TP method/i);
  });

  it("warns that Min R:R must sit below the target", () => {
    // Setting both to the same value rejects every setup: raw R:R equals the
    // floor, then spread and commission drag effective R:R under it.
    const region = tpRatioRegion();
    expect(region).toMatch(/keep it below/i);
  });
});
