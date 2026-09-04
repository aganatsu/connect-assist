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

const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);

Deno.test("both keys live in the LIVE config mapper, not bot-scanner", () => {
  // The original version of this test asserted the mapping existed in
  // bot-scanner — and passed, while the feature was dead. bot-scanner's
  // `merged` block sits inside _legacyLoadConfigMapping, which nothing calls.
  // The live path is loadConfig -> mapNestedToFlat in _shared/configMapper.ts,
  // whose header says: "DO NOT duplicate this mapping logic elsewhere."
  //
  // A key mapped only in the dead path never reaches pairConfig, so the read
  // site falls back to its default forever and the UI control does nothing.
  for (const key of ["gamePlanGateMode", "gamePlanGateMinConfidence"]) {
    assert(
      new RegExp(`${key}: .*RUNTIME_DEFAULTS\\.${key}`).test(mapper),
      `${key} must be mapped in configMapper.mapNestedToFlat or it cannot be set`,
    );
    assert(
      new RegExp(`^  ${key}:`, "m").test(mapper),
      `${key} must have a RUNTIME_DEFAULTS entry`,
    );
  }
});

Deno.test("the dead legacy mapper is not where config gets added", () => {
  // Guard against the same mistake recurring. _legacyLoadConfigMapping is
  // uncalled; anything added there is invisible at runtime.
  assert(
    /function _legacyLoadConfigMapping/.test(scanner),
    "legacy mapper marker missing — if it was deleted, delete this test too",
  );
  for (const key of ["gamePlanGateMode", "gamePlanGateMinConfidence"]) {
    assert(
      !new RegExp(`${key}: (raw|strategy)\\.`).test(scanner),
      `${key} must not be re-added to bot-scanner's dead mapping`,
    );
  }
});

Deno.test("bot-scanner DEFAULTS mirrors RUNTIME_DEFAULTS for these keys", () => {
  // bot-scanner's DEFAULTS no longer resolves config, but the STYLE_OVERRIDES
  // loop still compares against it to decide "did the user set this?". If the
  // two objects disagree, that detection misfires silently.
  for (const key of ["gamePlanGateMode", "gamePlanGateMinConfidence"]) {
    const a = scanner.match(new RegExp(`^  ${key}: (.+?),`, "m"));
    const b = mapper.match(new RegExp(`^  ${key}: (.+?),`, "m"));
    assert(a && b, `${key} missing from one of the defaults objects`);
    assert(
      a[1].trim() === b[1].trim(),
      `${key} default differs — scanner has ${a[1]}, mapper has ${b[1]}`,
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
