import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The "Pending Zone Orders" toggle did not control pending zone orders.
 *
 * bot-scanner:6749:
 *   const effectiveLimitEnabled = !useMarketFillAtZone
 *     && (config.limitOrderEnabled || (izGateMode === "hard" && !!limitEntry));
 *
 * An impulse zone gate mode of "hard" — which is the DEFAULT — auto-enables
 * them whatever the switch says. That is deliberate: in hard mode a pair is
 * only tradeable when price is at the zone, so the alternative to arming a
 * pending order is discarding the setup entirely.
 *
 * The UI did say so, in one italic sentence at the bottom of the expanded
 * block — which rendered inside `{config.entry?.limitOrderEnabled && (...)}`.
 * So the only explanation that the switch does not matter was hidden exactly
 * when the switch was off and it did. Every pending-order finding of
 * 2026-09-09/10 — 45 orders, the direction_flip kills, the TTL expiries — was
 * produced with that toggle reading OFF.
 *
 * The expiry slider was hidden by the same condition while continuing to
 * govern the auto-enabled orders.
 */

const modal = await Deno.readTextFile(
  new URL("../../../src/components/BotConfigModal.tsx", import.meta.url),
);
const scanner = await Deno.readTextFile(
  new URL("../../functions/bot-scanner/index.ts", import.meta.url),
);

/** The scanner's rule, mirrored. */
const effectivelyOn = (limitOrderEnabled: boolean, gateMode: string, marketFill = false) =>
  !marketFill && (limitOrderEnabled || gateMode === "hard");

Deno.test("hard mode arms pending orders with the toggle off", () => {
  assertEquals(effectivelyOn(false, "hard"), true, "this is the state the user found");
  assertEquals(effectivelyOn(true, "hard"), true);
});

Deno.test("soft and off are the only settings that actually stop them", () => {
  assertEquals(effectivelyOn(false, "soft"), false);
  assertEquals(effectivelyOn(false, "off"), false);
  // ...and the toggle DOES work once the gate is not forcing it.
  assertEquals(effectivelyOn(true, "soft"), true);
});

Deno.test("marketFillAtZone suppresses the pending route entirely", () => {
  assertEquals(effectivelyOn(true, "hard", true), false);
});

Deno.test("the scanner rule the UI mirrors is still the one shipped", () => {
  assert(
    /const effectiveLimitEnabled = !useMarketFillAtZone && \(config\.limitOrderEnabled \|\| \(izGateMode === "hard" && !!limitEntry\)\);/
      .test(scanner),
    "if this changes, the UI warning below is wrong and must change with it",
  );
});

Deno.test("the warning renders when the toggle is off and hard mode is on", () => {
  const i = modal.indexOf("Switched off, but still running.");
  assert(i > -1, "the contradiction must be stated in the UI");
  // Its condition is the inverse of the toggle, not the toggle — that inversion
  // is the whole fix.
  const guard = modal.lastIndexOf("{!(config.entry?.limitOrderEnabled ?? false) &&", i);
  assert(guard > -1 && guard < i, "must be gated on the toggle being OFF");
  const cond = modal.slice(guard, i);
  assert(
    /\(config\.strategy\?\.impulseZoneGateMode \?\? 'hard'\) === 'hard'/.test(cond),
    "and on hard mode, defaulting to hard because that is the scanner's default",
  );
});

Deno.test("the warning names the lever that actually works", () => {
  const i = modal.indexOf("Switched off, but still running.");
  const block = modal.slice(i, i + 700);
  assert(/soft/.test(block) && /off/.test(block), "say which settings stop it");
  assert(/Impulse Zone Gate Mode/.test(block), "and name the control by its UI label");
});

Deno.test("the expiry slider stays visible while orders are being armed", () => {
  // It governs the auto-enabled orders too. Hiding it behind the toggle left a
  // live setting unreachable while it was in force.
  const guard = modal.indexOf(
    "{((config.entry?.limitOrderEnabled ?? false) || (config.strategy?.impulseZoneGateMode ?? 'hard') === 'hard') && (",
  );
  assert(guard > -1, "the expiry block must render on EITHER condition");
  const block = modal.slice(guard, guard + 1400);
  assert(/limitOrderExpiryMinutes/.test(block), "the slider is what this reveals");
  assert(/Scalper caps it at 60 minutes/.test(block), "and the cap that overrides it is stated");
});

Deno.test("the toggle's own description no longer implies sole control", () => {
  const i = modal.indexOf('label="Pending Zone Orders"');
  const block = modal.slice(i, i + 700);
  assert(/auto-enables these regardless of this switch/.test(block), "say it on the control itself");
});
