import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  estimateDirectionConfidence,
  validatePendingOrderThesis,
} from "../../functions/_shared/thesisValidator.ts";
import type { DirectionResult } from "../../functions/_shared/directionEngine.ts";

/**
 * Thesis validation cancelled 202 of 645 pending-order cancellations in 60 days
 * — 101 direction_flip, 101 gp_bias_reversal — and could not be switched off:
 * bot-scanner reads `thesisValidationEnabled !== false`, but the key was absent
 * from RUNTIME_DEFAULTS and from the mapper, and the mapper returns an explicit
 * object so unknown keys do not pass through. It resolved to `undefined`
 * forever.
 *
 * Auditing before wiring the switch turned up three deeper problems:
 *
 * 1. THE VALIDATOR USED A DIFFERENT ENGINE THAN THE CREATOR. Signals are made
 *    by determineDirectionStyleAware on the style's timeframes (scalper:
 *    1H/15m/5m) with dirConfig. Validation used determineDirection(daily, h4,
 *    h1) with NO config. So `direction_flip` could mean "a different method, on
 *    timeframes this style never uses, disagrees" — true from the moment the
 *    order was armed, with nothing having moved.
 *
 * 2. priceAwareStructureBlocks WAS IGNORED. No config was passed, so it
 *    defaulted off and the validator could cancel using exactly the blocking
 *    behaviour that flag exists to disable. The user has it ON.
 *
 * 3. THE GAME PLAN LOOKUP WAS A TIME LOTTERY. The caller searched the last 20
 *    scan_logs rows for `type: "game_plan"`. Plans regenerate roughly every 4
 *    hours; scans write a row every cycle. The plan was therefore visible only
 *    briefly after being written, so the check fired on scan timing rather than
 *    on bias reversing.
 *
 * And the rule itself is one already deleted elsewhere: the staged-setup path
 * used to kill any setup whose direction reversed, removed as self-defeating
 * because reaching a demand zone requires the fall that reads bearish. Same
 * rule, still live for pending orders.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);

const order = { order_id: "o1", symbol: "EUR/USD", direction: "long" as const, entry_price: 1.1 };

/** A direction result opposing a long, confident enough to cancel. */
function opposingShort(): DirectionResult {
  return {
    direction: "short", bias: "bearish", biasSource: "test",
    h4Retrace: true, h4ChochAgainst: false, h1Confirmed: true,
    reason: "test",
  } as DirectionResult;
}

Deno.test("the confidence score is four weights, and h1Confirmed alone cancels", () => {
  // 0.3 base + 0.3 h1Confirmed + 0.2 h4Retrace + 0.2 !h4ChochAgainst, threshold 0.6.
  // Documenting it because nothing calibrates these against outcomes, and the
  // absence of a counter-CHoCH counting as positive evidence is a choice, not
  // a measurement.
  const only = { direction: "short", h4Retrace: false, h4ChochAgainst: true, h1Confirmed: true } as DirectionResult;
  assertEquals(Math.round(estimateDirectionConfidence(only) * 100) / 100, 0.6);
  assert(estimateDirectionConfidence(only) >= 0.6, "lands exactly on the cancel threshold");

  const noneOf = { direction: "short", h4Retrace: false, h4ChochAgainst: true, h1Confirmed: false } as DirectionResult;
  assertEquals(Math.round(estimateDirectionConfidence(noneOf) * 100) / 100, 0.3);
});

Deno.test("every check is recorded, including ones that are switched off", () => {
  const res = validatePendingOrderThesis(order, {
    fotsiResult: null, lastGamePlan: null,
    dailyCandles: null, h4Candles: null, h1Candles: null,
  });
  assertEquals(res.valid, true);
  const types = res.checks.map(c => c.type).sort();
  assertEquals(types, ["direction_flip", "fotsi_veto", "gp_bias_reversal"]);
  // With no data, all three must report that they did not run — rather than
  // silently being absent, which is indistinguishable from "passed".
  assertEquals(res.checks.every(c => c.ran === false), true);
});

