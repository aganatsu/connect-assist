import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The Zone Story panel showed the EXECUTABLE R:R with quality colouring:
 *
 *   rrRatio >= 3 ? green-bold : rrRatio >= 2 ? cyan : orange
 *
 * But the executable ratio is `Math.round(tpRatio * 100) / 100` — the config
 * value, verbatim. Execution recomputes the target as entry +/- risk * tpRatio,
 * so the ratio is 2:1 on every setup, always. Every zone rendered a confident
 * cyan "R:R 2:1" that carried no information about the setup at all.
 *
 * This was already recorded when the executable plan was built — "the
 * executable TP is an arithmetic artifact... It looks like a target and is not
 * one" — and then forgotten. Review caught it.
 *
 * The STRUCTURAL ratio (reward to the impulse BOS level over the zone-derived
 * risk) does vary by setup, so it keeps its grading. It just is not what trades.
 */

const engine = await Deno.readTextFile(
  new URL("../../functions/_shared/unifiedZoneEngine.ts", import.meta.url),
);
const panel = await Deno.readTextFile(
  new URL("../../../src/components/ZoneStoryPanel.tsx", import.meta.url),
);

Deno.test("the executable ratio really is the config constant", () => {
  // If this ever stops being true the panel should go back to grading it.
  assert(
    /rrRatio: Math\.round\(tpRatio \* 100\) \/ 100,/.test(engine),
    "executable.rrRatio must be tpRatio for this whole argument to hold",
  );
  // Same for reward: it is risk * tpRatio, so the ratio cannot vary.
  assert(/rewardPips: Math\.round\(execRiskPrice \* tpRatio \* pipMult \* 10\) \/ 10,/.test(engine));
});

Deno.test("a constant is not colour-graded like a measurement", () => {
  const i = panel.indexOf("R:R {unifiedData.entry.executable.rrRatio}:1 (configured)");
  assert(i > -1, "the executable ratio must be labelled as configured");
  const block = panel.slice(Math.max(0, i - 400), i);
  assert(!/text-green-400 font-bold/.test(block), "no quality grading on a constant");
  assert(/text-zinc-400/.test(block), "render it neutrally");
});

Deno.test("the structural ratio keeps its grading", () => {
  // It genuinely varies — reward to BOS over zone-derived risk.
  const i = panel.indexOf("R:R {unifiedData.entry.rrRatio}:1");
  assert(i > -1, "the structural fallback must still render");
  const block = panel.slice(Math.max(0, i - 300), i);
  assert(/text-green-400 font-bold/.test(block), "grading is appropriate here");
});

Deno.test("both are shown when they differ", () => {
  // The structural ratio is the informative one; hiding it entirely would trade
  // a misleading number for a missing one.
  assert(/structural \{unifiedData\.entry\.rrRatio\}:1/.test(panel));
  assert(
    /unifiedData\.entry\.rrRatio !== unifiedData\.entry\.executable\.rrRatio/.test(panel),
    "only worth showing when it adds something",
  );
});

Deno.test("the tooltip says why the number is uninformative", () => {
  assert(
    /is the same on every setup\. It is not a measure of this setup's quality\./.test(panel),
    "a label alone invites the reader to assume it was computed",
  );
});

Deno.test("the executable ratio is arithmetically fixed", () => {
  // Demonstrates the claim rather than asserting it about source text.
  const exec = (riskPips: number, tpRatio: number) => {
    const rewardPips = riskPips * tpRatio;
    return Math.round((rewardPips / riskPips) * 100) / 100;
  };
  for (const risk of [1.3, 8, 25, 150, 700]) {
    assertEquals(exec(risk, 2), 2, `risk ${risk} still yields exactly 2:1`);
  }
});

Deno.test("the other disclosures survive", () => {
  // Widening, over-wide rejection and market fill were already handled; the
  // edit must not have dropped them.
  for (const s of ["SL widened to floor", "SL too wide — execution uses structural stop"]) {
    assert(panel.includes(s), `${s} disclosure lost`);
  }
  assert(/fillsAtMarket/.test(panel), "market-fill disclosure lost");
});
