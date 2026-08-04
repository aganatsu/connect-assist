/**
 * Phase 2 contract checks for visible Bot Config controls.
 *
 * These source-level assertions prevent the UI from silently writing legacy
 * keys that the runtime does not consume, and keep known unavailable controls
 * visibly disabled instead of pretending they affect execution.
 */

import {
  assert,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const scanTab = await Deno.readTextFile("./src/components/config/ScanTab.tsx");
const exitTab = await Deno.readTextFile("./src/components/config/ExitTab.tsx");
const scanner = await Deno.readTextFile(
  "./supabase/functions/bot-scanner/index.ts",
);

Deno.test("Bot Config writes canonical structural and opening-range keys", () => {
  assert(
    scanTab.includes(
      "updateField('strategy', 'structuralConvictionEnabled', v)",
    ),
  );
  assert(
    scanTab.includes("updateField('openingRange', 'useJudasSwing', v)"),
  );
  assert(
    scanTab.includes("updateField('openingRange', 'useKeyLevels', v)"),
  );
  assertFalse(
    scanTab.includes(
      "updateField('strategy', 'structuralConvictionGate', v)",
    ),
  );
});

Deno.test("known non-executable controls are visibly unavailable", () => {
  for (
    const label of [
      "HTF Bias Timeframe",
      "Session Analysis",
      "Trend Direction",
      "Auto Key Levels",
      "Session Bias",
      "PD Levels",
    ]
  ) {
    const labelIndex = scanTab.indexOf(`label="${label}"`);
    assert(labelIndex >= 0, `Missing visible control: ${label}`);
    const control = scanTab.slice(labelIndex, labelIndex + 500);
    assert(
      control.includes('status="unavailable"'),
      `${label} must explain that it is unavailable`,
    );
    assert(
      control.includes("disabled"),
      `${label} must not remain editable while it has no runtime consumer`,
    );
  }
});

Deno.test("breaker size multiplier reaches executable position sizing", () => {
  assert(
    scanner.includes("?.breakerSizeMultiplier ?? 0.5"),
  );
  assert(
    scanner.includes(
      "pairConfig.riskPerTrade * breakerSizeMultiplier",
    ),
  );
});

Deno.test("exit controls expose unavailable state rather than silently saving", () => {
  for (
    const label of [
      "Max SL (pips)",
      "Min SL (pips)",
      "End-of-Session Close",
    ]
  ) {
    const labelIndex = exitTab.indexOf(`label="${label}"`);
    assert(labelIndex >= 0, `Missing visible control: ${label}`);
    const control = exitTab.slice(labelIndex, labelIndex + 500);
    assert(
      control.includes('status="unavailable"'),
      `${label} must explain that it is unavailable`,
    );
    assert(
      control.includes("disabled"),
      `${label} must not remain editable while it has no runtime consumer`,
    );
  }
});
