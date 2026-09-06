import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * `zoneEntryDepth` was SQL-only, like every flag added on 2026-09-06. It is the
 * one that needs a control, for two reasons:
 *
 *   - it is a value to tune iteratively (0.25 / 0.5 / 0.75), not a one-time
 *     boolean
 *   - setting it by hand is a silent-failure trap. `jsonb_set(..., '"0.5"')`
 *     stores a STRING, and `strategy.zoneEntryDepth ?? RUNTIME_DEFAULTS...`
 *     passes it straight into arithmetic without complaint.
 *
 * The slider always writes a number, which removes that trap entirely.
 */

const modal = await Deno.readTextFile(
  new URL("../../../src/components/BotConfigModal.tsx", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);

Deno.test("the control writes a number, not a string", () => {
  assert(
    /updateField\('strategy', 'zoneEntryDepth', Math\.round\(v\) \/ 100\)/.test(modal),
    "the value must be arithmetic, so it can never be persisted as a string",
  );
  // Round-trip the slider maths for every step it can emit.
  for (let pct = 0; pct <= 100; pct += 5) {
    const stored = Math.round(pct) / 100;
    assertEquals(typeof stored, "number");
    assert(stored >= 0 && stored <= 1, `${pct}% -> ${stored} must stay in range`);
  }
});

Deno.test("the displayed default matches the mapper default", () => {
  // A control defaulting to something the backend does not would misreport the
  // live setting to anyone who has never touched it.
  const shown = modal.match(/config\.strategy\?\.zoneEntryDepth \?\? (\d+)/);
  assert(shown, "the control must show an explicit fallback");
  const backend = mapper.match(/^  zoneEntryDepth: (\d+),/m);
  assert(backend, "mapper default missing");
  assertEquals(shown[1], backend[1]);
});

Deno.test("slider percent and stored fraction agree", () => {
  // The slider is in percent and the config is a fraction; an off-by-100 here
  // would silently clamp every setting to the far edge.
  assert(
    /value=\{\[Math\.round\(\(config\.strategy\?\.zoneEntryDepth \?\? 1\) \* 100\)\]\}/.test(modal),
    "display must convert fraction to percent",
  );
  assert(/min=\{0\}/.test(modal) && /max=\{100\}/.test(modal), "the slider must span 0-100");
});

Deno.test("the far edge is flagged as the state that does not fill", () => {
  // 100% is the default and the behaviour that produced 1 fill in 899 orders.
  // It should not look like a neutral setting.
  assert(/FAR EDGE/.test(modal), "the default must be labelled");
  assert(/FIRST TOUCH/.test(modal), "and so must the other extreme");
  assert(/text-warn border-warn\/40/.test(modal), "far edge should read as a warning, not neutral");
});

Deno.test("the trade-off is stated in the UI, not just the PR", () => {
  // Shallower entry = more fills AND more risk. Someone dragging this slider
  // months from now will not have read the pull request.
  assert(
    /stop stays anchored to the zone rather than following the entry in/.test(modal),
    "the stop behaviour must be explained where the control is",
  );
  assert(
    /more fills, larger risk, lower R:R/.test(modal),
    "the cost must be stated alongside the benefit",
  );
});

Deno.test("the evidence is cited where the decision is made", () => {
  assert(/390 of 444/.test(modal) && /25 of 899/.test(modal),
    "the measurement that motivated the control belongs next to it");
});

Deno.test("the worked example only shows when it is meaningful", () => {
  // At depth 1 the example would read 'entry 79000.00 (was 79000.00)'.
  assert(
    /\(config\.strategy\?\.zoneEntryDepth \?\? 1\) < 1 && \(/.test(modal),
    "the example must be conditional on a non-default depth",
  );
  // And its arithmetic must match buildEntryStory: high - width * depth.
  // toFixed(2) here, Math.round(x*100)/100 in the engine test — 79677.325
  // lands on .32 one way and .33 the other. Cosmetic, but assert what the UI
  // actually renders rather than what the other test rounds to.
  const ex = (d: number) => 80354.65 - 1354.65 * d;
  assertEquals(ex(1).toFixed(2), "79000.00");
  assertEquals(ex(0.5).toFixed(2), "79677.32");
  assertEquals(ex(0.25).toFixed(2), "80015.99");
  assert(
    /80354\.65 - 1354\.65 \* \(config\.strategy\?\.zoneEntryDepth \?\? 1\)/.test(modal),
    "the example must use the same near-edge formula the engine uses",
  );
});

Deno.test("the setting is findable in the config search index", () => {
  const line = modal.match(/\{ tab: "strategy", label: "Zone Entry Depth", keywords: \[([^\]]*)\] \}/);
  assert(line, "missing from the searchable settings index");
  for (const kw of ['"depth"', '"entry"', '"zone"', '"fill"']) {
    assert(line[1].includes(kw), `keyword ${kw} missing`);
  }
});
