import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("Bot Config runtime authority status", () => {
  it("returns effective authority modes from the verified runtime endpoint", () => {
    const endpoint = readFileSync(
      "supabase/functions/bot-config/index.ts",
      "utf8",
    );
    const api = readFileSync("src/lib/api.ts", "utf8");

    expect(endpoint).toContain("authorityModes");
    expect(endpoint).toContain("resolveZoneLocalMode");
    expect(endpoint).toContain("resolveCrossTimeframeAuthority");
    expect(endpoint).toContain("resolveImpulseLifecycleEnforcement");
    expect(api).toContain("authorityModes: BotRuntimeAuthorityModes");
  });

  it("shows saved request and effective runtime separately in Bot Config", () => {
    const shared = readFileSync(
      "src/components/config/ConfigShared.tsx",
      "utf8",
    );
    const modal = readFileSync("src/components/BotConfigModal.tsx", "utf8");

    expect(shared).toContain("RuntimeModeStatus");
    expect(shared).toContain("SAVED REQUEST");
    expect(shared).toContain("EFFECTIVE NOW");
    expect(modal).toContain(
      "runtimeAuthorityModes={effectiveRuntime?.authorityModes}",
    );
  });

  it("does not describe lifecycle evidence review as the enforcement unlock", () => {
    const page = readFileSync("src/pages/RejectedSetups.tsx", "utf8");

    expect(page).not.toContain("Review & Unlock Enforce");
    expect(page).not.toContain("ENFORCE LOCKED");
    expect(page).toContain(
      "Runtime enforcement is selected separately in Bot Config",
    );
  });
});
