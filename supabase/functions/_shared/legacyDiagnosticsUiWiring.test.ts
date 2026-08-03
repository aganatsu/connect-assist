import { assert, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const panel = await Deno.readTextFile("./src/components/LegacyDiagnosticsPanel.tsx");
const botView = await Deno.readTextFile("./src/pages/BotView.tsx");
const reasoning = await Deno.readTextFile("./src/components/SignalReasoningCard.tsx");
const position = await Deno.readTextFile("./src/components/ExpandedPositionCard.tsx");

Deno.test("legacy diagnostics are collapsed and explicitly non-authorizing", () => {
  assertStringIncludes(panel, "<details");
  assertStringIncludes(panel, "Legacy Diagnostics");
  assertStringIncludes(panel, "Does not authorize");
  assert(!panel.includes("<details open"));
});

Deno.test("scan, position and signal details use the shared diagnostic panel", () => {
  for (const source of [botView, reasoning, position]) {
    assertStringIncludes(source, "LegacyDiagnosticsPanel");
  }
  assertStringIncludes(botView, "ownershipDiagnostics={d.legacyGateDiagnostics}");
});

Deno.test("Zone Story retains linked timeframe evidence in authoritative scan details", () => {
  assertStringIncludes(botView, "<ZoneStoryPanel");
  assertStringIncludes(botView, "timeframeEvidenceId={d.timeframeEvidenceId}");
});
