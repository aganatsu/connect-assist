import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { filterTradeByGamePlan } from "../../functions/_shared/gamePlan.ts";

/**
 * The Game Plan filter gate was converted to info-only by the Phase 7 migration
 * on the grounds that GP Bias Confidence scoring would carry the load. It has
 * been a no-op ever since, including through the 2026-09-01 revert.
 *
 * Measured 2026-09-03. Of the 14 trades closed that day, the 7 where GP opposed
 * the direction netted -1,698 with ZERO reaching take profit; the other 7 netted
 * +1,125. Across Era B in R terms the opposed group ran -0.559R per trade
 * against +0.775R for the rest. The scoring penalty that replaced the gate is
 * -0.19 at 55% confidence against a 40% threshold — far too small to act on any
 * of that.
 *
 * The confidence floor matters as much as the gate itself, because
 * filterTradeByGamePlan rejects ANY misalignment regardless of confidence.
 * Simulated over Era B:
 *
 *   no gate            kept 17   +2.50R
 *   any confidence     kept  6   +5.14R   <- discards a +2.00R win at 45% conf
 *   conf >= 50         kept  9   +6.98R
 *   conf >= 60         kept 15   +4.50R
 *
 * 50 is not fitted: it is the threshold gamePlanBiasAdjustment already uses
 * before applying any penalty at all.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

function plan(symbol: string, bias: string, conf: number, tradeable = true) {
  return {
    session: "London",
    generatedAt: "2026-09-03T00:00:00Z",
    plans: [{
      symbol, bias, biasConfidence: conf, tradeable,
      skipReason: tradeable ? "" : "low volatility",
    }],
    focusPairs: [], newsEvents: [], summary: "",
  } as any;
}

Deno.test("the filter distinguishes misalignment from an un-tradeable instrument", () => {
  // Both return allowed:false. A gate acting on one must not act on the other,
  // and there is no outcome data on skip-flagged instruments.
  const mis = filterTradeByGamePlan(plan("XAU/USD", "bullish", 55), "XAU/USD", "short");
  assertEquals(mis.allowed, false);
  assertEquals(mis.reasonCode, "misaligned");

  const skip = filterTradeByGamePlan(plan("XAU/USD", "bullish", 55, false), "XAU/USD", "long");
  assertEquals(skip.allowed, false);
  assertEquals(skip.reasonCode, "not_tradeable");
});

Deno.test("aligned, neutral and absent plans are all reported distinctly", () => {
  assertEquals(
    filterTradeByGamePlan(plan("XAU/USD", "bullish", 73), "XAU/USD", "long").reasonCode,
    "aligned",
  );
  assertEquals(
    filterTradeByGamePlan(plan("XAU/USD", "neutral", 40), "XAU/USD", "long").reasonCode,
    "neutral_bias",
  );
  assertEquals(
    filterTradeByGamePlan(null, "XAU/USD", "long").reasonCode,
    "no_plan",
  );
  assertEquals(
    filterTradeByGamePlan(plan("EUR/USD", "bullish", 73), "XAU/USD", "long").reasonCode,
    "no_plan",
  );
});

Deno.test("confidence is carried through so the gate can threshold on it", () => {
  for (const c of [36, 45, 55, 64, 73]) {
    assertEquals(
      filterTradeByGamePlan(plan("XAU/USD", "bullish", c), "XAU/USD", "short").biasConfidence,
      c,
    );
  }
});

Deno.test("the gate only blocks misalignment, never a skip flag", () => {
  assert(
    /blockable\s*=\s*gpFilter\.reasonCode === "misaligned"/.test(scanner),
    "the gate must key on reasonCode misaligned — not_tradeable has no outcome " +
      "data behind it and must stay advisory",
  );
});

Deno.test("the gate honours a confidence floor", () => {
  assert(
    /biasConf >= gpMinConf/.test(scanner),
    "blocking must require the bias confidence to clear the threshold — a " +
      "confidence-blind veto discards the low-confidence disagreements, which " +
      "over Era B cost a +2.00R winner at 45%",
  );
});

Deno.test("the default mode leaves behaviour unchanged", () => {
  assert(
    /gamePlanGateMode:\s*"soft"/.test(scanner),
    "default must be soft so merging this changes nothing until it is chosen",
  );
  assert(
    /gamePlanGateMinConfidence:\s*50/.test(scanner),
    "default confidence floor should be 50, matching gamePlanBiasAdjustment",
  );
  assert(
    /gamePlanGateMode\s*\?\?\s*"soft"/.test(scanner),
    "the read site must also fall back to soft when the key is absent",
  );
});

Deno.test("both new keys are mapped into the merged config", () => {
  // merged = { ...DEFAULTS, ...explicit mappings }. An unmapped key can never be
  // set from the DB — it keeps its default forever, which is the state
  // gamePlanEnabled and gamePlanRefreshHours are currently in.
  for (const key of ["gamePlanGateMode", "gamePlanGateMinConfidence"]) {
    assert(
      new RegExp(`${key}: raw\\.${key} \\?\\?`).test(scanner),
      `${key} must be mapped from raw config or it cannot be set from the UI`,
    );
  }
});

Deno.test("hard mode blocks, other modes do not", () => {
  const block = scanner.match(/gpGateMode === "hard" && blockable/);
  assert(block, "hard mode must be the only mode that sets passed:false");
  const idx = scanner.indexOf('gpGateMode === "hard" && blockable');
  const after = scanner.slice(idx, idx + 300);
  assert(
    /passed:\s*false/.test(after),
    "the hard-mode branch must record a failed gate",
  );
});
