import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The direction engine's settings lived only in the saved config until 2026-10-30, so the
 * owner could not see or change them, and the config names ("H4", "H1") misdescribe the
 * scalper stack (1H → 15m → 5m). These pins keep the Bot Config section honest: every
 * setting is wired, each on-screen default equals the backend default the bot actually
 * uses, and the timeframe labels match the engine's own table.
 */
const ui = readFileSync(resolve(__dirname, "..", "BotConfigModal.tsx"), "utf8");
const mapper = readFileSync(resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "configMapper.ts"), "utf8");
const engine = readFileSync(resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "directionEngine.ts"), "utf8");

const KEYS = [
  "useSimpleDirection", "useConfirmedTrend", "confirmedTrendFibFactor", "confirmedTrendSwingLookback",
  "simpleDirectionH4ChochLookback", "simpleDirectionH1BosLookback", "priceAwareStructureBlocks",
  "thesisValidationEnabled", "thesisCheckDirectionFlip", "thesisDirectionStyleAware",
];

function backendDefault(key: string): string {
  const m = mapper.match(new RegExp(`^\\s*${key}: ([^,]+),`, "m"));
  expect(m, `${key} has no RUNTIME_DEFAULTS entry`).not.toBeNull();
  return m![1].trim();
}

describe("Direction Engine settings in Bot Config", () => {
  it.each(KEYS)("%s is written under strategy", (key) => {
    // integer fields go through the section's intIn helper, which itself writes under strategy
    const direct = ui.includes(`updateField('strategy', '${key}'`);
    const viaHelper = ui.includes(`intIn('${key}'`) && /const intIn = \(key: string[\s\S]{0,400}updateField\('strategy', key,/.test(ui);
    expect(direct || viaHelper, `${key} is not wired to strategy`).toBe(true);
  });

  it.each(KEYS)("%s shows the same default the bot uses", (key) => {
    const def = backendDefault(key);
    const shown = ui.includes(`st.${key} ?? ${def}`) || new RegExp(`=\\s*st\\.${key} \\?\\? ${def.replace(".", "\\.")}\\b`).test(ui);
    expect(shown, `UI fallback for ${key} should be ${def}`).toBe(true);
  });

  it("the timeframe table matches the engine's STYLE_TF_LABELS", () => {
    for (const [style, bias, structure, confirm] of [["scalper", "1H", "15m", "5m"], ["day_trader", "Daily", "4H", "1H"], ["swing_trader", "Weekly", "Daily", "4H"]]) {
      expect(engine).toMatch(new RegExp(`${style}: \\{ biasTFLabel: "${bias}", structureTFLabel: "${structure}", confirmTFLabel: "${confirm}" \\}`));
      expect(ui).toMatch(new RegExp(`${style}: \\{ name: "[^"]+", bias: "${bias}", structure: "${structure}", confirm: "${confirm}"`));
    }
  });

  it("is not hidden behind a condition", () => {
    const at = ui.indexOf("Direction Engine: these settings existed only in the saved config");
    expect(at).toBeGreaterThan(-1);
    const before = ui.slice(at - 300, at);
    expect(before).not.toMatch(/&& \(\s*$/);
  });
});
