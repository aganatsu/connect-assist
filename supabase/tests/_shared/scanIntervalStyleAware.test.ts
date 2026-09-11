import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The scan-interval gate read `config.scanIntervalMinutes` directly, and
 * STYLE_OVERRIDES runs FORTY LINES BELOW it. So the gate always saw the
 * pre-style value.
 *
 * Observed 2026-09-11: swing_trader declares `scanIntervalMinutes: 60` and the
 * bot scanned every 15 — the mapper default — because the style had not been
 * applied yet when the gate ran. Four times more often than the style intends,
 * against Daily structure that changes far more slowly, and multiplying
 * provider calls on a credit budget already seen refusing 200-440 fetches per
 * cycle.
 *
 * Same shape as the other findings this week: a setting that is declared,
 * looks correct everywhere you'd read it, and never reaches the decision.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

/** Resolution, mirroring the scanner. */
const resolve = (styleValue: number | undefined, configValue: number | undefined) =>
  styleValue ?? configValue ?? 15;

Deno.test("the style value wins, because it is not user-protected", () => {
  // STYLE_OVERRIDES applies non-protected fields unconditionally, so the gate
  // must use the same value the loop is about to set.
  assertEquals(resolve(60, 5), 60, "swing overrides an explicit 5");
  assertEquals(resolve(5, undefined), 5, "scalper");
  assertEquals(resolve(15, undefined), 15, "day_trader");
});

Deno.test("a style with no declared interval falls through to config", () => {
  assertEquals(resolve(undefined, 30), 30);
  assertEquals(resolve(undefined, undefined), 15, "and finally the default");
});

Deno.test("zero no longer collapses to the default", () => {
  // The old expression was `config.scanIntervalMinutes || 15`, so a deliberate
  // 0 — scan every cycle — silently became 15. `??` preserves it.
  assertEquals(resolve(undefined, 0), 0);
});

Deno.test("the gate resolves the style before reading the interval", () => {
  const gate = scanner.indexOf("const intervalMinutes =");
  const styleLoop = scanner.indexOf("if (STYLE_OVERRIDES[resolvedStyle]) {");
  assert(gate > -1 && styleLoop > gate, "the loop still runs after the gate — that is why this fix exists");
  assert(
    /const intervalMinutes = \(STYLE_OVERRIDES as any\)\[_intervalStyle\]\?\.scanIntervalMinutes\s*\n\s*\?\? config\.scanIntervalMinutes \?\? 15;/
      .test(scanner),
    "the gate must consult STYLE_OVERRIDES itself",
  );
  assert(
    !/const intervalMinutes = config\.scanIntervalMinutes \|\| 15;/.test(scanner),
    "the pre-style read must be gone",
  );
});

Deno.test("the style is resolved the same way in both places", () => {
  // Two different fallbacks would put the gate on one style and the loop on
  // another.
  assert(
    /const _intervalStyle = config\.tradingStyle\?\.mode \|\| "day_trader";/.test(scanner),
    "gate's style resolution",
  );
  assert(
    /const resolvedStyle = config\.tradingStyle\?\.mode \|\| "day_trader";/.test(scanner),
    "loop's style resolution — must match",
  );
});

Deno.test("the declared intervals are what the styles actually say", () => {
  const block = scanner.slice(
    scanner.indexOf("const STYLE_OVERRIDES"),
    scanner.indexOf("day_trader: {", scanner.indexOf("const STYLE_OVERRIDES")) + 2000,
  );
  assert(/scalper: \{\s*\n\s*scanIntervalMinutes: 5,/.test(block), "scalper 5");
  assert(/day_trader: \{\s*\n\s*scanIntervalMinutes: 15,/.test(block), "day_trader 15");
  assert(/swing_trader: \{\s*\n\s*scanIntervalMinutes: 60,/.test(scanner), "swing_trader 60");
});
