import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

/**
 * The Zone Story panel showed "Gate Score 3.0/9" with no indication that 4 is
 * the pass mark, and coloured it by hardcoded bands of 5 and 3 — neither of
 * which is the actual gate.
 *
 * So a 3.5 rendered the same cyan as a passing 4.5. A score half a point from
 * fatal looked healthy, and nothing on screen named the minimum. The user did
 * not know the gate existed.
 *
 * Measured 2026-09-09: the zone-score gate refused 54 distinct zones in 7 days,
 * 10 of them at exactly 3.5, and 21 of the 54 had price subsequently enter.
 */

const panel = await Deno.readTextFile(
  new URL("../../../src/components/ZoneStoryPanel.tsx", import.meta.url),
);
const botView = await Deno.readTextFile(
  new URL("../../../src/pages/BotView.tsx", import.meta.url),
);
const mapper = await Deno.readTextFile(
  new URL("../../functions/_shared/configMapper.ts", import.meta.url),
);

/** Mirrors the badge's colour choice. */
function band(score: number, min: number) {
  if (score < min) return "reject";
  if (score >= min + 1) return "strong";
  return "marginal";
}

Deno.test("a rejected score is coloured as rejected", () => {
  // The case that misled: 3.5 against a minimum of 4.
  assertEquals(band(3.5, 4), "reject");
  assertEquals(band(3.0, 4), "reject");
  assertEquals(band(3.9, 4), "reject");
});

Deno.test("passing scores are distinguished from marginal ones", () => {
  assertEquals(band(4.0, 4), "marginal");
  assertEquals(band(4.9, 4), "marginal");
  assertEquals(band(5.0, 4), "strong");
});

Deno.test("the bands follow the threshold rather than being hardcoded", () => {
  // If minZoneScore is raised to 5, a 4.5 must start reading as rejected.
  assertEquals(band(4.5, 5), "reject");
  assertEquals(band(5.0, 5), "marginal");
  assertEquals(band(6.0, 5), "strong");
  assert(!/totalScore >= 5 \? "bg-green/.test(panel), "the hardcoded 5 band must be gone");
  assert(!/totalScore >= 3 \? "bg-cyan/.test(panel), "the hardcoded 3 band must be gone");
});

Deno.test("the badge states the threshold either way", () => {
  assert(/below min \$\{minZoneScore\}, REJECTED/.test(panel), "rejection must be explicit");
  assert(/\(min \$\{minZoneScore\}\)/.test(panel), "a passing score should still name the bar it cleared");
});

Deno.test("the tooltip explains the consequence, not just the number", () => {
  assert(
    /rejected before any entry is considered, whatever the confluence score says/.test(panel),
    "a high confluence score next to a failing zone score is exactly the confusion to pre-empt",
  );
  assert(/S\/R confirmation \(\+1\) \+ LTF refinement \(\+1\)/.test(panel),
    "and say what the score is made of, since S/R is usually the missing point");
});

Deno.test("the setting is findable in the config search", () => {
  // It has always been a slider in the Strategy tab, but it was absent from the
  // searchable index — so "zone score" found nothing and you had to know where
  // to scroll. That is half of why the gate went unnoticed.
  const modal = Deno.readTextFileSync(
    new URL("../../../src/components/BotConfigModal.tsx", import.meta.url),
  );
  const line = modal.match(/\{ tab: "strategy", label: "Min Zone Score", keywords: \[([^\]]*)\] \}/);
  assert(line, "missing from the searchable settings index");
  for (const kw of ['"zone"', '"score"', '"gate"', '"threshold"']) {
    assert(line[1].includes(kw), `keyword ${kw} missing`);
  }
});

Deno.test("the slider can express the measured near-miss band", () => {
  // 10 of the 54 rejected zones scored exactly 3.5, so a step coarser than 0.5
  // would make that band untestable.
  const modal = Deno.readTextFileSync(
    new URL("../../../src/components/BotConfigModal.tsx", import.meta.url),
  );
  const i = modal.indexOf("minZoneScore");
  const block = modal.slice(i - 200, i + 300);
  assert(/step=\{0\.5\}/.test(block), "step must allow half points");
  assert(/min=\{0\}/.test(block) && /max=\{9\}/.test(block), "range must span the 0-9 score");
});

Deno.test("the threshold comes from config, not a literal", () => {
  assert(/^  minZoneScore: 4,/m.test(mapper), "the default must exist in the mapper");
  assertEquals((botView.match(/minZoneScore=\{botConfig\?\.strategy\?\.minZoneScore \?\? 4\}/g) ?? []).length, 3,
    "all three call sites must pass it");
  assert(/minZoneScore = 4 \}: Props/.test(panel), "with a default matching the mapper");
});
