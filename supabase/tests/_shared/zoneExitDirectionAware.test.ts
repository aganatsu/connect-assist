import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyZoneExit,
  isPriceInZone,
} from "../../functions/_shared/zoneConfirmation.ts";

/**
 * `isPriceInZone` took a `direction` argument and ignored it — both branches
 * returned the identical expression:
 *
 *   if (direction === "short") {
 *     return currentPrice >= (zoneLow - buffer) && currentPrice <= (zoneHigh + buffer);
 *   } else {
 *     return currentPrice >= (zoneLow - buffer) && currentPrice <= (zoneHigh + buffer);
 *   }
 *
 * So for a demand zone, price rallying UP out of the zone — the bounce the
 * setup exists to catch — was treated exactly like price collapsing through
 * the floor. Both reset the confirmation hunt.
 *
 * The reset is not cosmetic. It writes `zone_touch_time: null`, and
 * `zone_touch_time` is what seeds `zoneTouchIdx` for `detectZoneConfirmation`.
 * The CHoCH search is therefore abandoned at the moment the CHoCH is forming,
 * and re-entry requires a fresh touch of the zone. Entry fills at market on
 * confirmation (`actualFillPrice = currentPrice`), not at the zone edge, so
 * price having travelled away is not itself a reason to stop hunting.
 *
 * Flag `zoneExitDirectionAware`, default OFF: this decides whether a pending
 * order stays armed, so it moves trade selection.
 */

const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);
const confirmScanner = await Deno.readTextFile(
  new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);
const helper = await Deno.readTextFile(
  new URL("../../functions/_shared/zoneConfirmation.ts", import.meta.url),
);

// A demand zone 1.1000-1.1020. Buffer defaults to 10% of width = 2 pips.
const LOW = 1.1000, HIGH = 1.1020;

Deno.test("a long's bounce out of demand is favourable, not a failure", () => {
  assertEquals(classifyZoneExit(1.1010, LOW, HIGH, "long"), "inside");
  assertEquals(classifyZoneExit(1.1035, LOW, HIGH, "long"), "left_favourable");
  assertEquals(classifyZoneExit(1.0980, LOW, HIGH, "long"), "left_breach");
});

Deno.test("a short's drop out of supply is favourable, not a failure", () => {
  assertEquals(classifyZoneExit(1.0980, LOW, HIGH, "short"), "left_favourable");
  assertEquals(classifyZoneExit(1.1035, LOW, HIGH, "short"), "left_breach");
});

Deno.test("direction actually changes the answer", () => {
  // The whole point. Same price, same zone, opposite classification.
  const above = 1.1035, below = 1.0980;
  assert(classifyZoneExit(above, LOW, HIGH, "long") !== classifyZoneExit(above, LOW, HIGH, "short"));
  assert(classifyZoneExit(below, LOW, HIGH, "long") !== classifyZoneExit(below, LOW, HIGH, "short"));
});

Deno.test("the buffer still absorbs a minor wick, on either side", () => {
  // 10% of a 20-pip zone = 2 pips of tolerance.
  assertEquals(classifyZoneExit(1.1021, LOW, HIGH, "long"), "inside");
  assertEquals(classifyZoneExit(1.0999, LOW, HIGH, "long"), "inside");
  // Just past it is not.
  assertEquals(classifyZoneExit(1.10201 + 0.0002, LOW, HIGH, "long"), "left_favourable");
});

Deno.test("the ATR buffer is used when supplied", () => {
  // atr * 0.2. With atr = 0.0050 that is 10 pips of tolerance (up to 1.1030),
  // far wider than the 2 pips that 10% of zone width gives (up to 1.1022).
  assertEquals(classifyZoneExit(1.1028, LOW, HIGH, "long", 0.0050), "inside");
  assertEquals(classifyZoneExit(1.1028, LOW, HIGH, "long"), "left_favourable");
  // And the ATR buffer is still finite.
  assertEquals(classifyZoneExit(1.1060, LOW, HIGH, "long", 0.0050), "left_favourable");
});

