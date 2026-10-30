import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The confirmation selector was removed with the 2026-09-01 revert, and from then on both
 * pollers passed DEFAULT_ZONE_CONFIRMATION_CONFIG, so every tier was on with no way to change
 * it. These pins keep the Bot Config section and the backend reading the same three keys,
 * with the same "missing means on" default.
 */
const ui = readFileSync(resolve(__dirname, "..", "BotConfigModal.tsx"), "utf8");
const backend = readFileSync(resolve(__dirname, "..", "..", "..", "supabase", "functions", "_shared", "zoneConfirmation.ts"), "utf8");

const KEYS = ["confirmationTier1Enabled", "confirmationTier2Enabled", "confirmationTier3Enabled"];

describe("Entry Confirmation settings in Bot Config", () => {
  it.each(KEYS)("%s is listed in the section and read by the backend", (key) => {
    expect(ui).toContain(`key: '${key}'`);
    expect(backend).toContain(`entry.${key} !== false`);
  });

  it("writes under entry and shows a missing key as on, like the backend", () => {
    expect(ui).toContain("updateField('entry', t.key, v)");
    expect(ui).toContain("en[t.key] !== false");
  });

  it("will not switch off the last tier", () => {
    expect(ui).toMatch(/if \(v \|\| onCount > 1\) updateField\('entry', t\.key, v\)/);
  });

  it("is searchable", () => {
    expect(ui).toMatch(/\{ tab: "entry_exit", label: "Entry Confirmation"/);
  });
});
