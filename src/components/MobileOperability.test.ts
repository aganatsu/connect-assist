import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const shell = readFileSync("src/components/AppShell.tsx", "utf8");
const nav = readFileSync("src/components/MobileNav.tsx", "utf8");
const topBar = readFileSync("src/components/MobileTopBar.tsx", "utf8");
const config = readFileSync("src/components/BotConfigModal.tsx", "utf8");
const bot = readFileSync("src/pages/BotView.tsx", "utf8");
const rejected = readFileSync("src/pages/RejectedSetups.tsx", "utf8");

describe("mobile operability", () => {
  it("uses the dynamic viewport and leaves safe space for bottom navigation", () => {
    expect(shell).toContain("100dvh");
    expect(shell).toContain("safe-area-inset-bottom");
    expect(bot).toContain("100dvh");
  });

  it("keeps every secondary route reachable in a scrollable menu", () => {
    for (const route of [
      "/ict-analysis", "/fundamentals", "/journal", "/backtest",
      "/brokers", "/trade-replay", "/prop-firm", "/rejected-setups",
      "/optimizer", "/settings",
    ]) expect(nav).toContain(route);
    expect(nav).toContain("max-h-[72dvh]");
    expect(nav).toContain("overflow-y-auto");
    expect(topBar).toContain('"/rejected-setups": "Rejected Setups"');
  });

  it("keeps Bot Config actions and tabs usable without desktop width", () => {
    expect(config).toContain("aria-label=\"Export configuration\"");
    expect(config).toContain("aria-label=\"Import configuration\"");
    expect(config).toContain("min-h-11");
    expect(config).toContain("overscroll-contain");
    expect(config).toContain("safe-area-inset-bottom");
  });

  it("makes Rejected Setups controls and analysis tabs mobile accessible", () => {
    expect(rejected).toContain("grid-cols-2 sm:flex");
    expect(rejected).toContain("min-w-max justify-start");
    expect(rejected).toContain("overflow-x-auto");
  });
});
