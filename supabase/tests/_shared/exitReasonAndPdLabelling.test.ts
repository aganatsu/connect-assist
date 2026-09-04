import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalizeGateReason } from "../../functions/_shared/gatePerformanceEngine.ts";

/**
 * Two labelling defects, both of which produced wrong analysis rather than mere
 * confusion.
 *
 * 1. Trailing exits were recorded as sl_hit.
 *    paper_positions.close_reason doubles as an SL-state tag while a position is
 *    open ("" / "be" / "trail"). paper-trading sets it and reads it back, so its
 *    own closes report trail_hit correctly. bot-scanner's SL/TP breach check
 *    hardcoded "sl_hit" and ignored the tag — and it runs every scan cycle, so
 *    it usually closes the position first.
 *
 *    Measured 2026-09-03: nine trades exited on a trailing stop, six profitable,
 *    and all nine read as stop-outs. BotView already styles trail_hit green with
 *    "(trailing stop locked profit)", so the display was waiting on a value the
 *    writer never produced.
 *
 * 2. "% of range" never said which range.
 *    Four different numbers answer to premium/discount: this gate (last-5 swings
 *    on the entry timeframe), the Tier 1 "Premium/Discount & Fib" factor (zigzag
 *    retracement), the unused htfPDD/htfPD4H/htfPD1H, and the position within
 *    the impulse leg shown by the zone story. On 2026-09-03 one XAU/USD setup
 *    read 100.0%, 60.0% and 73.9% simultaneously — all correct, all differently
 *    defined, impossible to reconcile from the screen.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

Deno.test("the breach check honours the SL-state tag", () => {
  assert(
    /slState === "trail" \? "trail_hit" : slState === "be" \? "be_hit" : "sl_hit"/.test(scanner),
    "bot-scanner's SL breach must map the close_reason tag the same way " +
      "paper-trading does, or trailing exits keep recording as stop-outs",
  );
});

Deno.test("the tag is read from the position, not invented", () => {
  assert(
    /const slState = \(pos\.close_reason \|\| ""\)\.toString\(\)/.test(scanner),
    "slState must come from paper_positions.close_reason",
  );
});

Deno.test("the P/D gate names the timeframe and the range", () => {
  assert(
    /of the \$\{tfLabel\} swing range/.test(scanner),
    'the gate reason must say which range the percentage is measured against',
  );
  assert(
    /entryTimeframe/.test(scanner) && /tfLabel/.test(scanner),
    "the timeframe label should come from the configured entry timeframe",
  );
});

Deno.test("an out-of-range reading is disclosed, not hidden by the clamp", () => {
  // zonePercent is clamped to 0-100, so "100.0%" gives no hint how far outside
  // price actually is. The XAU/USD setup that read 100.0% was above its range.
  assert(
    /price is OUTSIDE that range \(raw /.test(scanner),
    "when outOfRange is true the gate should print the unclamped percentage",
  );
});

Deno.test("changing the reason text did not break gate categorisation", () => {
  // gatePerformanceEngine matches on the leading phrase. If that stops matching,
  // premium/discount rejections silently vanish from the confusion matrix.
  const buy = "Buying in premium zone rejected — price 4486.585 at 100.0% of the 5m swing range 4470.472–4486.585 (premium > 55%, need discount < 45% to buy) — price is OUTSIDE that range (raw 118.4%)";
  const sell = "Selling in discount zone rejected — price 1.0750 at 32.1% of the 15min swing range 1.0700–1.0800 (discount < 45%, need premium > 55% to sell)";
  assert(normalizeGateReason(buy) === "premium_discount", `buy reason normalised to ${normalizeGateReason(buy)}`);
  assert(normalizeGateReason(sell) === "premium_discount", `sell reason normalised to ${normalizeGateReason(sell)}`);
});

Deno.test("the Game Plan gate is categorisable", () => {
  // Added with gamePlanGateMode. Without a pattern its rejections normalise to
  // null, so the one gate with direct evidence behind it would be the one gate
  // the performance engine cannot score.
  const hard = "GP filter (hard): Game plan: short REJECTED — bias is bullish (55%), signal is short — bias confidence 55% >= 50%";
  const soft = "GP filter (soft): Game plan: long REJECTED — bias is bearish (64%), signal is long — handled by GP Bias Confidence scoring";
  assert(normalizeGateReason(hard) === "game_plan", `hard reason normalised to ${normalizeGateReason(hard)}`);
  assert(normalizeGateReason(soft) === "game_plan", `soft reason normalised to ${normalizeGateReason(soft)}`);
});

Deno.test("existing gate categories still resolve", () => {
  // The new pattern is checked in order with the rest; make sure it does not
  // shadow anything that was already matching.
  const cases: Array<[string, string]> = [
    ["Tier 1 gate FAILED: only 0 core factors", "tier1_gate"],
    ["Already long on AUD/USD — no duplicate", "duplicate_position"],
    ["News conflict: strong opposing bias", "news_filter"],
    ["HTF bias mismatch on Daily", "htf_bias"],
  ];
  for (const [reason, expected] of cases) {
    assert(
      normalizeGateReason(reason) === expected,
      `"${reason}" normalised to ${normalizeGateReason(reason)}, expected ${expected}`,
    );
  }
});

const scoring = await Deno.readTextFile(
  new URL("../../functions/_shared/confluenceScoring.ts", import.meta.url),
);

Deno.test("the Tier 1 zone label is not derived from trade direction", () => {
  // It printed "Discount zone" for every long and "Premium zone" for every
  // short, chosen by direction rather than by price position — so it was always
  // flattering and could never disagree with the trade. Observed 2026-09-03: a
  // XAU/USD long read "Discount zone (58.1%)" in the same panel where the gate
  // rejected it for premium at 67.7%.
  assert(
    !/\$\{fibDirection === "long" \? "Discount" : "Premium"\} zone/.test(scoring),
    'the beyond-equilibrium label must not be picked by fibDirection — that ' +
      'restates the trade instead of describing price',
  );
  assert(
    /Beyond equilibrium \(\$\{retrace\.toFixed\(1\)\}% retrace\)/.test(scoring),
    "the label should describe the retracement it actually measured",
  );
});

Deno.test("the beyond-equilibrium score is unchanged", () => {
  // Only the wording moves. If the points change, this stops being a labelling
  // fix and starts moving admission.
  // Anchor on the condition and read forward — reading backwards from the label
  // depends on comment length, which is exactly what changed here.
  const i = scoring.indexOf("retrace > 50 && retrace < 61.8");
  assert(i > -1, "beyond-equilibrium branch not found");
  const branch = scoring.slice(i, scoring.indexOf("retrace >= 23.6", i));
  assert(branch.length > 0, "could not delimit the branch");
  assert(
    /pts = 1\.0;/.test(branch),
    "the beyond-equilibrium branch must still award 1.0pt",
  );
  assert(
    /Beyond equilibrium \(/.test(branch),
    "the new label must be inside this branch, not somewhere else",
  );
});