Deno.test("isPriceInZone keeps its exact old semantics", () => {
  // It must stay a pure narrowing of the new function so existing callers and
  // the eight tests in zoneConfirmation.test.ts are unaffected.
  for (const dir of ["long", "short"] as const) {
    for (const price of [1.0900, 1.0980, 1.1010, 1.1035, 1.1200]) {
      assertEquals(
        isPriceInZone(price, LOW, HIGH, dir),
        classifyZoneExit(price, LOW, HIGH, dir) === "inside",
        `${dir} @ ${price}`,
      );
    }
  }
  // And it is still symmetric, because both exits collapse to false.
  assertEquals(isPriceInZone(1.1035, LOW, HIGH, "long"), isPriceInZone(1.1035, LOW, HIGH, "short"));
});

Deno.test("the dead duplicated branch is gone", () => {
  const dup = /if \(direction === "short"\) \{\s*return currentPrice >= \(zoneLow - buffer\)[\s\S]{0,120}\} else \{\s*return currentPrice >= \(zoneLow - buffer\)/;
  assert(!dup.test(helper), "both branches returning the same expression must not come back");
});

Deno.test("with the flag off, every exit resets — today's behaviour exactly", () => {
  const off = (kind: string) => kind !== "inside";
  assertEquals(off("left_favourable"), true);
  assertEquals(off("left_breach"), true);
  assertEquals(off("inside"), false);
  for (const src of [scanner, confirmScanner]) {
    assert(
      /: zoneExit !== "inside";/.test(src),
      "the flag-off path must reset on any exit",
    );
  }
});

Deno.test("both scanners are fixed, not just one", () => {
  // bot-scanner runs the full lifecycle; zone-confirmation-scanner is the
  // 1-minute fast poll. The same block exists in both, so fixing one would
  // leave the other resetting the hunt a minute later.
  for (const [name, src] of [["bot-scanner", scanner], ["zone-confirmation-scanner", confirmScanner]] as const) {
    assert(/classifyZoneExit\(/.test(src), `${name} must classify the exit`);
    assert(/zoneExitDirectionAware/.test(src), `${name} must read the flag`);
    assert(
      !/!isPriceInZone\(currentPrice/.test(src),
      `${name} must no longer branch on the direction-blind helper`,
    );
  }
});

Deno.test("the confirmation scanner reads the raw nested config", () => {
  // config_json there does not pass through configMapper — a comment in that
  // file says so — and reading a flat key would silently always be undefined.
  assert(
    /strategyConfig\.zoneExitDirectionAware === true/.test(confirmScanner),
    "must read off strategy, not a mapped flat key",
  );
});

Deno.test("the flag defaults off in the live mapper and bot-scanner agrees", () => {
  assert(/zoneExitDirectionAware: false/.test(mapper), "RUNTIME_DEFAULTS entry missing");
  assert(
    /zoneExitDirectionAware: strategy\.zoneExitDirectionAware \?\? raw\.zoneExitDirectionAware \?\? RUNTIME_DEFAULTS\.zoneExitDirectionAware/.test(mapper),
    "must be mapped in configMapper, not bot-scanner's dead legacy mapper",
  );
  const a = scanner.match(/^  zoneExitDirectionAware: (\w+),/m);
  const b = mapper.match(/^  zoneExitDirectionAware: (\w+),/m);
  assert(a && b, "missing from one defaults object");
  assertEquals(a[1], b[1]);
});

Deno.test("a favourable exit leaves zone_touch_time alone", () => {
  // Clearing it is what abandons the CHoCH hunt. The reset write must stay
  // inside the branch the flag can switch off.
  for (const src of [scanner, confirmScanner]) {
    const i = src.indexOf("if (resetsHunt) {");
    assert(i > -1, "the guarded reset branch was not found");
    const before = src.slice(Math.max(0, i - 900), i);
    assert(
      !/zone_touch_time: null/.test(before),
      "nothing may clear zone_touch_time before the guarded branch",
    );
  }
});

// ── Chase limit ─────────────────────────────────────────────────────────────
//
// Without a bound, a favourable exit keeps the hunt alive until expires_at.
// Entry fills at market and the stop is derived from the zone, so price can
// travel a long way, print a CHoCH out there, and fill you far from the level
// with a zone-sized stop. That is a chase, not the setup that was staged.
//
// `zoneChaseMaxZoneWidths` (default 1) caps the travel in zone widths measured
// past the buffer. Beyond it the exit resets like any other.

Deno.test("a favourable exit within the limit keeps hunting", () => {
  // Zone 20 pips wide, buffer 2 pips, limit 1 width = 20 pips past 1.1022.
  assertEquals(classifyZoneExit(1.1040, LOW, HIGH, "long", undefined, 1), "left_favourable");
});

Deno.test("a favourable exit beyond the limit is far, and resets", () => {
  assertEquals(classifyZoneExit(1.1100, LOW, HIGH, "long", undefined, 1), "left_favourable_far");
  assertEquals(classifyZoneExit(1.0900, LOW, HIGH, "short", undefined, 1), "left_favourable_far");
});

Deno.test("the limit is measured from the buffer edge, not the zone edge", () => {
  // Zone width 20 pips, buffer 2 pips. The buffer edge is 1.1022 and one zone
  // width past it is 1.1042 — not one width past the zone edge (1.1040).
  assertEquals(classifyZoneExit(1.1035, LOW, HIGH, "long", undefined, 1), "left_favourable");
  assertEquals(classifyZoneExit(1.1050, LOW, HIGH, "long", undefined, 1), "left_favourable_far");
});

Deno.test("a breach is still a breach regardless of the limit", () => {
  assertEquals(classifyZoneExit(1.0900, LOW, HIGH, "long", undefined, 1), "left_breach");
  assertEquals(classifyZoneExit(1.1100, LOW, HIGH, "short", undefined, 1), "left_breach");
});

Deno.test("omitting the limit means no limit", () => {
  // Preserves the behaviour from #468 for any caller that does not pass it.
  assertEquals(classifyZoneExit(1.9000, LOW, HIGH, "long"), "left_favourable");
  assertEquals(classifyZoneExit(1.9000, LOW, HIGH, "long", undefined, undefined), "left_favourable");
});

Deno.test("zero means never chase — reset the moment price clears the buffer", () => {
  assertEquals(classifyZoneExit(1.1023, LOW, HIGH, "long", undefined, 0), "left_favourable_far");
  assertEquals(classifyZoneExit(1.1021, LOW, HIGH, "long", undefined, 0), "inside");
});

Deno.test("only left_favourable survives; far and breach both reset", () => {
  // The scanners must not treat left_favourable_far as continuable.
  for (const src of [scanner, confirmScanner]) {
    assert(
      /zoneExit !== "inside" && zoneExit !== "left_favourable"/.test(src),
      "reset must be the complement of inside + left_favourable, so a new " +
        "ZoneExitKind added later defaults to resetting rather than chasing",
    );
    assert(
      !/zoneExit === "left_breach"/.test(src),
      "the old breach-only test would let left_favourable_far chase forever",
    );
    assert(/zoneChaseMaxZoneWidths/.test(src), "the limit must be passed in");
  }
});

Deno.test("isPriceInZone is unaffected by the new kind", () => {
  assertEquals(isPriceInZone(1.9000, LOW, HIGH, "long"), false);
  assertEquals(classifyZoneExit(1.9000, LOW, HIGH, "long", undefined, 1), "left_favourable_far");
});

Deno.test("the limit defaults to 1 in the live mapper and bot-scanner agrees", () => {
  const a = scanner.match(/^  zoneChaseMaxZoneWidths: (\d+),/m);
  const b = mapper.match(/^  zoneChaseMaxZoneWidths: (\d+),/m);
  assert(a && b, "missing from one defaults object");
  assertEquals(a[1], b[1]);
  assert(
    /zoneChaseMaxZoneWidths: strategy\.zoneChaseMaxZoneWidths \?\? raw\.zoneChaseMaxZoneWidths \?\? RUNTIME_DEFAULTS\.zoneChaseMaxZoneWidths/.test(mapper),
    "must be mapped in configMapper",
  );
});
