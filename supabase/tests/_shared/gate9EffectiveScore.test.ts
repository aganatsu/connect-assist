/**
 * gate9EffectiveScore.test.ts — Gate 9 must judge the score eligibility judged.
 *
 * Gate 9 (bot-scanner runSafetyGates) tested the RAW score against the BASE
 * threshold, while the eligibility check that gates it tested the ADJUSTED score
 * against the ADJUSTED threshold:
 *
 *   bot-scanner:7495   effectiveScore >= conflictAdjustedMinConfluence   ← lets it in
 *   Gate 9             analysis.score  <  config.minConfluence           ← throws it out
 *
 * Several of the adjustments are positive (verdict bonus, killzone prime bonus,
 * impulse-zone credit), so a setup could clear eligibility on its credited score
 * and then be rejected on the uncredited one. Because runSafetyGates is only
 * ever called inside that eligibility check, every Gate 9 rejection was a false
 * rejection.
 *
 * Measured against live `rejected_setups` data on 2026-08-10: 10 of 10 sampled
 * Gate 9 rejections had an effective score at or above the threshold, with
 * credits of +1.79 to +2.20 (avg +1.97). backtest-engine has no equivalent gate,
 * so this also broke live/backtest parity — the strategy was tuned without it.
 *
 * These tests pin the gate's decision rule. They exercise the same comparison
 * runSafetyGates performs rather than importing the 11k-line scanner module.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Gate 9's decision rule, mirroring bot-scanner/index.ts runSafetyGates.
 * Kept in lockstep with the source by gate9UsesEffectiveOperands below.
 */
function gate9(input: {
  rawScore: number;
  baseThreshold: number;
  effectiveScore?: number;
  effectiveMinConfluence?: number;
}): { passed: boolean; reason: string } {
  const scoreForGate = typeof input.effectiveScore === "number" ? input.effectiveScore : input.rawScore;
  const thresholdForGate = typeof input.effectiveMinConfluence === "number"
    ? input.effectiveMinConfluence
    : input.baseThreshold;
  return scoreForGate < thresholdForGate
    ? { passed: false, reason: `Score ${scoreForGate.toFixed(1)} < ${thresholdForGate} threshold` }
    : { passed: true, reason: `Score ${scoreForGate.toFixed(1)} meets threshold ${thresholdForGate}` };
}

/**
 * Real rejections pulled from rejected_setups on 2026-08-10. Every one of these
 * was blocked by Gate 9 despite its effective score clearing the threshold.
 */
const LIVE_FALSE_REJECTIONS = [
  { at: "2026-08-03T23:25:25Z", symbol: "GBP/USD", raw: 28.6, threshold: 30, effective: 30.50 },
  { at: "2026-08-03T20:05:43Z", symbol: "GBP/USD", raw: 28.1, threshold: 30, effective: 30.30 },
  { at: "2026-08-03T13:11:03Z", symbol: "BTC/USD", raw: 28.4, threshold: 30, effective: 30.48 },
  { at: "2026-08-01T22:40:17Z", symbol: "BTC/USD", raw: 39.6, threshold: 40, effective: 41.71 },
  { at: "2026-07-31T15:25:23Z", symbol: "USD/CAD", raw: 38.4, threshold: 40, effective: 40.19 },
  { at: "2026-07-31T14:25:18Z", symbol: "USD/CAD", raw: 38.9, threshold: 40, effective: 40.69 },
];

Deno.test("Gate 9 — every recorded live false rejection now passes", () => {
  for (const c of LIVE_FALSE_REJECTIONS) {
    const before = gate9({ rawScore: c.raw, baseThreshold: c.threshold });
    const after = gate9({
      rawScore: c.raw,
      baseThreshold: c.threshold,
      effectiveScore: c.effective,
      effectiveMinConfluence: c.threshold,
    });
    assertEquals(before.passed, false, `${c.symbol} ${c.at}: should have been rejected by the old rule`);
    assertEquals(after.passed, true, `${c.symbol} ${c.at}: raw ${c.raw} / effective ${c.effective} vs ${c.threshold} must now pass`);
  }
});

Deno.test("Gate 9 — a genuinely weak setup is still rejected", () => {
  // Credits applied, still short of the bar.
  const d = gate9({ rawScore: 20, baseThreshold: 40, effectiveScore: 22, effectiveMinConfluence: 40 });
  assertEquals(d.passed, false);
  assert(d.reason.includes("22.0 < 40"));
});

Deno.test("Gate 9 — a negative adjustment can still fail a setup whose raw score passed", () => {
  // FOTSI penalty pushes a nominally-passing setup below the bar. The gate must
  // follow the adjustment down as well as up.
  const d = gate9({ rawScore: 41, baseThreshold: 40, effectiveScore: 39, effectiveMinConfluence: 40 });
  assertEquals(d.passed, false);
});

Deno.test("Gate 9 — honours a conflict-raised threshold", () => {
  // conflictAdjustedMinConfluence = base + 10 when enough factors oppose.
  const raised = gate9({ rawScore: 45, baseThreshold: 40, effectiveScore: 45, effectiveMinConfluence: 50 });
  assertEquals(raised.passed, false, "must respect the raised bar, not the base one");

  const normal = gate9({ rawScore: 45, baseThreshold: 40, effectiveScore: 45, effectiveMinConfluence: 40 });
  assertEquals(normal.passed, true);
});

Deno.test("Gate 9 — exactly at the threshold passes", () => {
  assertEquals(gate9({ rawScore: 30, baseThreshold: 40, effectiveScore: 40, effectiveMinConfluence: 40 }).passed, true);
});

Deno.test("Gate 9 — falls back to legacy operands when the caller omits the effective pair", () => {
  const d = gate9({ rawScore: 28.6, baseThreshold: 30 });
  assertEquals(d.passed, false);
  assert(d.reason.includes("28.6 < 30"));
});

Deno.test("Gate 9 — source uses the effective operands, not analysis.score", () => {
  // Guards against the gate silently reverting to the raw comparison.
  const src = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url),
  );
  const gateBlock = src.slice(
    src.indexOf("// Gate 9: Min confluence"),
    src.indexOf("// Gate 9b:"),
  );
  assert(gateBlock.length > 0, "Gate 9 block not found — did the banner change?");
  assert(
    gateBlock.includes("effectiveScore") && gateBlock.includes("effectiveMinConfluence"),
    "Gate 9 must compare the effective score and threshold",
  );
  assert(
    !/if\s*\(analysis\.score\s*<\s*config\.minConfluence\)/.test(gateBlock),
    "Gate 9 reverted to comparing the raw score against the base threshold",
  );
  // And the call site must actually supply them.
  assert(
    /propFirmGateResult\?\.enabled \|\| false,\s*\n\s*effectiveScore,\s*\n\s*conflictAdjustedMinConfluence,/.test(src),
    "runSafetyGates call site must pass effectiveScore and conflictAdjustedMinConfluence",
  );
});
