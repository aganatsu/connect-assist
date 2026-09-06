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
      /zoneExitAware \? zoneExit === "left_breach" : zoneExit !== "inside"/.test(src),
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
