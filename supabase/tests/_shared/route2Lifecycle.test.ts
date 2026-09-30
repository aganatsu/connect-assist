/**
 * ROUTE 2 CONFIRMATION LIFECYCLE V2 — regression suite.
 *
 * Both defects were proven on forward order b64d4d7b (NZD/CAD short,
 * 2026-09-29) and both are reproduced here as literal cases, so a
 * regression fails on the exact scenario rather than on an abstraction.
 */

import { assertEquals, assert, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ROUTE2_LIFECYCLE_VERSION, classifyTouch, touchId, touchExtreme, barReachesEntry,
  confirmTfMinutes, confirmationMinObservationUntil, withinMinObservation,
  RESET_SEVERITY, resetSeverity, mayResetNow,
} from "../../functions/_shared/route2Lifecycle.ts";

const SCANNER = Deno.readTextFileSync(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url));
const ZCS = Deno.readTextFileSync(
  new URL("../../functions/zone-confirmation-scanner/index.ts", import.meta.url));
const MIGRATION = Deno.readTextFileSync(
  new URL("../../migrations/20260930020000_route2_lifecycle_v2.sql", import.meta.url));

// The real numbers from b64d4d7b.
const B = {
  entry: 0.80129,
  bar: "2026-09-29T21:45:00.000Z",
  touchHigh: 0.80157,   // the 21:48 spike, retained by the forming bar
  laterHigh: 0.80157,   // still the bar's high at 21:51 — nothing new happened
};

// ─── A/B. a stale forming-bar extreme cannot re-arm ─────────────────────────

Deno.test("A · a stale forming-bar HIGH cannot re-arm a short", () => {
  // 21:51 on b64d4d7b: the bar high is still the 21:48 spike, and the 1m
  // tape showed highs of 0.80117 / 0.80076 / 0.80051 since — 7.8 pips short
  // of the entry. The old code armed anyway.
  assertEquals(classifyTouch({
    direction: "short", entryPrice: B.entry, barTime: B.bar,
    barHigh: B.laterHigh, barLow: 0.80033,
    lastConsumedBarTime: B.bar, lastConsumedExtreme: B.touchHigh,
  }), "ALREADY_CONSUMED_TOUCH");
});

Deno.test("B · a stale forming-bar LOW cannot re-arm a long", () => {
  assertEquals(classifyTouch({
    direction: "long", entryPrice: 1.1000, barTime: B.bar,
    barHigh: 1.1050, barLow: 1.0990,
    lastConsumedBarTime: B.bar, lastConsumedExtreme: 1.0990,
  }), "ALREADY_CONSUMED_TOUCH");
});

// ─── C. a genuine new crossing may re-arm ───────────────────────────────────

Deno.test("C · a genuine NEW crossing in the same bar MAY re-arm", () => {
  // The bar extends strictly beyond where it stood when the touch was
  // consumed — explicit evidence of a second crossing, not the same spike.
  assertEquals(classifyTouch({
    direction: "short", entryPrice: B.entry, barTime: B.bar,
    barHigh: 0.80180, barLow: 0.80033,
    lastConsumedBarTime: B.bar, lastConsumedExtreme: B.touchHigh,
  }), "NEW_CROSS_AFTER_RESET");
  // long: the low must extend strictly lower
  assertEquals(classifyTouch({
    direction: "long", entryPrice: 1.1000, barTime: B.bar,
    barHigh: 1.1050, barLow: 1.0985,
    lastConsumedBarTime: B.bar, lastConsumedExtreme: 1.0990,
  }), "NEW_CROSS_AFTER_RESET");
});

Deno.test("a NEW bar with a genuine touch arms normally", () => {
  assertEquals(classifyTouch({
    direction: "short", entryPrice: B.entry, barTime: "2026-09-29T22:00:00.000Z",
    barHigh: 0.80140, barLow: 0.80100,
    lastConsumedBarTime: B.bar, lastConsumedExtreme: B.touchHigh,
  }), "NEW_TOUCH");
  // and a first-ever touch, with no consumed state
  assertEquals(classifyTouch({
    direction: "short", entryPrice: B.entry, barTime: B.bar,
    barHigh: B.touchHigh, barLow: 0.80033,
    lastConsumedBarTime: null, lastConsumedExtreme: null,
  }), "NEW_TOUCH");
});

