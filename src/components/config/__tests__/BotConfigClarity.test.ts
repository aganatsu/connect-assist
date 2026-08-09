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
});
