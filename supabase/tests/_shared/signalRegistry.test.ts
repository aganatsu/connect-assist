import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The "What's Active" tab exists because this codebase keeps shipping features
 * that compute a result nothing consumes — the Tier 1 gate disabled in config
 * while every panel implied it was live, ictDisplacementMSS grading every MSS
 * and discarding the grade, priceAwareStructureBlocks holding the retracement
 * fix behind a false.
 *
 * A panel claiming to report that is worthless the moment it drifts, so these
 * tests hold it to the code:
 *
 *   - every config key it names must exist in configMapper's defaults
 *   - the observational entries must still be observational
 *   - status must come from the config, never from a hardcoded claim
 */

const panel = await Deno.readTextFile(
  new URL("../../../src/components/SignalStatusPanel.tsx", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);

/** Keys the panel says it reads. */
function declaredKeys(): string[] {
  return [...panel.matchAll(/(?:enabledKey|gateKey): "([a-zA-Z]+)"/g)].map(m => m[1]);
}

Deno.test("every config key the panel names actually exists", () => {
  // A key that has been renamed would silently render as "Not set in this
  // config", which reads as a deliberate choice rather than a broken panel.
  const keys = [...new Set(declaredKeys())];
  assert(keys.length >= 10, `expected a real registry, found ${keys.length} keys`);
  const missing = keys.filter(k => !new RegExp(`\\b${k}\\b`).test(mapper));
  assertEquals(missing, [], `keys absent from configMapper: ${missing.join(", ")}`);
});

Deno.test("status is derived from config, not asserted", () => {
  // The whole point is that it cannot be wrong in the way the rest of the UI was.
  assert(/function signalStatus\(/.test(panel), "status is computed");
  assert(/readKey\(config, s\.enabledKey\)/.test(panel), "reads the live enabled flag");
  assert(/readKey\(config, s\.gateKey\)/.test(panel), "reads the live gate mode");
  assert(!/status: "rejects",\s*\n\s*label:/.test(panel), "no hardcoded per-signal status");
});

Deno.test("enabled-but-ignored is its own category", () => {
  // Enabled: true + GateMode: "off" is the failure mode that reads as "on"
  // everywhere else. If it collapses into "off" or "rejects" the panel is
  // useless for the thing it was built for.
  assert(/return "ignored";/.test(panel), "the category exists");
  assert(/Runs, then the result is thrown away/.test(panel), "and is named plainly");
  // hard -> rejects, soft -> scores, anything else -> ignored
  assert(/if \(gate === "hard"\) return "rejects";/.test(panel));
  assert(/if \(gate === "soft"\) return "scores";/.test(panel));
});

Deno.test("the observational entries are still observational", () => {
  // If one of these ever starts gating, it must move out of this group in the
  // same change — otherwise the tab tells you a live gate is only being watched.
  const engine = Deno.readTextFileSync(
    new URL("../../functions/_shared/impulseZoneEngine.ts", import.meta.url),
  );
  const scanner = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url),
  );
  for (const claim of ["Impulse leg displacement", "Origin / BOS candle closes", "Blocked retracements"]) {
    assert(panel.includes(claim), `registry still lists ${claim}`);
  }
  assert(/OBSERVATIONAL ONLY/.test(engine), "leg displacement");
  assert(/OBSERVATIONAL\. Nothing gates on it\./.test(engine), "candle quality");
  assert(!/blockedRetracement[^;]*(?:continue|rejected)/.test(scanner), "blocked retracements");
});

Deno.test("the gates it reports as live really are wired to a rejection", () => {
  // Reverse of the above: if the panel says something can refuse a trade, the
  // scanner must contain that rejection.
  const scanner = Deno.readTextFileSync(
    new URL("../../functions/bot-scanner/index.ts", import.meta.url),
  );
  for (const key of ["ictDisplacementMSSGateMode", "ictJudasSwingGateMode", "ictFVGInvalidationGateMode"]) {
    assert(new RegExp(`${key} === "hard"`).test(scanner),
      `${key} is listed as a gate but the scanner never checks it`);
  }
});

Deno.test("priceAwareStructureBlocks is described by what it costs", () => {
  // It is off, and the reason it matters is not obvious from the key name.
  // Match within a single string literal: the description is written as
  // adjacent concatenated literals, so a phrase spanning the join never matches.
  assert(/healthy /.test(panel) && /pullback\./.test(panel),
    "explains what the waiver does");
  assert(/refused the same way a/.test(panel) && /reversal is\./.test(panel),
    "explains the consequence of it being off");
});