Deno.test("a bar that never reaches the entry is not a touch at all", () => {
  assertEquals(classifyTouch({
    direction: "short", entryPrice: B.entry, barTime: B.bar,
    barHigh: 0.80051, barLow: 0.80030,      // the real 21:51 1m high
    lastConsumedBarTime: null, lastConsumedExtreme: null,
  }), null);
  assertEquals(barReachesEntry("short", 0.80051, 0.80030, B.entry), false);
  assertEquals(barReachesEntry("short", 0.80157, 0.80033, B.entry), true);
  assertEquals(barReachesEntry("long", 1.1050, 1.0990, 1.1000), true);
  assertEquals(touchExtreme("short", 1.2, 1.0), 1.2);
  assertEquals(touchExtreme("long", 1.2, 1.0), 1.0);
});

Deno.test("touch ids are stable and distinguish arms", () => {
  assertEquals(touchId("abc", B.bar, 1), `abc:${B.bar}:1`);
  assert(touchId("abc", B.bar, 1) !== touchId("abc", B.bar, 2));
  assert(touchId("abc", B.bar, 1) !== touchId("abc", "2026-09-29T22:00:00.000Z", 1));
  assertEquals(touchId("abc", null, 0), "abc:nobar:0");
});

// ─── D/E. ordinary departures cannot pre-empt the first confirm close ───────

Deno.test("D · left_breach before the first confirm close does NOT terminate", () => {
  // Hunt 1 on b64d4d7b: armed 21:50:01, killed by left_breach at 21:50:04
  // after 3.4 seconds. A close-based CHoCH needs a closed 5m bar.
  const armed = "2026-09-29T21:50:01.217Z";
  const until = confirmationMinObservationUntil(armed, "5m");
  assertEquals(until, "2026-09-29T22:00:00.000Z");
  const g = mayResetNow("left_breach", "2026-09-29T21:50:04.644Z", until);
  assertEquals(g.allowed, false);
  assertEquals(g.deferred, true);
  assertEquals(g.severity, "ORDINARY");
});

Deno.test("E · left_favourable_far before the first confirm close does NOT terminate", () => {
  // Hunt 2: killed at 60.0 s by left_favourable_far.
  const until = confirmationMinObservationUntil("2026-09-29T21:51:01.094Z", "5m");
  const g = mayResetNow("left_favourable_far", "2026-09-29T21:52:01.139Z", until);
  assertEquals(g.allowed, false);
  assertEquals(g.deferred, true);
});

// ─── F. hard invalidations still fire immediately ───────────────────────────

Deno.test("F · HARD invalidations terminate immediately, even mid-window", () => {
  const until = "2026-09-29T22:00:00.000Z";
  const mid = "2026-09-29T21:50:04.644Z";
  for (const r of ["sl_invalidation", "impulse_broken", "direction_flip",
    "thesis_invalid", "refined_zone_close_through", "ttl_expiry", "superseded"]) {
    const g = mayResetNow(r, mid, until);
    assertEquals(g.allowed, true, `${r} must still be able to terminate`);
    assertEquals(g.severity, "HARD");
    assertEquals(g.deferred, false);
  }
});

Deno.test("an UNKNOWN reset reason fails safe — it is allowed to terminate", () => {
  // Suppressing a kill we do not understand would be the dangerous default.
  assertEquals(resetSeverity("something_new"), "HARD");
  assertEquals(mayResetNow("something_new", "2026-09-29T21:50:04Z", "2026-09-29T22:00:00Z").allowed, true);
});

Deno.test("the severity table is explicit and complete for every reason in use", () => {
  // Reclassifying an entry here is a documented behaviour change, not a tweak.
  assertEquals(RESET_SEVERITY.left_breach, "ORDINARY");
  assertEquals(RESET_SEVERITY.left_favourable_far, "ORDINARY");
  assertEquals(RESET_SEVERITY.left_favourable, "ORDINARY");
  assertEquals(RESET_SEVERITY.zone_exit, "ORDINARY");
  assertEquals(RESET_SEVERITY.sl_invalidation, "HARD");
  assertEquals(RESET_SEVERITY.impulse_broken, "HARD");
  assertEquals(RESET_SEVERITY.refined_zone_close_through, "HARD");
  // every classifyZoneExit output must be classified
  for (const k of ["inside", "left_favourable", "left_favourable_far", "left_breach"]) {
    if (k === "inside") continue;
    assert(k in RESET_SEVERITY, `classifyZoneExit can emit ${k} — it must be in the table`);
  }
});