Deno.test("a disabled check still runs and records, it just cannot cancel", () => {
  // This is what makes the firing rate measurable before anything is switched
  // off for real.
  const plan = {
    session: "london", generatedAt: "", focusPairs: [], newsEvents: [], summary: "",
    plans: [{ symbol: "EUR/USD", bias: "bearish", biasConfidence: 90 }],
  } as never;

  const acting = validatePendingOrderThesis(order, {
    fotsiResult: null, lastGamePlan: plan,
    dailyCandles: null, h4Candles: null, h1Candles: null,
  });
  assertEquals(acting.valid, false);
  assertEquals(acting.checkType, "gp_bias_reversal");

  const observing = validatePendingOrderThesis(order, {
    fotsiResult: null, lastGamePlan: plan,
    dailyCandles: null, h4Candles: null, h1Candles: null,
    enabledChecks: { gp_bias_reversal: false },
  });
  assertEquals(observing.valid, true, "disabled must not cancel");
  const gp = observing.checks.find(c => c.type === "gp_bias_reversal")!;
  assertEquals(gp.wouldInvalidate, true, "but it must still say it would have");
  assertEquals(gp.enabled, false);
  assertEquals(gp.ran, true);
});

Deno.test("a below-threshold check records that it ran and declined", () => {
  const plan = {
    session: "london", generatedAt: "", focusPairs: [], newsEvents: [], summary: "",
    plans: [{ symbol: "EUR/USD", bias: "bearish", biasConfidence: 40 }],
  } as never;
  const res = validatePendingOrderThesis(order, {
    fotsiResult: null, lastGamePlan: plan,
    dailyCandles: null, h4Candles: null, h1Candles: null,
  });
  assertEquals(res.valid, true);
  const gp = res.checks.find(c => c.type === "gp_bias_reversal")!;
  assertEquals(gp.ran, true);
  assertEquals(gp.wouldInvalidate, false);
  assert(gp.reason?.includes("40%"), "the near-miss should be legible");
});

Deno.test("the master switch and per-check switches are in the live mapper", () => {
  for (const k of [
    "thesisValidationEnabled",
    "thesisCheckDirectionFlip",
    "thesisCheckFotsiVeto",
    "thesisCheckGpBiasReversal",
    "thesisDirectionStyleAware",
  ]) {
    assert(new RegExp(`^  ${k}: (true|false),`, "m").test(mapper), `${k} missing from RUNTIME_DEFAULTS`);
    assert(
      new RegExp(`${k}: strategy\\.${k} \\?\\? raw\\.${k} \\?\\? RUNTIME_DEFAULTS\\.${k}`).test(mapper),
      `${k} not mapped`,
    );
    const a = scanner.match(new RegExp(`^  ${k}: (true|false),`, "m"));
    const b = mapper.match(new RegExp(`^  ${k}: (true|false),`, "m"));
    assert(a && b, `${k} missing from one defaults object`);
    assertEquals(a[1], b[1], `${k} defaults disagree`);
  }
});

Deno.test("the three checks default on, style-aware defaults off", () => {
  // Turning the gate off is a policy choice the user now CAN make; changing
  // which engine validates is a correctness fix that still moves trade
  // selection, so it ships inert.
  assert(/^  thesisValidationEnabled: true,/m.test(mapper));
  assert(/^  thesisCheckDirectionFlip: true,/m.test(mapper));
  assert(/^  thesisDirectionStyleAware: false,/m.test(mapper));
});

Deno.test("the game plan is fetched by type, not by a 20-row window", () => {
  const i = scanner.indexOf("_lastGamePlanForValidation");
  const block = scanner.slice(i, scanner.indexOf("const gpLog", i) + 200);
  assert(
    /\.contains\("details_json", \{ type: "game_plan" \}\)/.test(block),
    "must filter by type the way the other game-plan reader does",
  );
  assert(!/\.limit\(20\)/.test(block), "the arbitrary window must be gone");
});

Deno.test("the validator is handed the config the scanner uses", () => {
  // Passing nothing is what let it cancel using the blocking behaviour
  // priceAwareStructureBlocks exists to switch off.
  assert(
    /priceAwareStructureBlocks: \(config as any\)\.priceAwareStructureBlocks === true/.test(scanner),
    "dirConfig must carry the flag",
  );
  assert(/styleAwareDirection: thesisStyleAware/.test(scanner));
  assert(/style: resolvedStyle/.test(scanner));
});

