import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The gate-effectiveness alert must read one population.
 *
 * It fires a Telegram warning when >50% of resolved rejections would have won,
 * on a 7-day rolling window with a 10-sample minimum. That threshold was
 * calibrated on confluence rejections, whose stop and target come from actual
 * scoring.
 *
 * direction_blocked rows do not. No setup was scored for them, so their levels
 * are synthetic — a 1.5x ATR stop and a 2R target. Their win rate answers a
 * different question, and averaging the two produces a number that describes
 * neither. It would also be the kind of alert that looks like a finding.
 */

const src = Deno.readTextFileSync(
  new URL("../../functions/outcome-tracker/index.ts", import.meta.url),
);
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

Deno.test("the alert reads confluence rejections only", () => {
  // Anchored on code, not on the "Step 3" comment — the strip above removes
  // comments, and an empty slice makes a negative assertion pass vacuously.
  const block = code.slice(
    code.indexOf("const sevenDaysAgo"),
    code.lastIndexOf("MIN_SAMPLES_FOR_ALERT"),
  );
  assert(block.length > 0, "found the alert query");
  assert(/\.in\("rejection_type", \["gate_blocked", "below_threshold_strong_t1"\]\)/.test(block),
    "synthetic-level rows are excluded from the winner-block rate");
});

Deno.test("grading itself still covers every type", () => {
  // Only the ALERT is scoped. direction_blocked rows must still be graded, or
  // the measurement they exist for never resolves.
  const grading = code.slice(
    code.indexOf("const cutoff = new Date(Date.now() - MIN_AGE_MS)"),
    code.indexOf("const sevenDaysAgo"),
  );
  assert(grading.length > 0, "found the grading query");
  assert(/\.eq\("outcome_status", "pending"\)/.test(grading), "grading selects pending rows");
  assert(!/rejection_type/.test(grading), "and does not filter by type");
});