// ─── G. normal behaviour resumes after the window ───────────────────────────

Deno.test("G · after the first eligible confirm close, normal resets resume", () => {
  const until = "2026-09-29T22:00:00.000Z";
  for (const r of ["left_breach", "left_favourable_far"]) {
    assertEquals(mayResetNow(r, "2026-09-29T22:00:00.000Z", until).allowed, true, `${r} at the boundary`);
    assertEquals(mayResetNow(r, "2026-09-29T22:00:00.001Z", until).allowed, true, `${r} after`);
    assertEquals(mayResetNow(r, "2026-09-29T21:59:59.999Z", until).allowed, false, `${r} just before`);
  }
  // and with no window recorded at all, nothing is deferred
  assertEquals(mayResetNow("left_breach", "2026-09-29T21:50:00Z", null).allowed, true);
  assertEquals(withinMinObservation("2026-09-29T21:50:00Z", null), false);
});

Deno.test("the window is one WHOLE confirm candle after the touch, per timeframe", () => {
  // The bar containing the touch opened before it, so a CHoCH inside it
  // could predate the event. The first bar that opens at/after the touch is
  // the first causal opportunity.
  assertEquals(confirmationMinObservationUntil("2026-09-29T21:48:00.000Z", "5m"), "2026-09-29T21:55:00.000Z");
  assertEquals(confirmationMinObservationUntil("2026-09-29T21:48:30.000Z", "15m"), "2026-09-29T22:15:00.000Z");
  assertEquals(confirmationMinObservationUntil("2026-09-29T21:48:30.000Z", "1h"), "2026-09-29T23:00:00.000Z");
  // exactly on a boundary: that bar opens now, so it closes one period later
  assertEquals(confirmationMinObservationUntil("2026-09-29T21:50:00.000Z", "5m"), "2026-09-29T21:55:00.000Z");
  assertEquals(confirmTfMinutes("5m"), 5);
  assertEquals(confirmTfMinutes("15m"), 15);
  assertEquals(confirmTfMinutes("1h"), 60);
  assertEquals(confirmTfMinutes("garbage"), 5);
  assertThrows(() => confirmationMinObservationUntil("not-a-time", "5m"));
});

// ─── H. both pollers decide identically ─────────────────────────────────────

