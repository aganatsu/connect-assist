import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const editor = await Deno.readTextFile(
  new URL("../../../src/components/TradeOverrideEditor.tsx", import.meta.url),
);
const card = await Deno.readTextFile(
  new URL("../../../src/components/ExpandedPositionCard.tsx", import.meta.url),
);

Deno.test("trade override editor sends only changed fields", () => {
  assertStringIncludes(editor, "const payload: TradeOverrides = {}");
  assertStringIncludes(editor, "payload.trailingStopPips = trailPipsValue");
  assertStringIncludes(editor, "trailPipsValue !== effectiveCfg.trailingStopPips");
  if (editor.includes("always send the full set")) {
    throw new Error("Override editor must not activate unrelated management fields");
  }
});

Deno.test("position card uses resolved overrides and discloses trail safety floor", () => {
  assertStringIncludes(card, "...(p.effectiveConfig || {})");
  assertStringIncludes(card, "Math.max(configuredTrailPips, riskPips * 0.5)");
  assertStringIncludes(card, "Effective trail:");
  assertStringIncludes(editor, "Minimum Trail (pips)");
});
