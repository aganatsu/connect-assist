import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The Tier 1 gate reason is read by a human trying to understand why a setup
 * was rejected, so it has to describe the gate that actually ran.
 *
 * It didn't. The failure message ended with ", HTF FVG/OB/Fib", offering a
 * route through the gate that does not exist:
 *
 *   - tier1Count increments only where `tier === 1` (confluenceScoring:2584),
 *     and tier comes from TIER_1_FACTORS.
 *   - The two carriers of the HTF-nested flags — "HTF POI Alignment" and
 *     "HTF Fib + PD + Liquidity" — are both in TIER_2_FACTORS.
 *   - The counting loop runs before the promotion block that sets
 *     _htfTier1FVG / _htfTier1OB / _htfTier1Fib, so it could not observe them
 *     even if the tiers agreed.
 *
 * HTF nesting is real and does raise tieredScore through the quality delta.
 * What it cannot do is satisfy the Tier 1 count. The same names were also
 * pushed into the counted list, so a passing message could print three factors
 * after "2 core factors".
 */

const src = await Deno.readTextFile(
  new URL("../../functions/_shared/confluenceScoring.ts", import.meta.url),
);

Deno.test("the failure message does not advertise HTF FVG/OB/Fib as a qualifier", () => {
  assert(
    !/need at least \$\{_minTier1\} of:[^`]*HTF FVG\/OB\/Fib/.test(src),
    "the Tier 1 failure reason must not list HTF FVG/OB/Fib among the " +
      "qualifying factors — nothing HTF-nested can increment tier1Count",
  );
});

Deno.test("only real TIER_1_FACTORS are offered as qualifiers", () => {
  const m = src.match(/const tier1Qualifiers = `([^`]*)`/);
  assert(m, "tier1Qualifiers not found");
  // Strip the conditional Unicorn suffix before comparing.
  const listed = m[1].replace(/\$\{[\s\S]*?\}/g, "").split(",")
    .map((s) => s.trim()).filter(Boolean);

  const setMatch = src.match(/const TIER_1_FACTORS = new Set\(\[([^\]]*)\]\)/);
  assert(setMatch, "TIER_1_FACTORS not found");
  const actual = setMatch[1].split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

  for (const name of listed) {
    assert(
      actual.includes(name),
      `"${name}" is offered as a Tier 1 qualifier but is not in TIER_1_FACTORS`,
    );
  }
  for (const name of actual) {
    assert(
      listed.includes(name),
      `"${name}" is a Tier 1 factor but is not offered in the failure message`,
    );
  }
});

Deno.test("HTF-nested names are reported separately from the counted factors", () => {
  // Previously these were pushed into tier1PresentNames, so the printed list
  // could be longer than tier1Count.
  assert(
    /htfNestedNames\.push\("FVG \(HTF-nested\)"\)/.test(src) &&
      /htfNestedNames\.push\("OB \(HTF-nested\)"\)/.test(src) &&
      /htfNestedNames\.push\("Fib \(HTF-nested\)"\)/.test(src),
    "HTF-nested confirmations must go into their own list, not tier1PresentNames",
  );
  assert(
    !/tier1PresentNames\.push\("(FVG|OB|Fib) \(HTF-nested\)"\)/.test(src),
    "HTF-nested names must not be added to the counted Tier 1 list",
  );
});

Deno.test("the HTF-nested note says it is not counted", () => {
  assert(
    /not counted/.test(src),
    "the HTF-nested annotation should state that it does not count toward the gate",
  );
});

Deno.test("both HTF carriers really are Tier 2", () => {
  // If either is ever promoted into TIER_1_FACTORS the reasoning above changes
  // and this whole file should be revisited rather than patched.
  const t2 = src.match(/const TIER_2_FACTORS = new Set\(\[([^\]]*)\]\)/);
  assert(t2, "TIER_2_FACTORS not found");
  for (const carrier of ["HTF POI Alignment", "HTF Fib + PD + Liquidity"]) {
    assert(
      t2[1].includes(carrier),
      `${carrier} is no longer Tier 2 — re-check whether HTF nesting now counts`,
    );
  }
});