Deno.test("H · both pollers use the SAME shared lifecycle decisions", () => {
  // The oscillation was bot-scanner arming on a bar aggregate while
  // zone-confirmation-scanner reset on instantaneous price. Neither may own
  // a private copy of the rule.
  for (const [name, src] of [["bot-scanner", SCANNER], ["zone-confirm", ZCS]] as const) {
    assert(/from "\.\.\/_shared\/route2Lifecycle\.ts"/.test(src), `${name} must import the shared module`);
    assert(/mayResetNow\(zoneExit, pollAt,/.test(src), `${name} must gate resets through mayResetNow`);
    assert(/reset_deferred_min_window/.test(src), `${name} must record a deferred reset`);
    assert(!/RESET_SEVERITY\s*=/.test(src), `${name} must not define its own severity table`);
  }
  // The arm gate lives only in bot-scanner (only it runs Branch A), and it
  // must consult classifyTouch rather than the raw bar-state boolean.
  assert(/classifyTouch\(\{/.test(SCANNER), "bot-scanner must classify the touch");
  assert(/touchVerdict === "ALREADY_CONSUMED_TOUCH"/.test(SCANNER), "and refuse a consumed one");
  assert(/rearm_suppressed_stale_bar/.test(SCANNER), "and record the suppression");
  assert(!/classifyTouch/.test(ZCS), "zone-confirm does not arm, so it must not classify touches");
});

Deno.test("the consumed-touch marker survives a reset", () => {
  // Clearing it on reset would restore the original defect exactly: the same
  // bar would look fresh again on the very next poll.
  for (const [name, src] of [["bot-scanner", SCANNER], ["zone-confirm", ZCS]] as const) {
    const i = src.indexOf('status: "pending",\n');
    assert(i > -1, `${name}: reset write not found`);
    const block = src.slice(i, i + 900).replace(/\/\/.*$/gm, "");
    assert(!/last_touch_bar_time/.test(block),
      `${name}: the reset must NOT clear last_touch_bar_time`);
    assert(!/last_consumed_touch_extreme/.test(block),
      `${name}: the reset must NOT clear last_consumed_touch_extreme`);
  }
});

// ─── I/J. the window and the TTL are independent ────────────────────────────

Deno.test("I · refresh-in-place does not touch the confirmation window", () => {
  // Anchor on the UPDATE itself, not on the comment above it — a slice that
  // starts mid-comment keeps prose that the line-based stripper cannot see.
  const anchor = SCANNER.indexOf("expires_at is DELIBERATELY NOT REFRESHED");
  const i = SCANNER.indexOf('from("pending_orders").update(', anchor);
  const code = SCANNER.slice(i, SCANNER.indexOf('.in("order_id", samePriceOrders', i))
    .replace(/\/\/.*$/gm, "");
  assert(!/confirmation_min_observation_until/.test(code),
    "refresh must not extend or clear the confirmation window");
  assert(!/last_consumed_touch/.test(code), "nor reset consumed-touch state");
  assert(!/expires_at/.test(code), "nor the TTL");
});

Deno.test("J · the 8h TTL is still fixed from creation and independent of V2", () => {
  const block = SCANNER.slice(SCANNER.indexOf("TTL: 8h, FIXED FROM CREATION"),
    SCANNER.indexOf("Recalculate SL/TP relative to the limit entry"));
  assert(/route2ExpiresAt\(r2PlacedAt\)/.test(block), "TTL derives from the creation instant");
  assert(!/confirmation_min_observation_until/.test(block), "the window must not feed the TTL");
  // the protected window can never outlive the order: one confirm candle is
  // minutes, the TTL is 8 hours.
  const until = Date.parse(confirmationMinObservationUntil("2026-09-29T21:48:00.000Z", "1h"));
  assert(until - Date.parse("2026-09-29T21:48:00.000Z") < 8 * 3600_000,
    "even a 1h confirm TF stays well inside the 8h TTL");
});

// ─── versioning and schema ──────────────────────────────────────────────────

Deno.test("V2 has its own strategy version, distinct from V1", () => {
  assertEquals(ROUTE2_LIFECYCLE_VERSION, "smc-route2-confirmation-lifecycle-v2");
  assert(ROUTE2_LIFECYCLE_VERSION !== "smc-zone-impulse-control-v1");
  assert(/strategy_version: ROUTE2_LIFECYCLE_VERSION/.test(SCANNER),
    "an armed order must be stamped with the V2 version");
});

Deno.test("every lifecycle field the code writes exists in the migration", () => {
  for (const c of ["last_touch_bar_time", "last_touch_detection_time", "last_consumed_touch_id",
    "last_consumed_touch_extreme", "confirmation_arm_count", "confirmation_armed_at",
    "confirmation_min_observation_until", "confirmation_checks_count", "rearm_reason",
    "reset_reason", "hard_invalidation", "touch_consumed"]) {
    assert(MIGRATION.includes(c), `pending_orders.${c} missing from the migration`);
  }
  for (const c of ["touch_id", "touch_verdict", "min_observation_until",
    "reset_deferred", "reset_severity", "lifecycle_version"]) {
    assert(MIGRATION.includes(c), `route2_poll_log.${c} missing from the migration`);
  }
  assert(/NO BACKFILL/.test(MIGRATION), "V1 rows must keep NULL lifecycle state");
});

Deno.test("zone geometry is untouched by this change", () => {
  // §15: refined zone width, refinedEntry and the distance cap are all
  // observational here and must not have moved.
  // Strip comments: the module header explains what it deliberately does NOT
  // change, and that prose names every one of these terms.
  const mod = Deno.readTextFileSync(
    new URL("../../functions/_shared/route2Lifecycle.ts", import.meta.url))
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert(!/refinedEntry|refined_zone_low|refined_zone_high/.test(mod),
    "the lifecycle module must not touch zone geometry");
  assert(!/MAX_PENDING_DISTANCE/.test(mod), "nor the distance cap");
  assert(!/execution_mode|broker/i.test(mod), "nor reach execution mode");
});