Deno.test("the style-aware path costs one extra fetch, not three", () => {
  // Scalper needs 1H/15m/5m. 1H is already fetched for the legacy path and the
  // entry-TF series is already in hand, so only 15m is new.
  const i = scanner.indexOf("if (thesisStyleAware || !opts?.isManagementOnly) {");
  assert(i > -1, "the shadow-candles branch was not found");
  const block = scanner.slice(i, i + 800);
  assert(/cachedFetch\(pending\.symbol, "15m", "5d"\)/.test(block), "scalper adds 15m");
  assert(/confirm: pendingCandles/.test(block), "and reuses the candles already fetched");
  assert(/bias: tvH1/.test(block), "and the 1H already fetched above");
});

Deno.test("observations reach scan detail", () => {
  assert(/thesisObservations\.push\(/.test(scanner), "each order's checks must be recorded");
  assert(/^      thesisObservations,$/m.test(scanner), "and surfaced in the scan meta");
  const i = scanner.indexOf("thesisObservations.push(");
  const block = scanner.slice(i, i + 300);
  assert(/acted: !thesisResult\.valid/.test(block), "record whether it actually cancelled");
  assert(/checks: thesisResult\.checks/.test(block), "and every check's verdict");
});

// ── Engine disagreement, the number that decides fix-vs-delete ──────────────
//
// wouldInvalidate alone cannot settle it: the orders the check cancelled never
// got outcomes, so a high count and a low count are both consistent with the
// check being right or being noise. Disagreement between the two engines IS
// decisive — agreement means it detects a real directional change, persistent
// disagreement means it was measuring the mismatch between the engine that
// created the order and the one that judged it.

Deno.test("both engines are judged, and the loser is recorded as alternate", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/thesisValidator.ts", import.meta.url),
  );
  assert(/const styleJudged = judge\(runStyleAware\(\)\)/.test(src), "style-aware must always be judged");
  assert(/const legacyJudged = judge\(runLegacy\(\)\)/.test(src), "legacy must always be judged");
  assert(
    /const primary = styleAware \? \(styleJudged \?\? legacyJudged\) : \(legacyJudged \?\? styleJudged\)/.test(src),
    "the flag picks which one DECIDES",
  );
  assert(
    /const other = styleAware \? legacyJudged : styleJudged/.test(src),
    "and the other is kept for the record",
  );
});

Deno.test("the alternate names which engine it came from", () => {
  // Otherwise a disagreement count cannot be attributed to a direction.
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/thesisValidator.ts", import.meta.url),
  );
  assert(/engine: \(styleAware \? "legacy" : "style_aware"\)/.test(src));
  assert(/wouldInvalidate: other\.wouldInvalidate/.test(src), "its verdict must be comparable");
});

Deno.test("either engine's data is enough to attempt the check", () => {
  // The first draft gated canRunDirection on whichever engine the flag chose,
  // so with the flag off the style-aware verdict would never have been recorded
  // and the disagreement rate would have stayed unmeasurable.
  const src = Deno.readTextFileSync(
    new URL("../../functions/_shared/thesisValidator.ts", import.meta.url),
  );
  assert(
    /canRunDirection = enough\(opts\.dailyCandles\) \|\| enough\(opts\.h4Candles\)\s*\n\s*\|\| enough\(opts\.styleCandles\?\.bias\) \|\| enough\(opts\.styleCandles\?\.structure\)/.test(src),
    "must attempt if EITHER engine has data",
  );
});

Deno.test("the shadow engine is free on full scans, skipped on management runs", () => {
  // The 15m series is already in scanCache after the pair loop. On a
  // management-only cycle it is not, and that cycle runs every minute.
  assert(
    /if \(thesisStyleAware \|\| !opts\?\.isManagementOnly\) \{/.test(scanner),
    "shadow candles on full scans, or whenever the flag genuinely needs them",
  );
});
