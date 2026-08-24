import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const files = [
  "src/components/config/ScanTab.tsx",
  "src/components/config/EnterTab.tsx",
  "src/components/config/ExitTab.tsx",
  "src/components/config/RiskTab.tsx",
];

describe("Bot Config clarity", () => {
  it("opens with every settings section collapsed", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("defaultOpen={true}");
    }
  });

  it("keeps runtime verification compact with explanatory copy", () => {
    const source = readFileSync("src/components/BotConfigModal.tsx", "utf8");
    expect(source).toContain("<details");
    expect(source).toContain("RUNTIME VERIFIED");
    expect(source).toContain("Saved settings are valid and ready for the scanner.");
  });

  it("exposes reasons for unavailable controls", () => {
    const shared = readFileSync("src/components/config/ConfigShared.tsx", "utf8");
    const scan = readFileSync("src/components/config/ScanTab.tsx", "utf8");
    expect(shared).toContain("title={reason");
    expect(shared).toContain("reason={description}");
    expect(scan).toContain('state="unavailable" reason=');
  });

  it("describes nested POI market fill as opt-in with no midpoint fallback", () => {
    const source = readFileSync("src/components/config/EnterTab.tsx", "utf8");
    expect(source).toContain('label="Nested POI Market Trigger"');
    expect(source).toContain("the outer zone only arms the setup");
    expect(source).toContain("there is no midpoint fallback");
    expect(source).toContain("Active setups keep their frozen route");
    expect(source).toContain("Nested POI enforcement replaces CHoCH/indicator confirmation");
    expect(source).toContain("const nestedPoiEnforced = !connectionScoped && marketFillEnabled &&");
    expect(source).toContain('<SelectItem value="off">Off — Existing Entry Behavior</SelectItem>');
    expect(source).toContain('<SelectItem value="observe">Observe Only</SelectItem>');
    expect(source).toContain('<SelectItem value="enforce_paper">Enforce on Paper</SelectItem>');
    expect(source).toContain('<SelectItem value="enforce_live">Enforce on Paper + Live</SelectItem>');
  });

  it("keeps the nested POI execution control global-only", () => {
    const modal = readFileSync("src/components/BotConfigModal.tsx", "utf8");
    const enter = readFileSync("src/components/config/EnterTab.tsx", "utf8");
    expect(modal).toContain("connectionScoped={!!connectionId}");
    expect(enter).toContain("connectionScoped = false");
    expect(enter).toContain("disabled={connectionScoped}");
    expect(enter).toContain("owned by Global Bot Config");
    expect(enter).toContain("const nestedPoiEnforced = !connectionScoped &&");
  });
});
