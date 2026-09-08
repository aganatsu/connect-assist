import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveExitSettings } from "../../../src/lib/exitSettings.ts";

/**
 * The position table's BE column showed "—" while the position's stop had
 * already been moved to break-even.
 *
 * Observed 2026-09-08: NZD/USD with trade_overrides
 * {"breakEvenEnabled":true,"breakEvenPips":8} and a stop of 0.58805 — entry
 * 0.58835 minus the 3-pip offset, i.e. break-even had demonstrably fired — and
 * the column reading disabled.
 *
 * Cause: the UI read `exitFlags.breakEvenEnabled`, the snapshot frozen into
 * signal_reason when the position OPENED. The override lives in
 * trade_overrides, which the UI never read. And the render short-circuits:
 *
 *   !beEnabled ? "—" : beFired ? "✅" : "⏳"
 *
 * so a false snapshot hid the activation entirely.
 *
 * Hold time was the exception — it already consulted live config, which is why
 * that column was correct while the other two were not. Same split that
 * paper-trading had before #490.
 */

const botView = await Deno.readTextFile(
  new URL("../../../src/pages/BotView.tsx", import.meta.url),
);
const mobile = await Deno.readTextFile(
  new URL("../../../src/components/MobilePositionCard.tsx", import.meta.url),
);

const snapshotOff = { breakEvenEnabled: false, breakEvenPips: 8, maxHoldHours: 4 };

Deno.test("the observed NZD/USD case now reads as enabled", () => {
  const r = resolveExitSettings(
    { trade_overrides: '{"breakEvenEnabled":true,"breakEvenPips":8}' },
    snapshotOff,
    {},
  );
  assertEquals(r.breakEvenEnabled, true);
  assertEquals(r.breakEvenPips, 8);
  assertEquals(r.breakEvenSource, "override");
});

Deno.test("override beats live config beats snapshot", () => {
  assertEquals(resolveExitSettings({ trade_overrides: '{"breakEvenEnabled":false}' }, { breakEvenEnabled: true }, { breakEvenEnabled: true }).breakEvenEnabled, false);
  assertEquals(resolveExitSettings({}, { breakEvenEnabled: false }, { breakEvenEnabled: true }).breakEvenEnabled, true);
  assertEquals(resolveExitSettings({}, { breakEvenEnabled: true }, {}).breakEvenEnabled, true);
  assertEquals(resolveExitSettings({}, {}, {}).breakEvenEnabled, false);
});

Deno.test("the source is reported, so a tooltip can explain the value", () => {
  assertEquals(resolveExitSettings({ trade_overrides: '{"breakEvenEnabled":true}' }, {}, {}).breakEvenSource, "override");
  assertEquals(resolveExitSettings({}, {}, { breakEvenEnabled: true }).breakEvenSource, "config");
  assertEquals(resolveExitSettings({}, { breakEvenEnabled: true }, {}).breakEvenSource, "snapshot");
  assertEquals(resolveExitSettings({}, {}, {}).breakEvenSource, "default");
});

Deno.test("both config shapes are read", () => {
  // BotConfigModal writes at the top level; older shapes nest under `exit`.
  assertEquals(resolveExitSettings({}, {}, { exit: { breakEvenEnabled: true } }).breakEvenEnabled, true);
  assertEquals(resolveExitSettings({}, {}, { breakEvenEnabled: true }).breakEvenEnabled, true);
});

Deno.test("activation stays runtime state from the position", () => {
  // Sourcing this from config would mark every position activated at once.
  assertEquals(resolveExitSettings({}, { breakEvenActivated: true }, { breakEvenEnabled: false }).breakEvenActivated, true);
  assertEquals(resolveExitSettings({}, {}, { breakEvenActivated: true }).breakEvenActivated, false);
});

Deno.test("legacy snapshot keys still work", () => {
  // Older positions used `breakEven` / `trailingStop` booleans.
  assertEquals(resolveExitSettings({}, { breakEven: true }, {}).breakEvenEnabled, true);
  assertEquals(resolveExitSettings({}, { trailingStop: true }, {}).trailingStopEnabled, true);
});

Deno.test("malformed overrides do not throw", () => {
  assertEquals(resolveExitSettings({ trade_overrides: "not json" }, snapshotOff, {}).breakEvenEnabled, false);
  assertEquals(resolveExitSettings({ trade_overrides: null }, snapshotOff, {}).breakEvenEnabled, false);
  // jsonb rather than string
  assertEquals(resolveExitSettings({ trade_overrides: { breakEvenEnabled: true } }, snapshotOff, {}).breakEvenEnabled, true);
  // camelCase variant used elsewhere in the UI
  assertEquals(resolveExitSettings({ tradeOverrides: '{"breakEvenEnabled":true}' }, snapshotOff, {}).breakEvenEnabled, true);
});

Deno.test("both position views use the resolver, not exitFlags directly", () => {
  for (const [name, src] of [["BotView", botView], ["MobilePositionCard", mobile]] as const) {
    assert(/resolveExitSettings\(/.test(src), `${name} must use the resolver`);
    assert(!/ef\.breakEvenEnabled \?\? ef\.breakEven/.test(src), `${name} still reads the raw snapshot`);
    assert(!/ef\.trailingStopEnabled \?\? ef\.trailingStop/.test(src), `${name} still reads the raw snapshot`);
  }
});

Deno.test("the mobile card is given the live config it needs", () => {
  assert(/botConfig\?: any;/.test(mobile), "prop must exist");
  assert(/botConfig=\{botConfig\}/.test(botView), "and be passed in");
});
