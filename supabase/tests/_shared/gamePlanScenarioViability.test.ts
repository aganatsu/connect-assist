/**
 * gamePlanScenarioViability.test.ts — plans must not propose untradeable setups.
 *
 * A scenario names an entry and a target. The instrument imposes a minimum stop
 * (MIN_SL_PIPS), so the smallest legal risk is fixed — which means a target
 * closer than `minStop x minRR` can never be traded at an acceptable
 * reward-to-risk, however good the analysis behind it is.
 *
 * Observed live on GBP/AUD (2026-08-10). The plan read perfectly — 11/11 bias
 * votes, 100% support, 100% plan coherence — and its headline scenario was:
 *
 *     entry   1.91324  (Bullish FVG 1.91267-1.91381)
 *     target  1.91538  (previous day high)
 *     reward  21.4 pips
 *
 * GBP/AUD's minimum stop is 30 pips, so the best achievable ratio was 0.71:1.
 * The execution layer was always going to reject it, while the plan presented
 * it as the primary setup.
 *
 * Scenarios are annotated rather than removed: a human reading the plan should
 * still see the idea, it just must not look tradeable when it is not.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { generateInstrumentGamePlan } from "../../functions/_shared/gamePlan.ts";
import { MIN_SL_PIPS } from "../../functions/_shared/smcAnalysis.ts";

Deno.test("GBP/AUD minimum stop is 30 pips (anchors the live case)", () => {
  assertEquals(MIN_SL_PIPS["GBP/AUD"], 30);
});

/**
 * Mirror of the viability rule in gamePlan.annotateScenarioViability. Kept in
 * lockstep with the source by the guard test at the bottom.
 */
function isViable(input: {
  symbol: string;
  entry: number;
  target: number;
  pipSize: number;
  minRR?: number;
}): { rewardPips: number; requiredPips: number; viable: boolean } {
  const minStop = MIN_SL_PIPS[input.symbol] ?? 15;
  const minRR = input.minRR ?? 1.5;
  const rewardPips = Math.abs(input.target - input.entry) / input.pipSize;
  const requiredPips = minStop * minRR;
  return { rewardPips, requiredPips, viable: rewardPips >= requiredPips };
}

Deno.test("the live GBP/AUD scenario is flagged unviable", () => {
  const r = isViable({
    symbol: "GBP/AUD",
    entry: 1.91324,
    target: 1.91538,
    pipSize: 0.0001,
  });
  assertEquals(Math.round(r.rewardPips * 10) / 10, 21.4);
  assertEquals(r.requiredPips, 45); // 30 x 1.5
  assertEquals(r.viable, false, "21.4 pips cannot clear a 30-pip minimum stop");
});

Deno.test("the sweep-and-reclaim scenario on the same plan IS viable", () => {
  // Scenario 2 targeted 1.92125 from the Asian low at 1.90751.
  const r = isViable({
    symbol: "GBP/AUD",
    entry: 1.90751,
    target: 1.92125,
    pipSize: 0.0001,
  });
  assert(r.rewardPips > 130, `expected a wide target, got ${r.rewardPips}`);
  assertEquals(r.viable, true);
});

Deno.test("viability scales with the instrument, not a fixed pip count", () => {
  // 40 pips of reward: fine on EUR/GBP (min stop 15), not on GBP/NZD (30).
  const eurgbp = isViable({ symbol: "EUR/GBP", entry: 0.8500, target: 0.8540, pipSize: 0.0001 });
  const gbpnzd = isViable({ symbol: "GBP/NZD", entry: 2.1000, target: 2.1040, pipSize: 0.0001 });
  assertEquals(eurgbp.viable, true, "40 pips clears 15 x 1.5 = 22.5");
  assertEquals(gbpnzd.viable, false, "40 pips does not clear 30 x 1.5 = 45");
});

Deno.test("JPY pip size is handled", () => {
  // USD/JPY min stop 25 → needs 37.5 pips. 0.400 = 40 pips at 0.01 pip size.
  const r = isViable({ symbol: "USD/JPY", entry: 155.000, target: 155.400, pipSize: 0.01 });
  assertEquals(Math.round(r.rewardPips), 40);
  assertEquals(r.viable, true);
});

Deno.test("generated scenarios carry entryLevel and viability annotations", () => {
  // Minimal synthetic series — enough bars for the generator to run.
  const bars = Array.from({ length: 60 }, (_, i) => {
    const base = 1.9000 + i * 0.0004;
    return {
      datetime: new Date(Date.UTC(2026, 7, 1, i)).toISOString(),
      open: base, high: base + 0.0020, low: base - 0.0020, close: base + 0.0010,
      volume: 100,
    };
  });

  const plan = generateInstrumentGamePlan(
    "GBP/AUD", bars, bars, bars, bars, "London",
  );

  assert(Array.isArray(plan.scenarios), "plan must expose scenarios");
  for (const s of plan.scenarios) {
    // Every scenario must report the instrument floor it was judged against.
    assertEquals(
      s.minStopPips, 30,
      "each scenario should record GBP/AUD's 30-pip minimum stop",
    );
    if (s.targetLevel != null && s.entryLevel != null) {
      assertEquals(
        typeof s.viable, "boolean",
        "a scenario with both an entry and a target must be judged viable or not",
      );
      if (s.viable === false) {
        assert(
          (s.viabilityNote || "").includes("Not tradeable as written"),
          "an unviable scenario must explain why",
        );
      }
    }
  }
});

Deno.test("source guard: viability is applied to generated scenarios", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/gamePlan.ts", import.meta.url),
  );
  assert(
    src.includes("function annotateScenarioViability("),
    "the viability helper must exist",
  );
  assert(
    /return annotateScenarioViability\(scenarios, symbol, pipSize\);/.test(src),
    "generateScenarios must annotate before returning, or plans go out unchecked",
  );
  assert(
    src.includes("MIN_SL_PIPS[symbol]"),
    "viability must be judged against the instrument's own floor",
  );
});
