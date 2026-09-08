import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * Two engines manage the same open position and read the same settings from
 * different places:
 *
 *   scannerManagement   live config, overridden per-position by trade_overrides
 *                       runs every minute on the management cron
 *
 *   paper-trading       exitFlags — the snapshot frozen into signal_reason when
 *                       the position OPENED
 *                       runs only while the browser is open
 *
 * So toggling break-even reported "changes take effect in the next cycle" —
 * true for one engine, false for the other — while positions sat at +1.35R and
 * +1.11R on their original stops with nothing protecting them.
 *
 * paper-trading already read LIVE config for maxHold (:970) and the frozen
 * snapshot for these two, in the same loop. It also WROTE trade_overrides
 * (:1503) and never read them back.
 *
 * Precedence is now per-trade override > live config > frozen snapshot, the
 * same order scannerManagement uses. The snapshot stays last so positions
 * predating live config behave as they did.
 */

const paper = await Deno.readTextFile(
  new URL("../../functions/paper-trading/index.ts", import.meta.url),
);
const mgmt = await Deno.readTextFile(
  new URL("../../functions/_shared/scannerManagement.ts", import.meta.url),
);

/** The resolution both engines should now agree on. */
function resolve(
  overrides: Record<string, unknown>,
  live: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  key: string,
) {
  return overrides[key] ?? live[key] ?? snapshot[key];
}

Deno.test("a per-trade override wins over everything", () => {
  assertEquals(resolve({ breakEvenEnabled: false }, { breakEvenEnabled: true }, { breakEvenEnabled: true }, "breakEvenEnabled"), false);
});

Deno.test("live config beats the frozen snapshot", () => {
  // The case that prompted this: snapshot says false from entry time, the user
  // has since turned it on.
  assertEquals(resolve({}, { breakEvenEnabled: true }, { breakEvenEnabled: false }, "breakEvenEnabled"), true);
});

Deno.test("the snapshot still applies when live config is silent", () => {
  // Legacy positions predating live config must not change behaviour.
  assertEquals(resolve({}, {}, { breakEvenEnabled: true }, "breakEvenEnabled"), true);
  assertEquals(resolve({}, {}, {}, "breakEvenEnabled"), undefined);
});

Deno.test("false is respected, not treated as absent", () => {
  // ?? rather than ||: a deliberate false must not fall through to the next
  // source, which is how "I turned this off" gets ignored.
  assertEquals(resolve({}, { breakEvenEnabled: false }, { breakEvenEnabled: true }, "breakEvenEnabled"), false);
  assertEquals(resolve({ trailingStopEnabled: false }, {}, { trailingStopEnabled: true }, "trailingStopEnabled"), false);
  assert(/posOverrides\[k\] \?\? liveFlag\(k\) \?\? exitFlags\[k\]/.test(paper), "must use ?? throughout");
});

Deno.test("paper-trading reads trade_overrides it was already writing", () => {
  assert(/posOverrides = pos\.trade_overrides/.test(paper), "must read the column");
  assert(/updates\.trade_overrides = JSON\.stringify/.test(paper), "which it already wrote");
  assert(/catch \{ posOverrides = \{\}; \}/.test(paper), "malformed JSON must not throw mid-management");
});

Deno.test("both config shapes are read, not guessed", () => {
  // The UI writes these at the top level of config_json; older shapes nest
  // them under `exit`. Picking one would silently ignore half the accounts.
  assert(/const liveFlag = \(k: string\) => liveExit\[k\] \?\? liveConfig\[k\];/.test(paper));
});

Deno.test("the toggle and its distance come from the same source", () => {
  // Honouring live config for trailingStopEnabled while still taking
  // trailingStopPips from the snapshot would trail at a stale distance.
  // Everything AFTER the trailPips definition line must use the resolved
  // value. The definition itself legitimately names the snapshot as its final
  // fallback, so start the search on the next line.
  const defIdx = paper.indexOf("const trailPips =");
  assert(defIdx > -1, "trailPips must exist");
  const after = paper.slice(paper.indexOf("\n", defIdx));
  assert(!/exitFlags\.trailingStopPips/.test(after),
    "no snapshot pip reads once the resolved value exists");
  assert(/Math\.max\(trailPips, riskPips \* 0\.5\)/.test(paper));
  assert(/bePips \/ riskPips/.test(paper), "break-even activation must use the resolved pips");
});

Deno.test("activation state stays per-position", () => {
  // breakEvenActivated / trailingStopActivated are runtime state, not settings.
  // They must keep coming from the position, or BE would re-fire every cycle.
  assert(/exitFlags\.breakEvenActivated === true/.test(paper));
  assert(/exitFlags\.trailingStopActivated === true/.test(paper));
});

Deno.test("scannerManagement's precedence is the one being matched", () => {
  assert(/if \(overrides\.breakEvenEnabled !== undefined\) posBreakEvenEnabled = overrides\.breakEvenEnabled;/.test(mgmt));
  assert(/if \(overrides\.trailingStopEnabled !== undefined\) posTrailingEnabled = overrides\.trailingStopEnabled;/.test(mgmt));
});
