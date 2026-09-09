import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { determineBias } from "../../functions/_shared/gamePlan.ts";

/**
 * `biasConfidence` did not mention the losing side.
 *
 *   confidence = Math.round((bearishVotes / maxPossible) * 100)
 *
 * So 7 bearish against 0 bullish and 7 bearish against 4 bullish both reported
 * 64%. One is unanimous; the other is very nearly a coin flip.
 *
 * Measured 2026-09-09: 9 of the 15 pending orders placed since 09-08 were
 * cancelled by gp_bias_reversal, every one citing exactly `New York:bearish:64`
 * — 7/11 — and the number could not say which of those two situations produced
 * it. Both consumers key off it: the entry gate blocks at >= 50
 * (bot-scanner gamePlanGateMinConfidence) and gp_bias_reversal cancels at >= 60
 * (DEFAULT_GP_BIAS_MIN_CONFIDENCE).
 *
 * The vote weights are D1 3, 4H 2, premium/discount 2, AMD 2, DOL 1, regime 1
 * — 11 total.
 */

const NO_DOL = null;
const neutralRegime = { regime: "trending", directionalBias: "neutral", confidence: 50 };
const noAmd = { phase: "accumulation", bias: null };

/** Bearish D1 (3) + bearish 4H (2) + premium (2) = 7 bearish, nothing bullish. */
const unanimous = () =>
  determineBias("bearish", "bearish", "premium", 75, noAmd, NO_DOL, neutralRegime);

/** The same 7 bearish, but AMD (2), DOL (1) and regime (1) all point up. */
const contested = () =>
  determineBias(
    "bearish", "bearish", "premium", 75,
    { phase: "distribution", bias: "bullish" },
    { price: 1.1, type: "buy-side", description: "BSL", distancePips: 40, strength: 3 },
    { regime: "trending", directionalBias: "bullish", confidence: 60 },
  );

Deno.test("the two reads that used to be indistinguishable no longer are", () => {
  const a = unanimous();
  const b = contested();

  assertEquals(a.votes, { bullish: 0, bearish: 7, max: 11 });
  assertEquals(b.votes, { bullish: 4, bearish: 7, max: 11 });

  // The old formula: winner / max, identical for both.
  assertEquals(Math.round((a.votes.bearish / a.votes.max) * 100), 64);
  assertEquals(Math.round((b.votes.bearish / b.votes.max) * 100), 64);

  // The margin separates them.
  assertEquals(a.confidence, 64, "an unopposed 7 keeps its value");
  assertEquals(b.confidence, 27, "7 against 4 is not the same claim");
  assert(a.confidence > b.confidence);
});

Deno.test("a contested read now falls below both live thresholds", () => {
  // This is the behavioural change. 64% cleared the entry gate (>=50) and
  // gp_bias_reversal (>=60); 27% clears neither, so a 7-4 split stops both
  // blocking entries and cancelling armed orders.
  const b = contested();
  assert(b.confidence < 50, "entry gate no longer blocks on a near-tie");
  assert(b.confidence < 60, "gp_bias_reversal no longer cancels on one");
  // And a clean read still clears both, so neither gate is disabled.
  assert(unanimous().confidence >= 60);
});

Deno.test("direction still follows the majority, not the margin", () => {
  assertEquals(unanimous().bias, "bearish");
  assertEquals(contested().bias, "bearish", "7 beats 4 — only the confidence changed");
  const bullish = determineBias("bullish", "bullish", "discount", 25, noAmd, NO_DOL, neutralRegime);
  assertEquals(bullish.bias, "bullish");
  assertEquals(bullish.confidence, 64, "and it is symmetric");
});

Deno.test("a tie is neutral at zero, not half credit", () => {
  // Bearish D1 (3) against bullish AMD (2) + DOL (1) = 3 vs 3.
  // The old branch gave ((3+3)/11)*50 = 27% on a verdict with no lean at all.
  const tied = determineBias(
    "bearish", "ranging", "equilibrium", 50,
    { phase: "distribution", bias: "bullish" },
    { price: 1.1, type: "buy-side", description: "BSL", distancePips: 40, strength: 3 },
    neutralRegime,
  );
  assertEquals(tied.votes, { bullish: 3, bearish: 3, max: 11 });
  assertEquals(tied.bias, "neutral");
  assertEquals(tied.confidence, 0);
});

Deno.test("no votes at all is neutral at zero", () => {
  const none = determineBias("ranging", "ranging", "equilibrium", 50, noAmd, NO_DOL, neutralRegime);
  assertEquals(none.votes, { bullish: 0, bearish: 0, max: 11 });
  assertEquals(none.bias, "neutral");
  assertEquals(none.confidence, 0);
});

Deno.test("thin but unopposed reads rank alongside heavy contested ones", () => {
  // D1 alone: 3 bearish, nothing else. Weak grounds to act on, and the margin
  // says so — the same 27% as the 7-4 split, which is the intended equivalence.
  const thin = determineBias("bearish", "ranging", "equilibrium", 50, noAmd, NO_DOL, neutralRegime);
  assertEquals(thin.votes, { bullish: 0, bearish: 3, max: 11 });
  assertEquals(thin.confidence, 27);
  assertEquals(contested().confidence, 27);
});

Deno.test("a unanimous plan can still reach 100", () => {
  const all = determineBias(
    "bearish", "bearish", "premium", 75,
    { phase: "distribution", bias: "bearish" },
    { price: 1.0, type: "sell-side", description: "SSL", distancePips: 40, strength: 3 },
    { regime: "trending", directionalBias: "bearish", confidence: 80 },
  );
  assertEquals(all.votes, { bullish: 0, bearish: 11, max: 11 });
  assertEquals(all.confidence, 100);
});

Deno.test("the tally is carried onto the plan so the scalar stays auditable", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/gamePlan.ts", import.meta.url),
  );
  assert(/^    biasVotes: votes,$/m.test(src), "the plan must carry the votes it was derived from");
  assert(
    /const confidence = Math\.round\(\(margin \/ maxPossible\) \* 100\);/.test(src),
    "confidence must be the margin",
  );
  assert(
    !/confidence = Math\.round\(\(bearishVotes \/ maxPossible\) \* 100\)/.test(src),
    "the winner-over-max formula must be gone, not merely bypassed",
  );
});
