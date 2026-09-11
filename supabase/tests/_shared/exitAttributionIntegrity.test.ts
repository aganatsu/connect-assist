import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Two defects that corrupted the exit record rather than the trading.
 *
 * 1. close_reason lied. paper-trading:946 derived the label from
 *    pos.close_reason, a tag paper-trading sets when IT moves a stop. But
 *    _shared/scannerManagement.ts is the manager that runs — every minute via
 *    manage-positions-1min — and never writes it. So every server-managed exit
 *    read "sl_hit".
 *
 *    Measured 2026-09-10 over Era C: 43 sl_hit rows, 10 PROFITABLE with a max
 *    of +1.12R — impossible unless the stop moved — and zero trail_hit or
 *    be_hit ever recorded. Exit behaviour was invisible for as long as the
 *    data existed, which is why "the trail gives back 0.5R" was believed for
 *    days on no evidence.
 *
 * 2. session_close never stopped firing. scannerManagement's session block was
 *    the only trigger with no "already done" flag. shouldMove compares against
 *    an UNROUNDED beSL while the write stores roundPrice(beSL), so when that
 *    rounds away from the stop the condition stays true forever: 197
 *    attributions across 2 positions, ~98 each, one per minute.
 */

const paper = await Deno.readTextFile(
  new URL("../../functions/paper-trading/index.ts", import.meta.url),
);
const mgmt = await Deno.readTextFile(
  new URL("../../functions/_shared/scannerManagement.ts", import.meta.url),
);

/** The label decision, mirroring paper-trading. */
const label = (flags: Record<string, unknown>, tag: string) =>
  (flags.trailingStopActivated === true || tag === "trail")
    ? "trail_hit"
    : (flags.breakEvenActivated === true || tag === "be")
    ? "be_hit"
    : "sl_hit";

Deno.test("a server-managed exit is no longer labelled sl_hit", () => {
  // scannerManagement sets the exitFlags but never the tag. This is the case
  // that produced 10 profitable "sl_hit" rows.
  assertEquals(label({ trailingStopActivated: true }, ""), "trail_hit");
  assertEquals(label({ breakEvenActivated: true }, ""), "be_hit");
});

Deno.test("paper-trading's own tag still works as a fallback", () => {
  // It sets the tag and not necessarily the flags, so both paths must resolve.
  assertEquals(label({}, "trail"), "trail_hit");
  assertEquals(label({}, "be"), "be_hit");
});

Deno.test("trailing outranks break-even when both fired", () => {
  // Trailing activates after BE and then ratchets, so the stop that was hit is
  // the trail level, not the BE level.
  assertEquals(label({ breakEvenActivated: true, trailingStopActivated: true }, ""), "trail_hit");
  assertEquals(label({ breakEvenActivated: true }, "trail"), "trail_hit");
});

Deno.test("an untouched stop is still sl_hit", () => {
  assertEquals(label({}, ""), "sl_hit");
  assertEquals(label({ trailingStopActivated: false, breakEvenActivated: false }, ""), "sl_hit");
  // Truthy-but-not-true must not count — these flags are written by two
  // different modules and only one of them is type-checked against a schema.
  assertEquals(label({ trailingStopActivated: "yes" }, ""), "sl_hit");
});

Deno.test("the label reads exitFlags, not only the tag", () => {
  const i = paper.indexOf("const slHitReason =");
  assert(i > -1, "the label must still be derived here");
  const block = paper.slice(i, i + 400);
  assert(/exitFlags\.trailingStopActivated === true/.test(block), "must consult the trailing flag");
  assert(/exitFlags\.breakEvenActivated === true/.test(block), "and the break-even flag");
  assert(/slState === "trail"/.test(block), "keeping the tag as a fallback");
});

Deno.test("session_close cannot fire twice on one position", () => {
  const i = mgmt.indexOf("const sessionBEApplied");
  assert(i > -1, "the guard must exist");
  const block = mgmt.slice(i, i + 900);
  assert(/exitFlags\.sessionCloseBEApplied === true/.test(block), "read the flag");
  assert(/!sessionBEApplied\s*\n?\s*&& \(normalizedCurrentSession/.test(block), "and gate the block on it");
  assert(/updatedFlags\.sessionCloseBEApplied = true;/.test(block), "then set it");
  assert(/exitFlagsUpdated = true;/.test(block), "and mark the flags dirty so it persists");
});

Deno.test("the flag is set before the payload that persists it is built", () => {
  // updatedSignalForSession spreads updatedFlags. Setting the flag after that
  // object is constructed would write the old value and the loop would return.
  const set = mgmt.indexOf("updatedFlags.sessionCloseBEApplied = true;");
  const payload = mgmt.indexOf("const updatedSignalForSession", set);
  assert(set > -1 && payload > set, "flag must be set before the payload is built");
});
